/**
 * pi-multiple-account-package — several logins per provider, a manual account switch, plan usage.
 *
 * Logins:  /login offers "Anthropic (account 2)", "… (account 3)" … and "OpenAI Codex (account 2)" …
 *          next to Pi's own entries (account 1). Each account is its own provider
 *          (`anthropic-account-2`) with its own token and the family's models.
 * Switch:  /switch-account [account | number | name | email | next | prev | list]
 *          moves this session to the same model on another logged-in account of the same provider.
 * Usage:   /usage — 5-hour and weekly plan usage of every logged-in account.
 * Names:   /label-account [<account> <name> [email]] — note who an account is.
 * Config:  <Pi config dir>/multiple-account.json (optional: account names/emails, families)
 *
 * Nothing switches automatically: there is no failover or rotation in this package.
 */
import type { Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { type ExtensionAPI, type ExtensionContext, getAgentDir, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createAccountProvider } from "../src/accounts.ts";
import { type AccountNote, readSettings, type Settings, writeSettings } from "../src/config.ts";
import { type FamilyView, formatList } from "../src/format.ts";
import { isEmail, LABEL_USAGE, parseLabelArgs, resolveLabelAccount } from "../src/label.ts";
import { accountsOf, familyOf, nextFreeAccount, parseAccount } from "../src/slots.ts";
import { type AccountInfo, accountInfos, describeAccount, noteText, resolveTarget } from "../src/switch.ts";
import { fetchUsage, formatUsage, type UsageGroup, type UsageReport } from "../src/usage.ts";

type Level = "info" | "warning" | "error";

const LOGIN_POLL_MS = 3000;
const PREFIX = "multiple-account";

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
	 * process keeps its own copy, so without this a name set in one session stayed invisible in the
	 * others until they restarted.
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
	let notify: ((message: string, level?: Level) => void) | undefined;
	let poll: ReturnType<typeof setInterval> | undefined;

	// ---- who is logged in ----------------------------------------------------------------------

	/** Provider ids with a stored credential. Reads key names only, never the secrets. */
	const storedIds = (): Set<string> => {
		try {
			const raw = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8").replace(/^\uFEFF/, ""));
			return new Set(raw && typeof raw === "object" ? Object.keys(raw) : []);
		} catch {
			return new Set();
		}
	};

	/** Logged-in accounts of every family. Pi's registry also sees environment-variable logins. */
	const computeLoggedIn = (): Set<string> => {
		const stored = storedIds();
		const out = new Set<string>();
		for (const id of new Set([...families, ...stored, ...registered.keys()])) {
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

	const info = (id: string): AccountInfo => accountInfos([id], families, settings.accounts)[0] ?? { id, family: id, n: 1 };

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

	// ---- registration --------------------------------------------------------------------------

	/** Register every known extra account plus one free one per family, so /login offers it. */
	const apply = () => {
		loggedIn = computeLoggedIn();
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
			pi.registerProvider(createAccountProvider(id, name, builtins.get(family)!));
		}
		for (const id of registered.keys()) if (!wanted.has(id)) pi.unregisterProvider(id);
		registered = wanted;
	};

	/** Re-apply when the set of logged-in accounts changed (Pi has no login event). */
	const refresh = () => {
		const settingsChanged = syncSettings(); // names/emails set by another session
		const before = loggedIn;
		const now = computeLoggedIn();
		const loginsChanged = !(now.size === before.size && [...now].every((id) => before.has(id)));
		if (!loginsChanged && !settingsChanged) return;
		apply(); // also renames the /login entries
		if (!loginsChanged) return;
		for (const id of loggedIn) {
			if (!before.has(id)) {
				notify?.(
					`${PREFIX}: ${describeAccount(info(id))} logged in. Name it with /label-account ${id} <name> [email]; use it with /switch-account ${id}`,
					"info",
				);
			}
		}
		for (const id of before) if (!loggedIn.has(id)) notify?.(`${PREFIX}: ${id} logged out`, "warning");
	};

	apply();

	pi.on("session_start", (_event, ctx) => {
		registry = ctx.modelRegistry;
		notify = (message, level = "info") => {
			try {
				ctx.ui.notify(message, level);
			} catch {
				// UI gone
			}
		};
		apply(); // the registry also knows environment-variable logins

		const warnings: string[] = [];
		if (settingsError) warnings.push(`${settingsError} (using defaults)`);
		const unknown = settings.families.filter((f) => !builtins.has(f));
		if (unknown.length > 0) warnings.push(`unknown provider(s) in "families": ${unknown.join(", ")}`);
		const conflicting = pi.getCommands().some((c) => c.name === "multi-account");
		if (conflicting) {
			warnings.push("pi-multi-account is also installed and registers the same anthropic-account-N providers; keep only one of the two packages");
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
	});
	pi.on("input", () => {
		refresh();
		return undefined;
	});
	pi.on("session_shutdown", () => {
		if (poll) clearInterval(poll);
		poll = undefined;
	});

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
		say(ctx, `${PREFIX}: switched ${describeAccount(current)} \u2192 ${describeAccount(target)} \u00b7 ${model.id}${level !== "off" ? ` \u00b7 thinking ${level}` : ""}`);
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
}
