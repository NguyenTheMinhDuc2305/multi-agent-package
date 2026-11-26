/**
 * pi-multiple-account-package — several logins per provider, and a manual account switch.
 *
 * Logins:  /login offers "Anthropic (account 2)", "… (account 3)" … and "OpenAI Codex (account 2)" …
 *          next to Pi's own entries (account 1). Each account is its own provider
 *          (`anthropic-account-2`) with its own token and the family's models.
 * Switch:  /switch-account [account | number | label | next | prev]
 *          moves this session to the same model on another logged-in account of the same provider.
 *          /switch-account list · /switch-account label <account> [text]
 * Config:  <Pi config dir>/multiple-account.json (optional: labels, families)
 *
 * Nothing switches automatically: there is no failover or rotation in this package.
 */
import type { Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { type ExtensionAPI, type ExtensionContext, getAgentDir, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createAccountProvider } from "../src/accounts.ts";
import { readSettings, type Settings, writeSettings } from "../src/config.ts";
import { type FamilyView, formatList } from "../src/format.ts";
import { accountsOf, familyOf, nextFreeAccount, parseAccount } from "../src/slots.ts";
import { type AccountInfo, accountInfos, describeAccount, resolveTarget } from "../src/switch.ts";

type Level = "info" | "warning" | "error";

const LOGIN_POLL_MS = 3000;
const STATUS_KEY = "multiple-account";
const PREFIX = "multiple-account";

export default function multipleAccount(pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	const settingsPath = join(agentDir, "multiple-account.json");
	const builtins = new Map<string, Provider>(builtinProviders().map((p) => [p.id, p]));

	let settings: Settings;
	let settingsError: string | undefined;
	let families: string[] = [];
	const loadSettings = () => {
		const loaded = readSettings(settingsPath);
		settings = loaded.settings;
		settingsError = loaded.error;
		families = settings.families.filter((f) => builtins.has(f));
	};
	loadSettings();

	let registry: ModelRegistry | undefined;
	/** Extra-account providers this extension registered: id → display name. */
	let registered = new Map<string, string>();
	let loggedIn = new Set<string>();
	let statusCtx: ExtensionContext | undefined;
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

	const info = (id: string): AccountInfo => accountInfos([id], families, settings.labels)[0] ?? { id, family: id, n: 1 };

	/** Accounts to keep registered for `family` (logged in or labelled) plus the next free one. */
	const familySlots = (family: string) => {
		const known = accountsOf(family, [...loggedIn, ...Object.keys(settings.labels)], families);
		return { known, spare: nextFreeAccount(family, known, families) };
	};

	const loginName = (id: string): string => {
		const parsed = parseAccount(id, families)!;
		const name = builtins.get(parsed.family)?.name ?? parsed.family;
		return `${name} (${settings.labels[id] ?? `account ${parsed.n}`})`;
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

	/** Footer: which account this session uses, when its provider has several logged in. */
	const updateStatus = (ctx: ExtensionContext | undefined = statusCtx) => {
		if (!ctx?.hasUI) return;
		const provider = ctx.model?.provider;
		const family = familyOf(provider, families);
		const siblings = family ? accountsOf(family, loggedIn, families) : [];
		try {
			if (!provider || !family || siblings.length < 2) {
				ctx.ui.setStatus(STATUS_KEY, undefined);
				return;
			}
			const index = siblings.indexOf(provider);
			const where = index < 0 ? "not logged in" : `${index + 1}/${siblings.length}`;
			ctx.ui.setStatus(STATUS_KEY, `account: ${describeAccount(info(provider))} (${where})`);
		} catch {
			// UI gone (session replaced/shutdown)
		}
	};

	/** Re-apply when the set of logged-in accounts changed (Pi has no login event). */
	const refresh = () => {
		const before = loggedIn;
		const now = computeLoggedIn();
		if (now.size === before.size && [...now].every((id) => before.has(id))) return;
		apply();
		for (const id of loggedIn) {
			if (!before.has(id)) notify?.(`${PREFIX}: ${describeAccount(info(id))} logged in. Use it with /switch-account ${id}`, "info");
		}
		for (const id of before) if (!loggedIn.has(id)) notify?.(`${PREFIX}: ${id} logged out`, "warning");
		updateStatus();
	};

	apply();

	pi.on("session_start", (_event, ctx) => {
		registry = ctx.modelRegistry;
		statusCtx = ctx;
		notify = (message, level = "info") => {
			try {
				ctx.ui.notify(message, level);
			} catch {
				// UI gone
			}
		};
		apply(); // the registry also knows environment-variable logins
		updateStatus(ctx);

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
	pi.on("model_select", (_event, ctx) => {
		statusCtx = ctx;
		updateStatus(ctx);
	});
	pi.on("input", () => {
		refresh();
		return undefined;
	});
	pi.on("session_shutdown", () => {
		if (poll) clearInterval(poll);
		poll = undefined;
	});

	// ---- /switch-account -----------------------------------------------------------------------

	/** Show in the TUI, or print when there is no UI (`pi -p "/switch-account …"`). */
	const say = (ctx: ExtensionContext, message: string, level: Level = "info") => {
		if (ctx.hasUI) ctx.ui.notify(message, level);
		else (level === "error" ? console.error : console.log)(message);
	};

	const loggedInOf = (family: string): AccountInfo[] => accountInfos(accountsOf(family, loggedIn, families), families, settings.labels);

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

	const setLabel = (argv: string[]): string => {
		const [id, ...words] = argv;
		if (!id) return "usage: /switch-account label <account> [text]   (no text clears the label)";
		if (!parseAccount(id, families)) {
			throw new Error(`"${id}" is not an account id (e.g. ${families.map((f) => `${f}, ${f}-account-2`).join("; ")})`);
		}
		loadSettings(); // pick up edits made outside this process
		if (settingsError) throw new Error(`fix ${settingsPath} first: ${settingsError}`);
		const label = words.join(" ").trim();
		if (label) settings.labels[id] = label;
		else delete settings.labels[id];
		writeSettings(settingsPath, settings);
		apply();
		updateStatus();
		return label ? `${PREFIX}: ${id} is now labelled "${label}"` : `${PREFIX}: label of ${id} cleared`;
	};

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
		const addHint = nextLogin ? ` Add one with /login → "${loginName(nextLogin)}".` : "";

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
		updateStatus(ctx);
		say(ctx, `${PREFIX}: switched ${describeAccount(current)} → ${describeAccount(target)} · ${model.id}${level !== "off" ? ` · thinking ${level}` : ""}`);
	};

	const completions = (prefix: string) => {
		const tokens = prefix.split(/\s+/);
		const typing = tokens.pop() ?? "";
		const done = tokens.filter(Boolean);
		const base = done.length > 0 ? `${done.join(" ")} ` : "";
		const accountIds = [...loggedIn].sort();
		let candidates: string[] = [];
		if (done.length === 0) {
			candidates = ["list", "next", "prev", "label", ...accountIds, ...Object.values(settings.labels)];
		} else if (done[0] === "label" && done.length === 1) {
			candidates = [...new Set([...accountIds, ...Object.keys(settings.labels), ...registered.keys()])].sort();
		}
		const items = [...new Set(candidates)].filter((c) => c.startsWith(typing)).map((c) => ({ value: base + c, label: c }));
		return items.length > 0 ? items.slice(0, 60) : null;
	};

	pi.registerCommand("switch-account", {
		description: "Move this session to another logged-in account: /switch-account [account|number|label|next|prev|list]",
		getArgumentCompletions: completions,
		handler: async (args, ctx) => {
			registry = ctx.modelRegistry;
			statusCtx = ctx;
			refresh();
			const argv = args.trim().split(/\s+/).filter(Boolean);
			try {
				if (argv[0] === "list") say(ctx, listText(ctx));
				else if (argv[0] === "label") say(ctx, setLabel(argv.slice(1)));
				else await switchTo(ctx, argv.join(" "));
			} catch (error) {
				say(ctx, `${PREFIX}: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
