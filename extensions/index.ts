/**
 * custom-multi-account-package — several logins per provider, account pools that switch to the next
 * account when one runs out, a manual account switch, plan usage.
 *
 * Logins:  /login offers "Anthropic (account 2)", "… (account 3)" … and "OpenAI Codex (account 2)" …
 *          next to Pi's own entries (account 1). Each account is its own provider
 *          (`anthropic-account-2`) with its own token and the family's models.
 * Pools:   every model belongs to a pool of accounts (by default all logins of its provider:
 *          subscriptions first, then API keys). You choose the account; when a request on it is
 *          refused for a limit, billing or login problem, the request is sent again on the next
 *          account of the pool and the session stays there (`/switch-account next`, automatically).
 *          /pool shows and edits the pools.
 * Switch:  /switch-account [account | number | name | email | next | prev | list]
 * Usage:   /usage — 5-hour and weekly plan usage of every logged-in account.
 * Names:   /label-account [<account> <name> [email]] — note who an account is.
 * Search:  the anthropic_web_search tool, on Anthropic API-key accounts only (pool "anthropic-search").
 * Agents:  other extensions (custom-pi-subagent-package) get an account per agent run through pi.events:
 *          "multiple-account:acquire" / "…:release" / "…:pool-of"; "…:switched" reports a change.
 *          Agents keep their last account, even when shared; failover follows pool order.
 * Config:  <Pi config dir>/multiple-account.json (names, families, pools — all optional)
 * State:   multiple-account-cooldowns.json, multiple-account-leases.json (shared by every Pi window)
 */
import type { Api, AssistantMessageEventStream, Model, Provider, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { type ExtensionAPI, type ExtensionContext, getAgentDir, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createAccountProvider } from "../src/accounts.ts";
import { type AccountNote, readSettings, type Settings, writeSettings } from "../src/config.ts";
import { CooldownTracker } from "../src/cooldown.ts";
import { type FamilyView, formatList } from "../src/format.ts";
import { isEmail, LABEL_USAGE, parseLabelArgs, resolveLabelAccount } from "../src/label.ts";
import { emptyLeases, HEARTBEAT_MS, LeaseBook, type LeaseState } from "../src/leases.ts";
import { type AccountState, chooseAccount, failoverOrder, stepAccount } from "../src/pick.ts";
import { applyPoolEdit, EDIT_COMMANDS, EDIT_USAGE, EditError, type EditEnv } from "../src/pool-edit.ts";
import { formatPoolStatus } from "../src/pool-status.ts";
import { completePools, type CredentialKind, type Logins, type PoolsResult, resolvePools, routeOf, SEARCH_FAMILY, SEARCH_TOOL } from "../src/pools.ts";
import { type Attempt, type Failure, routeRequest } from "../src/router.ts";
import { createSearchTool } from "../src/search/tool.ts";
import { accountsOf, familyOf, nextFreeAccount, parseAccount } from "../src/slots.ts";
import { cooldownStore, JsonFileStore } from "../src/state-file.ts";
import { type AccountInfo, accountInfos, describeAccount, noteText, resolveTarget } from "../src/switch.ts";
import { fetchUsage, formatUsage, type UsageGroup, type UsageReport } from "../src/usage.ts";

type Level = "info" | "warning" | "error";
type StreamMode = "stream" | "streamSimple";

const LOGIN_POLL_MS = 3000;
const PREFIX = "multiple-account";

/** pi.events channels shared with other extensions (custom-pi-subagent-package). */
export const EVENTS = {
	acquire: "multiple-account:acquire",
	release: "multiple-account:release",
	poolOf: "multiple-account:pool-of",
	switched: "multiple-account:switched",
} as const;

export default function multipleAccount(pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	const settingsPath = join(agentDir, "multiple-account.json");
	const builtins = new Map<string, Provider>(builtinProviders().map((p) => [p.id, p]));

	let settings: Settings;
	let settingsError: string | undefined;
	let families: string[] = [];
	/** "mtime:size" of the settings file when it was last read, to notice edits by other Pi processes. */
	let settingsStamp: string | undefined;
	const stampOf = (): string => {
		try {
			const s = statSync(settingsPath);
			return `${s.mtimeMs}:${s.size}`;
		} catch {
			return "missing";
		}
	};
	const loadSettings = () => {
		settingsStamp = stampOf();
		const loaded = readSettings(settingsPath);
		settings = loaded.settings;
		settingsError = loaded.error;
		families = settings.families.filter((f) => builtins.has(f));
	};
	loadSettings();
	/**
	 * Re-read the settings when another session (or an editor) changed the file since. Every Pi
	 * process keeps its own copy, so without this a change made in one session stayed invisible in
	 * the others until they restarted.
	 */
	const syncSettings = (): boolean => {
		if (stampOf() === settingsStamp) return false;
		loadSettings();
		return true;
	};

	let registry: ModelRegistry | undefined;
	/** Extra-account providers this extension registered: id → display name. */
	let registered = new Map<string, string>();
	let loggedIn = new Set<string>();
	let kinds = new Map<string, CredentialKind>();
	let pools: PoolsResult = { ok: true, value: { pools: new Map(), searchOff: false, fallbackCooldownMs: 5 * 60_000, maxCooldownMs: 60 * 60_000, warnings: [] } };
	let notify: ((message: string, level?: Level) => void) | undefined;
	let poll: ReturnType<typeof setInterval> | undefined;
	let heartbeat: ReturnType<typeof setInterval> | undefined;

	// ---- shared state: cooldowns and who uses which account -------------------------------------

	const cooldowns = new CooldownTracker({ store: cooldownStore(join(agentDir, "multiple-account-cooldowns.json")) });
	const leases = new LeaseBook({
		store: new JsonFileStore<LeaseState>(join(agentDir, "multiple-account-leases.json"), {
			version: 1,
			empty: emptyLeases,
			parse: (raw) =>
				raw.leases && typeof raw.leases === "object" && raw.last && typeof raw.last === "object"
					? { leases: raw.leases as LeaseState["leases"], last: raw.last as LeaseState["last"] }
					: undefined,
		}),
	});
	/** Lease keys (session ids) this process holds. */
	const mine = new Set<string>();
	/** Agent session id → owner key its last account is remembered under. */
	const agentOwners = new Map<string, string>();
	/**
	 * Session id → the account a request was moved to, until the session's model follows (main
	 * session) or the run ends (agents). Applies while the session still asks for `from`.
	 */
	const stickies = new Map<string, { from: string; to: string }>();
	let mainSessionId: string | undefined;
	/** A switch of the main session waiting to be recorded with pi.setModel at the end of the turn. */
	let pendingMain: { to: string } | undefined;

	const accountState = (modelKey: string, exceptKey?: string): AccountState => ({
		coolingUntil: (account) => cooldowns.get(account, modelKey)?.until,
		users: (account) => leases.users(account, exceptKey),
		usable: (account) => loggedIn.has(account),
	});

	// ---- who is logged in ----------------------------------------------------------------------

	/** Stored credentials: provider id → kind. Reads key names and the `type` field only, never secrets. */
	const storedKinds = (): Map<string, CredentialKind> => {
		try {
			const raw = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8").replace(/^\uFEFF/, ""));
			const out = new Map<string, CredentialKind>();
			if (raw && typeof raw === "object") {
				for (const [id, value] of Object.entries(raw)) out.set(id, (value as { type?: unknown })?.type === "oauth" ? "oauth" : "api_key");
			}
			return out;
		} catch {
			return new Map();
		}
	};

	/** Logged-in accounts of every family. Pi's registry also sees environment-variable logins. */
	const computeLoggedIn = (stored: Map<string, CredentialKind>): Set<string> => {
		const out = new Set<string>();
		for (const id of new Set([...families, ...stored.keys(), ...registered.keys()])) {
			if (!parseAccount(id, families)) continue;
			let configured = stored.has(id);
			if (registry) {
				try {
					configured = registry.getProviderAuthStatus(id).configured;
				} catch {
					// not registered yet: keep the stored-credential answer
				}
			}
			if (configured) out.add(id);
		}
		return out;
	};

	const logins = (): Logins => ({ ids: [...loggedIn], kinds });
	const info = (id: string): AccountInfo => accountInfos([id], families, settings.accounts)[0] ?? { id, family: id, n: 1 };
	const describe = (id: string) => describeAccount(info(id));

	/** Accounts to keep registered for `family` (logged in or named) plus the next free one. */
	const familySlots = (family: string) => {
		const known = accountsOf(family, [...loggedIn, ...Object.keys(settings.accounts)], families);
		return { known, spare: nextFreeAccount(family, known, families) };
	};

	/** How an account appears in /login: "Anthropic (account 2 · Work · me@company.com)". */
	const loginName = (id: string): string => {
		const parsed = parseAccount(id, families)!;
		const provider = builtins.get(parsed.family)?.name ?? parsed.family;
		if (parsed.n === 1) return provider; // Pi's own entry
		const note = noteText(settings.accounts[id] ?? {});
		return `${provider} (account ${parsed.n}${note ? ` \u00b7 ${note}` : ""})`;
	};

	// ---- requests through the pools --------------------------------------------------------------

	/** Report a request that moved from `start` to `account`, and make the session follow. */
	const switched = (sessionId: string | undefined, requested: string, start: string, account: string, modelId: string, failures: readonly Failure[]) => {
		const reason = failures.find((f) => f.account === start)?.reason ?? cooldowns.get(start, modelId)?.reason ?? "unavailable";
		if (sessionId) stickies.set(sessionId, { from: requested, to: account });
		const billed = kinds.get(account) === "api_key" ? " \u00b7 API key, billed per token" : "";
		const text = `${PREFIX}: ${describe(start)} \u2192 ${describe(account)} (${reason})${billed}`;
		const lease = sessionId ? leases.get(sessionId) : undefined;
		if (sessionId && sessionId === mainSessionId) {
			pendingMain = { to: account };
			holdMain(account);
			notify?.(`${text}. This session now uses ${account}.`, "warning");
		} else if (sessionId && lease?.kind === "agent" && mine.has(sessionId)) {
			leases.hold(sessionId, { account, kind: "agent", label: lease.label, pid: process.pid });
			pi.events.emit(EVENTS.switched, { sessionId, from: start, to: account, reason, model: `${account}/${modelId}` });
		} else {
			notify?.(`${text} for one request`, "info");
		}
	};

	/** The request step of every account provider: route through the model's pool. */
	const routed =
		(mode: StreamMode) =>
		(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream => {
			const requested = model.provider;
			const family = familyOf(requested, families) ?? requested;
			const impl = builtins.get(family)!;
			const call = (m: Model<Api>, o: SimpleStreamOptions | undefined) =>
				mode === "stream" ? impl.stream(m as never, context, o as never) : impl.streamSimple(m as never, context, o);
			const reg = registry;
			const resolved = pools.ok ? pools.value : undefined;
			const pool = resolved && reg ? routeOf(resolved, family, model.id) : undefined;
			if (!pool || !reg || !resolved) return call(model, options);

			const sessionId = options?.sessionId;
			let sticky = sessionId ? stickies.get(sessionId) : undefined;
			if (sticky && sticky.from !== requested) {
				stickies.delete(sessionId!);
				sticky = undefined;
			}
			const start = sticky?.to ?? requested;
			const order = failoverOrder(pool.members, start, accountState(model.id, sessionId));

			const open = async (account: string): Promise<Attempt | undefined> => {
				const response: Attempt["response"] = {};
				const onResponse = async (res: { status: number; headers: Record<string, string> }, m: Model<Api>) => {
					response.status = res.status;
					response.headers = res.headers;
					await options?.onResponse?.(res, m);
				};
				// Pi already resolved the requested account's login for this request.
				if (account === requested) return { stream: call(model, { ...options, onResponse }), response };
				const found = await reg.getProviderAuth(account);
				if (!found?.auth.apiKey && !found?.auth.headers) return undefined;
				const { auth, env } = found;
				const target = reg.find(account, model.id);
				const requestModel = { ...model, provider: account, baseUrl: auth.baseUrl ?? target?.baseUrl ?? model.baseUrl };
				// Drop the requested account's credentials; only this account's apply.
				const inherited = Object.fromEntries(Object.entries(options?.headers ?? {}).filter(([name]) => !/^(authorization|x-api-key)$/i.test(name)));
				const headers = { ...inherited, ...auth.headers };
				return {
					stream: call(requestModel, {
						...options,
						apiKey: auth.apiKey,
						headers: Object.keys(headers).length > 0 ? headers : undefined,
						env: env || options?.env ? { ...options?.env, ...env } : undefined,
						onResponse,
					}),
					response,
				};
			};

			return routeRequest(
				{ cooldowns, policy: resolved, open },
				{
					pool: pool.name,
					modelKey: model.id,
					order,
					onCommit: (account, failures) => {
						if (account !== start) switched(sessionId, requested, start, account, model.id, failures);
					},
				},
				model,
				options?.signal,
			);
		};

	// ---- registration --------------------------------------------------------------------------

	const resolveAllPools = () => {
		pools = resolvePools(settings.pools, logins(), families);
	};

	/** Register every known extra account plus one free one per family, so /login offers it. */
	const apply = () => {
		kinds = storedKinds();
		loggedIn = computeLoggedIn(kinds);
		resolveAllPools();
		const wanted = new Map<string, string>();
		for (const family of families) {
			const { known, spare } = familySlots(family);
			for (const id of [...known, ...(spare ? [spare] : [])]) {
				if (id !== family) wanted.set(id, loginName(id)); // account 1 is Pi's own provider
			}
		}
		for (const [id, name] of wanted) {
			if (registered.get(id) === name) continue;
			const family = parseAccount(id, families)!.family;
			pi.registerProvider(
				createAccountProvider(id, name, builtins.get(family)!, {
					stream: routed("stream") as never,
					streamSimple: routed("streamSimple"),
				}),
			);
		}
		for (const id of registered.keys()) if (!wanted.has(id)) pi.unregisterProvider(id);
		registered = wanted;
	};

	/** Account 1 is Pi's own provider: route its requests too (models and login stay Pi's). */
	for (const family of families) {
		const api = builtins.get(family)?.getModels()[0]?.api;
		if (api) pi.registerProvider(family, { api, streamSimple: routed("streamSimple") });
	}

	/** Re-apply when the logins or the settings changed (Pi has no login event). */
	const refresh = () => {
		const settingsChanged = syncSettings(); // names, pools set by another session
		const before = loggedIn;
		const now = computeLoggedIn(storedKinds());
		const loginsChanged = !(now.size === before.size && [...now].every((id) => before.has(id)));
		if (!loginsChanged && !settingsChanged) return;
		apply(); // also renames the /login entries and re-reads the pools
		if (!loginsChanged) return;
		for (const id of loggedIn) {
			if (before.has(id)) continue;
			const where = pools.ok ? [...pools.value.pools.values()].filter((p) => p.members.some((m) => m.account === id)).map((p) => `"${p.name}"`) : [];
			notify?.(
				`${PREFIX}: ${describe(id)} logged in${kinds.get(id) === "api_key" ? " (API key)" : ""}${where.length > 0 ? `, joined pool ${where.join(", ")}` : ""}. Name it with /label-account ${id} <name> [email]; use it with /switch-account ${id}`,
				"info",
			);
		}
		for (const id of before) if (!loggedIn.has(id)) notify?.(`${PREFIX}: ${id} logged out`, "warning");
	};

	apply();

	// ---- the main session's account --------------------------------------------------------------

	const holdMain = (provider: string | undefined) => {
		if (!mainSessionId) return;
		if (provider && familyOf(provider, families)) {
			leases.hold(mainSessionId, { account: provider, kind: "main", label: "main session", pid: process.pid });
			mine.add(mainSessionId);
		} else {
			leases.release(mainSessionId);
			mine.delete(mainSessionId);
		}
	};

	/** Record an automatic switch in the session (like /switch-account next), once the turn is done. */
	const applyPending = async (ctx: ExtensionContext) => {
		const pending = pendingMain;
		pendingMain = undefined;
		const model = ctx.model;
		if (!pending || !model || model.provider === pending.to) return;
		if (familyOf(model.provider, families) !== familyOf(pending.to, families)) return; // provider changed meanwhile
		const next = ctx.modelRegistry.find(pending.to, model.id);
		if (!next) return;
		const level = pi.getThinkingLevel();
		if (await pi.setModel(next)) pi.setThinkingLevel(level);
	};

	/**
	 * The search tool is offered to the model only when it can work: turned on and with at least one
	 * logged-in account in its pool. Decided before every run (Pi restores a session's tool set when
	 * it is reopened, so a decision made once would stick); turn it off for good with
	 * /pool tool anthropic_web_search off.
	 */
	const searchWanted = () => {
		const search = pools.ok ? pools.value.search : undefined;
		return families.includes(SEARCH_FAMILY) && !!search && search.pool.members.some((m) => loggedIn.has(m.account));
	};
	pi.on("before_agent_start", (event) => {
		if (!families.includes(SEARCH_FAMILY)) return;
		const selected = event.systemPromptOptions.selectedTools;
		const has = selected.includes(SEARCH_TOOL);
		if (searchWanted() && !has) selected.push(SEARCH_TOOL);
		if (!searchWanted() && has) selected.splice(selected.indexOf(SEARCH_TOOL), 1);
	});

	pi.on("session_start", (_event, ctx) => {
		registry = ctx.modelRegistry;
		notify = (message, level = "info") => {
			try {
				if (ctx.hasUI) ctx.ui.notify(message, level);
				else console.error(message); // pi -p: still say when the account changed
			} catch {
				// UI gone
			}
		};
		apply(); // the registry also knows environment-variable logins
		mainSessionId = ctx.sessionManager.getSessionId();
		holdMain(ctx.model?.provider);

		const warnings: string[] = [];
		if (settingsError) warnings.push(`${settingsError} (using defaults)`);
		if (!pools.ok) warnings.push(`pools in ${settingsPath} are not valid, requests are not switched: ${pools.errors.join("; ")}`);
		const unknown = settings.families.filter((f) => !builtins.has(f));
		if (unknown.length > 0) warnings.push(`unknown provider(s) in "families": ${unknown.join(", ")}`);
		if (pi.getCommands().some((c) => c.name === "multi-account")) {
			warnings.push("pi-multi-account is also installed and registers the same anthropic-account-N providers; keep only one of the two packages");
		}
		if (ctx.modelRegistry.getProvider("anthropic-2")) {
			warnings.push("pi-account-pools is also installed (it has its own logins and /pool); keep only one of the two packages");
		}
		const provider = ctx.model?.provider;
		if (provider && familyOf(provider, families) && !loggedIn.has(provider)) {
			warnings.push(`this session uses ${provider}, which is not logged in: /switch-account to another account, or /login`);
		}
		if (warnings.length > 0) notify(`${PREFIX}: ${warnings.join("; ")}`, "warning");

		if (!poll) {
			poll = setInterval(refresh, LOGIN_POLL_MS);
			poll.unref?.();
		}
		if (!heartbeat) {
			heartbeat = setInterval(() => leases.touch([...mine]), HEARTBEAT_MS);
			heartbeat.unref?.();
		}
	});
	pi.on("model_select", (event) => {
		if (mainSessionId) stickies.delete(mainSessionId);
		holdMain(event.model.provider);
	});
	// Record an automatic switch once the run is over; until then the request step keeps using the
	// new account (a model change in the middle of a run is avoided on purpose).
	pi.on("agent_end", async (_event, ctx) => {
		await applyPending(ctx);
	});
	pi.on("input", () => {
		refresh();
		return undefined;
	});
	pi.on("session_shutdown", () => {
		if (poll) clearInterval(poll);
		if (heartbeat) clearInterval(heartbeat);
		poll = heartbeat = undefined;
		for (const key of mine) leases.release(key, agentOwners.get(key));
		mine.clear();
	});

	// ---- accounts for agents (custom-pi-subagent-package) -----------------------------------------------

	const splitRef = (ref: unknown): { provider: string; modelId: string } | undefined => {
		if (typeof ref !== "string") return undefined;
		const i = ref.indexOf("/");
		return i > 0 ? { provider: ref.slice(0, i), modelId: ref.slice(i + 1) } : undefined;
	};

	/** Pool of a `provider/model` ref: the family form of the model and the pool's name. */
	const poolOf = (ref: unknown) => {
		const parts = splitRef(ref);
		const family = parts ? familyOf(parts.provider, families) : undefined;
		if (!parts || !family) return { pooled: false as const };
		const pool = pools.ok ? routeOf(pools.value, family, parts.modelId) : undefined;
		return pool
			? { pooled: true as const, family, pool: pool.name, model: `${family}/${parts.modelId}`, accounts: pool.members.map((m) => m.account) }
			: { pooled: false as const, family };
	};

	type AcquireRequest = { model?: unknown; sessionId?: unknown; owner?: unknown; label?: unknown; reply?: (result: unknown) => void };
	const acquire = (req: AcquireRequest) => {
		refresh();
		const parts = splitRef(req.model);
		const where = poolOf(req.model);
		if (!parts || !where.pooled || typeof req.sessionId !== "string") return where;
		const sessionId = req.sessionId;
		const owner = typeof req.owner === "string" ? req.owner : sessionId;
		const pool = pools.ok ? pools.value.pools.get(where.pool) : undefined;
		stickies.delete(sessionId);
		const choice = pool && chooseAccount(pool.members, leases.last(owner), accountState(parts.modelId, sessionId));
		if (!choice) return { ...where, error: `pool "${where.pool}" has no logged-in account; log one in with /login or add one with /pool add ${where.pool} <account>` };
		leases.hold(sessionId, { account: choice.account, kind: "agent", label: typeof req.label === "string" ? req.label : "agent", pid: process.pid });
		mine.add(sessionId);
		agentOwners.set(sessionId, owner);
		return { ...where, account: choice.account, model: `${choice.account}/${parts.modelId}`, reason: choice.reason, apiKey: kinds.get(choice.account) === "api_key" };
	};

	pi.events.on(EVENTS.acquire, (data) => {
		const req = data as AcquireRequest;
		if (typeof req?.reply !== "function") return;
		try {
			req.reply(acquire(req));
		} catch (error) {
			req.reply({ pooled: false, error: errorText(error) });
		}
	});
	pi.events.on(EVENTS.release, (data) => {
		const sessionId = (data as { sessionId?: unknown })?.sessionId;
		if (typeof sessionId !== "string") return;
		leases.release(sessionId, agentOwners.get(sessionId));
		mine.delete(sessionId);
		agentOwners.delete(sessionId);
		stickies.delete(sessionId);
	});
	pi.events.on(EVENTS.poolOf, (data) => {
		const req = data as { model?: unknown; reply?: (result: unknown) => void };
		if (typeof req?.reply === "function") req.reply(poolOf(req.model));
	});

	// ---- the search tool -------------------------------------------------------------------------

	if (families.includes(SEARCH_FAMILY)) {
		pi.registerTool(
			createSearchTool({
				pools: () => (pools.ok ? { pools: pools.value } : { reason: `the pools in ${settingsPath} are not valid: ${pools.errors.join("; ")}` }),
				cooldowns,
				order: (poolName, model) => {
					const pool = pools.ok ? pools.value.pools.get(poolName) : undefined;
					const first = pool?.members[0]?.account;
					return pool && first ? failoverOrder(pool.members, first, accountState(model)) : [];
				},
			}),
		);
	}

	// ---- shared helpers ------------------------------------------------------------------------

	/** Show in the TUI, or print when there is no UI (`pi -p "/usage"`). */
	const say = (ctx: ExtensionContext, message: string, level: Level = "info") => {
		if (ctx.hasUI) ctx.ui.notify(message, level);
		else (level === "error" ? console.error : console.log)(message);
	};

	const loggedInOf = (family: string): AccountInfo[] => accountInfos(accountsOf(family, loggedIn, families), families, settings.accounts);

	/** Logged-in and named accounts of every family, account 1 first. */
	const knownAccounts = (): AccountInfo[] =>
		accountInfos([...new Set([...loggedIn, ...Object.keys(settings.accounts)])], families, settings.accounts);

	const listText = (ctx: ExtensionContext): string => {
		const views: FamilyView[] = families.map((family) => {
			const { spare } = familySlots(family);
			return {
				family,
				name: builtins.get(family)?.name ?? family,
				loggedIn: loggedInOf(family),
				...(spare ? { nextLogin: loginName(spare) } : {}),
			};
		});
		return formatList(views, ctx.model?.provider);
	};

	const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

	// ---- names and emails ----------------------------------------------------------------------

	/** Change an account's note; `null` clears a field. Returns the confirmation. */
	const setNote = (id: string, change: { name?: string | null; email?: string | null }): string => {
		loadSettings(); // pick up edits made outside this process
		if (settingsError) throw new Error(`fix ${settingsPath} first: ${settingsError}`);
		const note: AccountNote = { ...settings.accounts[id] };
		if (change.name !== undefined) {
			if (change.name) note.name = change.name;
			else delete note.name;
		}
		if (change.email !== undefined) {
			if (change.email) note.email = change.email;
			else delete note.email;
		}
		if (note.name || note.email) settings.accounts[id] = note;
		else delete settings.accounts[id];
		writeSettings(settingsPath, settings);
		settingsStamp = stampOf(); // our own write is not an outside change
		apply(); // renames the /login entry
		const now = noteText(note);
		return now ? `${PREFIX}: ${id} is now "${now}"` : `${PREFIX}: name and email of ${id} cleared`;
	};

	/** Interactive /label-account: pick an account, then type its name and email. */
	const labelInteractively = async (ctx: ExtensionContext): Promise<void> => {
		const accounts = knownAccounts();
		if (accounts.length === 0) {
			say(ctx, `${PREFIX}: no account is logged in yet; log in with /login first`, "warning");
			return;
		}
		const options = accounts.map((a) => describeAccount(a));
		const choice = await ctx.ui.select("Name which account?", options);
		if (!choice) return;
		const account = accounts[options.indexOf(choice)]!;
		const name = await ctx.ui.input(`Name for ${account.id}  (empty = keep, "-" = clear)`, account.name ?? "e.g. Work");
		if (name === undefined) return;
		let email: string | undefined;
		for (;;) {
			email = await ctx.ui.input(`Email for ${account.id}  (empty = keep, "-" = clear)`, account.email ?? "e.g. me@company.com");
			if (email === undefined) return;
			const typed = email.trim();
			if (!typed || typed === "-" || isEmail(typed)) break;
			say(ctx, `${PREFIX}: "${typed}" is not an email address`, "warning");
		}
		const field = (typed: string) => (typed.trim() === "-" ? null : typed.trim() || undefined);
		say(ctx, setNote(account.id, { name: field(name), email: field(email) }));
	};

	const label = async (ctx: ExtensionContext, argv: string[]): Promise<void> => {
		if (argv.length === 0) {
			if (ctx.hasUI) await labelInteractively(ctx);
			else say(ctx, `${listText(ctx)}\n\nName an account:\n${LABEL_USAGE}`);
			return;
		}
		const parsed = parseLabelArgs(argv);
		if (parsed.kind === "error") {
			say(ctx, `${PREFIX}: ${parsed.error}`, "warning");
			return;
		}
		const target = resolveLabelAccount(parsed.account, knownAccounts(), families, familyOf(ctx.model?.provider, families));
		if (!target.ok) {
			say(ctx, `${PREFIX}: ${target.error}`, "warning");
			return;
		}
		if (parsed.kind === "show") {
			const note = noteText(settings.accounts[target.id] ?? {});
			say(ctx, `${PREFIX}: ${target.id} ${note ? `is "${note}"` : "has no name or email yet"}\n${LABEL_USAGE}`);
			return;
		}
		if (parsed.kind === "clear") {
			say(ctx, setNote(target.id, { name: null, email: null }));
			return;
		}
		say(ctx, setNote(target.id, { ...(parsed.name ? { name: parsed.name } : {}), ...(parsed.email ? { email: parsed.email } : {}) }));
	};

	// ---- /usage --------------------------------------------------------------------------------

	const usageOf = async (ctx: ExtensionContext, family: string, account: AccountInfo): Promise<UsageReport> => {
		let token: string | undefined;
		let baseUrl: string | undefined;
		try {
			// Pi renews an expired token here, as for a normal request.
			const resolved = await ctx.modelRegistry.getProviderAuth(account.id);
			token = resolved?.auth.apiKey;
			baseUrl = resolved?.auth.baseUrl ?? ctx.modelRegistry.getProvider(account.id)?.baseUrl;
		} catch (error) {
			return { status: "error", error: `could not renew the login (${errorText(error)})`, relogin: true };
		}
		if (!token) return { status: "error", error: "not logged in", relogin: true };
		return fetchUsage(fetch, { family, token, ...(baseUrl ? { baseUrl } : {}) });
	};

	const usageText = async (ctx: ExtensionContext): Promise<string> => {
		const groups: UsageGroup[] = await Promise.all(
			families.map(async (family) => ({
				name: builtins.get(family)?.name ?? family,
				rows: await Promise.all(
					loggedInOf(family).map(async (account) => ({
						id: account.id,
						note: noteText(account),
						report: await usageOf(ctx, family, account),
						loginEntry: loginName(account.id),
					})),
				),
			})),
		);
		return formatUsage(groups, ctx.model?.provider);
	};

	// ---- /switch-account -----------------------------------------------------------------------

	const switchTo = async (ctx: ExtensionContext, arg: string): Promise<void> => {
		const model = ctx.model;
		if (!model) {
			say(ctx, `${PREFIX}: no model is selected; pick one with /model first`, "warning");
			return;
		}
		const family = familyOf(model.provider, families);
		if (!family) {
			say(ctx, `${PREFIX}: the current model ${model.provider}/${model.id} is not from ${families.join(" or ")}; nothing to switch`, "warning");
			return;
		}
		const accounts = loggedInOf(family);
		const current = accounts.find((a) => a.id === model.provider) ?? info(model.provider);
		const providerName = builtins.get(family)?.name ?? family;
		const nextLogin = familySlots(family).spare;
		const addHint = nextLogin ? ` Add one with /login \u2192 "${loginName(nextLogin)}".` : "";

		let target: AccountInfo | undefined;
		const pool = pools.ok ? routeOf(pools.value, family, model.id) : undefined;
		if (!arg) {
			if (!ctx.hasUI) {
				say(ctx, listText(ctx));
				return;
			}
			if (accounts.length < 2 && accounts.some((a) => a.id === model.provider)) {
				say(ctx, `${PREFIX}: only one ${providerName} account is logged in (${describeAccount(current)}).${addHint}`, "warning");
				return;
			}
			const options = accounts.map((a) => `${a.id === model.provider ? "\u25cf" : " "} ${describeAccount(a)}`);
			const choice = await ctx.ui.select(`Switch ${providerName} account (now: ${describeAccount(current)})`, options);
			if (!choice) return;
			target = accounts[options.indexOf(choice)];
		} else if ((arg === "next" || arg === "prev") && pool) {
			// Inside the model's pool, by priority; accounts cooling down are skipped while others are ready.
			const step = stepAccount(pool.members, model.provider, arg === "next" ? 1 : -1, accountState(model.id, mainSessionId));
			if (!step) {
				say(ctx, `${PREFIX}: pool "${pool.name}" has no other logged-in account (/pool to see it).${addHint}`, "warning");
				return;
			}
			target = info(step);
		} else {
			const other = parseAccount(arg, families);
			if (other && other.family !== family) {
				say(ctx, `${PREFIX}: ${arg} is a ${other.family} account, but this session uses ${family}. Change provider with /model.`, "warning");
				return;
			}
			const resolved = resolveTarget(arg, accounts, model.provider);
			if (!resolved.ok) {
				say(ctx, `${PREFIX}: ${resolved.error}.${addHint}`, "warning");
				return;
			}
			target = resolved.account;
		}
		if (!target) return;
		if (target.id === model.provider) {
			say(ctx, `${PREFIX}: already using ${describeAccount(target)}`);
			return;
		}
		if (!ctx.isIdle()) {
			say(ctx, `${PREFIX}: Pi is still working on a turn; switch when it has finished (or press Esc first)`, "warning");
			return;
		}
		const next = ctx.modelRegistry.find(target.id, model.id);
		if (!next) {
			say(ctx, `${PREFIX}: ${describeAccount(target)} has no model "${model.id}"; pick one with /model`, "error");
			return;
		}
		// Keep the session's reasoning level: a model change may otherwise apply the model's default.
		const level = pi.getThinkingLevel();
		if (!(await pi.setModel(next))) {
			say(ctx, `${PREFIX}: ${describeAccount(target)} has no usable login; run /login and pick "${loginName(target.id)}"`, "error");
			return;
		}
		pi.setThinkingLevel(level);
		const cooling = cooldowns.get(target.id, model.id);
		const extra = [
			kinds.get(target.id) === "api_key" ? "API key, billed per token" : "",
			cooling ? `note: it is cooling down (${cooling.reason}); requests go to the next account until then` : "",
		].filter(Boolean);
		say(ctx, `${PREFIX}: switched ${describeAccount(current)} \u2192 ${describeAccount(target)} \u00b7 ${model.id}${level !== "off" ? ` \u00b7 thinking ${level}` : ""}${extra.length ? ` (${extra.join("; ")})` : ""}`);
	};

	// ---- /pool ---------------------------------------------------------------------------------

	const autoPools = (): EditEnv["autoPools"] => {
		const out: Record<string, { isDefault: boolean; members: { account: string; priority: number }[] }> = {};
		if (pools.ok) for (const p of pools.value.pools.values()) if (p.automatic) out[p.name] = { isDefault: p.isDefault, members: p.members };
		return out;
	};
	const modelIds = (family: string) => builtins.get(family)?.getModels().map((m) => m.id) ?? [];
	const editEnv = (): EditEnv => ({
		families,
		loggedIn,
		kinds,
		autoPools: autoPools(),
		complete: (raw) => completePools(raw, logins(), families),
		modelIds,
	});

	/** Run one edit subcommand and save; returns the confirmation, throws EditError when refused. */
	const edit = (argv: string[]): string => {
		loadSettings();
		if (settingsError) throw new EditError(`fix ${settingsPath} first: ${settingsError}`);
		const result = applyPoolEdit(settings.pools, argv, editEnv());
		settings.pools = result.raw;
		writeSettings(settingsPath, settings);
		settingsStamp = stampOf();
		apply();
		const notes = [`${PREFIX}: ${result.message}`];
		if (pools.ok && pools.value.warnings.length > 0) notes.push(`note: ${pools.value.warnings.join("; ")}`);
		return notes.join("\n");
	};

	const statusText = (ctx: ExtensionContext) =>
		formatPoolStatus({
			result: pools,
			settingsPath,
			providerName: (family) => builtins.get(family)?.name ?? family,
			describe,
			loggedIn,
			kinds,
			cooldowns: cooldowns.list(),
			holders: leases.holders(),
			...(mainSessionId ? { mainKey: mainSessionId } : {}),
			pid: process.pid,
		}) + (ctx.model && familyOf(ctx.model.provider, families) && pools.ok
			? (() => {
					const pool = routeOf(pools.value, familyOf(ctx.model!.provider, families)!, ctx.model!.id);
					return pool ? `\nThis session: ${describe(ctx.model!.provider)} \u00b7 ${ctx.model!.id} \u2192 pool "${pool.name}"` : "";
				})()
			: "");

	const poolHelp = () =>
		[
			"/pool                  pools, their accounts, cooldowns and who uses which account",
			"/pool clear [account]  forget cooldowns (all, or of one account)",
			"",
			"Edit (validated, then saved to multiple-account.json):",
			...Object.values(EDIT_USAGE).map((u) => `/pool ${u}`),
			"",
			"An automatic pool follows your logins until you edit it; /pool delete <provider> makes it automatic again.",
			"Accounts: anthropic, anthropic-account-2, … (see /switch-account list). Lower priority = used first.",
		].join("\n");

	const poolCompletions = (prefix: string) => {
		const tokens = prefix.split(/\s+/);
		const typing = tokens.pop() ?? "";
		const done = tokens.filter(Boolean);
		const base = done.length > 0 ? `${done.join(" ")} ` : "";
		const [sub, a1] = done;
		const at = done.length;
		const resolved = pools.ok ? pools.value : undefined;
		const poolNames = [...(resolved?.pools.keys() ?? [])];
		const poolFamily = (name: string | undefined) => (name ? resolved?.pools.get(name)?.family : undefined);
		const members = (name: string | undefined) => (name ? (resolved?.pools.get(name)?.members.map((m) => m.account) ?? []) : []);
		const accountsFor = (family: string | undefined) => [...loggedIn].filter((id) => !family || familyOf(id, families) === family).sort();
		let candidates: string[] = [];
		if (at === 0) candidates = ["status", "help", "clear", ...EDIT_COMMANDS];
		else if (["delete", "models", "default"].includes(sub!) && at === 1) candidates = poolNames;
		else if (sub === "default" && at === 2) candidates = ["on", "off"];
		else if (sub === "models" && at === 2) candidates = [...modelIds(poolFamily(a1) ?? ""), "none"];
		else if (sub === "add") candidates = at === 1 ? poolNames : at === 2 ? accountsFor(poolFamily(a1)).filter((id) => !members(a1).includes(id)) : [];
		else if (sub === "remove" || sub === "priority") candidates = at === 1 ? poolNames : at === 2 ? members(a1) : [];
		else if (sub === "new" && at >= 2) candidates = [...accountsFor(undefined), "--models", "--default"];
		else if (sub === "tool") candidates = at === 1 ? [SEARCH_TOOL] : at === 2 ? ["on", "off", ...poolNames] : at === 3 ? modelIds(SEARCH_FAMILY) : [];
		else if (sub === "clear" && at === 1) candidates = accountsFor(undefined);
		const items = [...new Set(candidates)].filter((c) => c.startsWith(typing)).map((c) => ({ value: base + c, label: c }));
		return items.length > 0 ? items.slice(0, 60) : null;
	};

	// ---- commands ------------------------------------------------------------------------------

	const complete = (prefix: string, first: string[], next: (done: string[]) => string[]) => {
		const tokens = prefix.split(/\s+/);
		const typing = tokens.pop() ?? "";
		const done = tokens.filter(Boolean);
		const base = done.length > 0 ? `${done.join(" ")} ` : "";
		const candidates = done.length === 0 ? first : next(done);
		const items = [...new Set(candidates)].filter((c) => c.startsWith(typing)).map((c) => ({ value: base + c, label: c }));
		return items.length > 0 ? items.slice(0, 60) : null;
	};
	const noteWords = () => Object.values(settings.accounts).flatMap((n) => [n.name, n.email].filter((v): v is string => !!v));

	/** Common start of every command: current registry, fresh login list. */
	const begin = (ctx: ExtensionContext) => {
		registry = ctx.modelRegistry;
		refresh();
	};

	pi.registerCommand("switch-account", {
		description: "Move this session to another logged-in account: /switch-account [account|number|name|email|next|prev|list]",
		getArgumentCompletions: (prefix) => complete(prefix, ["list", "next", "prev", ...[...loggedIn].sort(), ...noteWords()], () => []),
		handler: async (args, ctx) => {
			begin(ctx);
			const argv = args.trim().split(/\s+/).filter(Boolean);
			try {
				if (argv[0] === "list") say(ctx, listText(ctx));
				else if (argv[0] === "label") await label(ctx, argv.slice(1)); // 0.1 syntax, kept
				else await switchTo(ctx, argv.join(" "));
			} catch (error) {
				say(ctx, `${PREFIX}: ${errorText(error)}`, "error");
			}
		},
	});

	pi.registerCommand("label-account", {
		description: "Note an account's name and email: /label-account [<account> <name> [email] | <account> clear]",
		getArgumentCompletions: (prefix) =>
			complete(prefix, [...knownAccounts().map((a) => a.id), ...registered.keys()], (done) => (done.length === 1 ? ["name", "email", "clear"] : [])),
		handler: async (args, ctx) => {
			begin(ctx);
			try {
				await label(ctx, args.trim().split(/\s+/).filter(Boolean));
			} catch (error) {
				say(ctx, `${PREFIX}: ${errorText(error)}`, "error");
			}
		},
	});

	pi.registerCommand("usage", {
		description: "Plan usage (5-hour and weekly) of every logged-in account",
		handler: async (_args, ctx) => {
			begin(ctx);
			try {
				if (ctx.hasUI) ctx.ui.notify(`${PREFIX}: checking usage of ${[...loggedIn].length} account(s)\u2026`, "info");
				say(ctx, await usageText(ctx));
			} catch (error) {
				say(ctx, `${PREFIX}: ${errorText(error)}`, "error");
			}
		},
	});

	pi.registerCommand("pool", {
		description: "Account pools: status | add | remove | priority | new | models | default | delete | tool | clear (/pool help)",
		getArgumentCompletions: poolCompletions,
		handler: async (args, ctx) => {
			begin(ctx);
			const argv = args.trim().split(/\s+/).filter(Boolean);
			const [sub = "status", arg] = argv;
			try {
				if (sub === "status") say(ctx, statusText(ctx));
				else if (sub === "help") say(ctx, poolHelp());
				else if (sub === "clear") {
					const n = cooldowns.clear(arg);
					say(ctx, `${PREFIX}: cleared ${n} cooldown(s)${arg ? ` of ${arg}` : ""}`);
				} else if (EDIT_COMMANDS.includes(sub)) say(ctx, edit(argv));
				else say(ctx, `${PREFIX}: unknown subcommand "${sub}"\n\n${poolHelp()}`, "warning");
			} catch (error) {
				say(ctx, `${PREFIX}: ${errorText(error)}`, error instanceof EditError ? "warning" : "error");
			}
		},
	});
}
