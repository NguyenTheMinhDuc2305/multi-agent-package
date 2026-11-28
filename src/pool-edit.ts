/**
 * Edit the pools from commands (`/pool add …`, `pi -p "/pool add …"`). Pure: takes the pool part
 * of the settings file, returns the edited copy. Every edit is validated as a whole (together with
 * the automatic pools) before the caller writes it, so a command never leaves a broken file.
 *
 * An automatic pool (one that follows the logins) is written to the file when it is first edited;
 * from then on it keeps exactly the accounts you give it.
 */
import { type CredentialKind, type PoolMember, type PoolsRaw, rawPoolFamily, SEARCH_FAMILY, SEARCH_MODEL, SEARCH_POOL, SEARCH_TOOL, validatePools } from "./pools.ts";
import { parseAccount } from "./slots.ts";

export class EditError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EditError";
	}
}

export interface EditEnv {
	families: readonly string[];
	loggedIn: ReadonlySet<string>;
	kinds: ReadonlyMap<string, CredentialKind>;
	/** Pools that follow the logins now (not in the file). */
	autoPools: Readonly<Record<string, { isDefault: boolean; members: readonly PoolMember[] }>>;
	/** The pool part completed with the automatic pools, to validate an edit as Pi will see it. */
	complete(raw: PoolsRaw): { raw: PoolsRaw; automatic: string[] };
	/** Model ids of a provider, to catch typos (optional). */
	modelIds?(family: string): readonly string[];
}

export interface EditResult {
	raw: PoolsRaw;
	message: string;
}

export const EDIT_USAGE: Record<string, string> = {
	new: "new <pool> <account> [account …] --models m1,m2   (or --default)",
	add: "add <pool> <account> [priority]",
	remove: "remove <pool> <account>",
	priority: "priority <pool> <account> <number>",
	models: "models <pool> <m1,m2,… | +m1,-m2,… | none>",
	default: "default <pool> on|off",
	delete: "delete <pool>",
	tool: `tool ${SEARCH_TOOL} off|on   |   tool ${SEARCH_TOOL} <pool> <model> [maxSearches]`,
};
export const EDIT_COMMANDS = Object.keys(EDIT_USAGE);

const usage = (cmd: string) => new EditError(`usage: /pool ${EDIT_USAGE[cmd]}`);
const splitList = (parts: string[]) => parts.flatMap((p) => p.split(",")).map((s) => s.trim()).filter(Boolean);

function kindNote(id: string, env: EditEnv): string {
	if (!env.loggedIn.has(id)) return " (not logged in)";
	return env.kinds.get(id) === "api_key" ? " (API key)" : "";
}

/** `pool "fable" [models: claude-fable-5-2]: 1. anthropic-account-3, 2. anthropic-account-4 (API key)` */
export function describePool(raw: PoolsRaw, name: string, env: EditEnv): string {
	const pool = (raw.pools as Record<string, any> | undefined)?.[name];
	if (!pool) return `pool "${name}" (deleted)`;
	const members = [...(pool.members ?? [])]
		.map((m: any, i: number) => ({ account: m.account as string, priority: typeof m.priority === "number" ? m.priority : i + 1 }))
		.sort((a, b) => a.priority - b.priority)
		.map((m) => `${m.priority}. ${m.account}${kindNote(m.account, env)}`)
		.join(", ");
	const scope = name === SEARCH_POOL ? SEARCH_TOOL : pool.default ? "default" : pool.models?.length ? `models: ${pool.models.join(", ")}` : "no models yet";
	return `pool "${name}" [${scope}]: ${members || "(empty)"}`;
}

export function applyPoolEdit(input: PoolsRaw, argv: string[], env: EditEnv): EditResult {
	const raw: Record<string, any> = structuredClone(input ?? {});
	if (raw.pools !== undefined && (typeof raw.pools !== "object" || Array.isArray(raw.pools))) {
		throw new EditError(`"pools" in the settings file is not an object; fix the file first`);
	}
	raw.pools ??= {};
	const [cmd, ...rest] = argv;

	/** A pool to edit: from the file, or an automatic one written out as it is now. */
	const poolOf = (name: string | undefined, command: string): Record<string, any> => {
		if (!name) throw usage(command);
		if (!raw.pools[name]) {
			const auto = env.autoPools[name];
			if (!auto) {
				const known = [...new Set([...Object.keys(raw.pools), ...Object.keys(env.autoPools)])];
				throw new EditError(`no pool "${name}". Pools: ${known.join(", ") || "(none)"}`);
			}
			raw.pools[name] = { ...(auto.isDefault ? { default: true } : {}), members: auto.members.map((m) => ({ account: m.account, priority: m.priority })) };
		}
		const pool = raw.pools[name];
		if (!Array.isArray(pool.members)) pool.members = [];
		return pool;
	};
	const familyOf = (name: string) => rawPoolFamily(name, raw.pools[name], env.families);

	const requireAccount = (id: string | undefined, command: string, family?: string): string => {
		if (!id) throw usage(command);
		const parsed = parseAccount(id, env.families);
		if (!parsed) {
			throw new EditError(`"${id}" is not an account. Accounts: ${[...env.loggedIn].sort().join(", ") || "(none logged in)"}`);
		}
		if (family && parsed.family !== family) throw new EditError(`${id} is a ${parsed.family} account; this pool holds ${family} accounts`);
		return id;
	};

	const requireSearchKey = (pool: string, id: string) => {
		if (pool !== SEARCH_POOL) return;
		if (env.kinds.get(id) === "oauth") {
			throw new EditError(`${id} is a subscription login; ${SEARCH_POOL} only takes API keys (${SEARCH_TOOL} never uses subscription logins)`);
		}
		if (!env.loggedIn.has(id)) throw new EditError(`${id} is not logged in; log it in with an API key first (/login)`);
	};

	const checkModels = (family: string | undefined, models: string[]) => {
		const known = family ? env.modelIds?.(family) : undefined;
		if (!known || known.length === 0) return;
		const unknown = models.filter((m) => !known.includes(m));
		if (unknown.length > 0) throw new EditError(`unknown ${family} model${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")} (Tab completes model ids)`);
	};

	const nextPriority = (pool: Record<string, any>) =>
		Math.max(0, ...pool.members.map((m: any, i: number) => (typeof m.priority === "number" ? m.priority : i + 1))) + 1;

	let message: string;
	switch (cmd) {
		case "new": {
			const words: string[] = [];
			let isDefault = false;
			let models: string[] = [];
			for (let i = 0; i < rest.length; i++) {
				if (rest[i] === "--default") isDefault = true;
				else if (rest[i] === "--models") models = splitList([rest[++i] ?? ""]);
				else words.push(rest[i]!);
			}
			const [name, ...accounts] = words;
			if (!name || accounts.length === 0) throw usage(cmd);
			if (raw.pools[name] || env.autoPools[name]) throw new EditError(`pool "${name}" already exists`);
			if (name === SEARCH_POOL) throw new EditError(`"${SEARCH_POOL}" is the pool of ${SEARCH_TOOL}; edit it with /pool add|remove`);
			if (!isDefault && models.length === 0) throw new EditError(`say which models the pool serves (--models m1,m2), or make it the default pool (--default)`);
			if (isDefault && models.length > 0) throw new EditError("a default pool takes every model no other pool claims; use either --default or --models");
			const family = parseAccount(accounts[0]!, env.families)?.family;
			for (const a of accounts) requireAccount(a, cmd, family);
			checkModels(family, models);
			raw.pools[name] = {
				...(isDefault ? { default: true } : {}),
				...(models.length > 0 ? { models } : {}),
				members: accounts.map((account, i) => ({ account, priority: i + 1 })),
			};
			message = `created ${describePool(raw, name, env)}`;
			break;
		}
		case "add": {
			const [name, accountArg, prio] = rest;
			const pool = poolOf(name, cmd);
			const account = requireAccount(accountArg, cmd, familyOf(name!));
			requireSearchKey(name!, account);
			if (pool.members.some((m: any) => m.account === account)) throw new EditError(`${account} is already in pool "${name}"`);
			let priority = nextPriority(pool);
			if (prio !== undefined) {
				priority = Number(prio);
				if (!Number.isFinite(priority)) throw usage(cmd);
			}
			pool.members.push({ account, priority });
			message = `added ${account} \u2192 ${describePool(raw, name!, env)}`;
			break;
		}
		case "remove": {
			const [name, account] = rest;
			const pool = poolOf(name, cmd);
			if (!account) throw usage(cmd);
			const index = pool.members.findIndex((m: any) => m.account === account);
			if (index < 0) throw new EditError(`${account} is not in pool "${name}"`);
			if (pool.members.length === 1 && name !== SEARCH_POOL) {
				throw new EditError(`${account} is the last account of "${name}"; delete the pool instead: /pool delete ${name}`);
			}
			pool.members.splice(index, 1);
			message = `removed ${account} \u2192 ${describePool(raw, name!, env)}`;
			break;
		}
		case "priority": {
			const [name, account, prio] = rest;
			const pool = poolOf(name, cmd);
			const member = pool.members.find((m: any) => m.account === account);
			if (!member) throw new EditError(`${account ?? "?"} is not in pool "${name}"`);
			const priority = Number(prio);
			if (prio === undefined || !Number.isFinite(priority)) throw usage(cmd);
			member.priority = priority;
			message = `priority set \u2192 ${describePool(raw, name!, env)}`;
			break;
		}
		case "models": {
			const [name, ...list] = rest;
			const pool = poolOf(name, cmd);
			if (pool.default) throw new EditError(`"${name}" is a default pool (every model no other pool claims); turn that off first: /pool default ${name} off`);
			const items = splitList(list);
			if (items.length === 0) throw usage(cmd);
			const relative = items.filter((i) => i.startsWith("+") || i.startsWith("-"));
			if (items.length === 1 && items[0] === "none") delete pool.models;
			else if (relative.length === items.length) {
				const current = new Set<string>(pool.models ?? []);
				for (const item of items) {
					const id = item.slice(1);
					if (!id) throw usage(cmd);
					if (item.startsWith("+")) {
						checkModels(familyOf(name!), [id]);
						current.add(id);
					} else if (!current.delete(id)) throw new EditError(`${id} is not in pool "${name}"`);
				}
				if (current.size > 0) pool.models = [...current];
				else delete pool.models;
			} else if (relative.length > 0) throw new EditError("use either a full list (m1,m2) or only changes (+m1,-m2), not both");
			else {
				checkModels(familyOf(name!), items);
				pool.models = items;
			}
			message = `models set \u2192 ${describePool(raw, name!, env)}`;
			break;
		}
		case "default": {
			const [name, flag] = rest;
			const pool = poolOf(name, cmd);
			if (flag !== "on" && flag !== "off") throw usage(cmd);
			if (flag === "on") {
				if (pool.models?.length) throw new EditError(`"${name}" claims models (${pool.models.join(", ")}); clear them first: /pool models ${name} none`);
				pool.default = true;
			} else delete pool.default;
			message = `default ${flag} \u2192 ${describePool(raw, name!, env)}`;
			break;
		}
		case "delete": {
			const [name] = rest;
			if (!name) throw usage(cmd);
			if (!raw.pools[name]) {
				if (env.autoPools[name]) {
					throw new EditError(
						name === SEARCH_POOL
							? `"${SEARCH_POOL}" follows your API-key logins and cannot be deleted; turn the tool off instead: /pool tool ${SEARCH_TOOL} off`
							: `pool "${name}" already follows your logins (nothing to delete); remove accounts with /pool remove ${name} <account>`,
					);
				}
				poolOf(name, cmd); // throws "no pool"
			}
			const tool = (raw.tools as Record<string, any> | undefined)?.[SEARCH_TOOL];
			if (tool && typeof tool === "object" && tool.pool === name) {
				throw new EditError(`pool "${name}" runs ${SEARCH_TOOL}; first: /pool tool ${SEARCH_TOOL} on (back to "${SEARCH_POOL}") or off`);
			}
			delete raw.pools[name];
			message =
				name === SEARCH_POOL || env.families.includes(name)
					? `pool "${name}" removed from the file: it follows your logins again`
					: `deleted pool "${name}"`;
			break;
		}
		case "tool": {
			const [tool, poolName, model, max] = rest;
			if (tool !== SEARCH_TOOL) throw new EditError(`the only tool is ${SEARCH_TOOL}`);
			raw.tools = typeof raw.tools === "object" && raw.tools !== null && !Array.isArray(raw.tools) ? raw.tools : {};
			if (poolName === "off") {
				raw.tools[tool] = false;
				message = `${tool} turned off (on again: /pool tool ${tool} on)`;
				break;
			}
			if (poolName === "on") {
				delete raw.tools[tool];
				message = `${tool} on: pool "${SEARCH_POOL}" (your Anthropic API keys), model ${SEARCH_MODEL}`;
				break;
			}
			if (!poolName || !model) throw usage(cmd);
			if (!raw.pools[poolName] && !env.autoPools[poolName]) throw new EditError(`no pool "${poolName}"`);
			const poolFamily = raw.pools[poolName] ? familyOf(poolName) : rawPoolFamily(poolName, env.autoPools[poolName], env.families);
			if (poolFamily !== SEARCH_FAMILY) throw new EditError(`${tool} needs a pool of ${SEARCH_FAMILY} accounts`);
			checkModels(SEARCH_FAMILY, [model]);
			const maxSearches = max === undefined ? undefined : Number(max);
			if (maxSearches !== undefined && !Number.isFinite(maxSearches)) throw usage(cmd);
			raw.tools[tool] = { pool: poolName, model, ...(maxSearches !== undefined ? { maxSearches } : {}) };
			message = `${tool} \u2192 pool "${poolName}", model ${model}${maxSearches ? `, at most ${maxSearches} searches per call` : ""} (API-key accounts only)`;
			break;
		}
		default:
			throw new EditError(`unknown subcommand "${cmd ?? ""}"`);
	}

	if (raw.tools && typeof raw.tools === "object" && Object.keys(raw.tools).length === 0) delete raw.tools;
	if (Object.keys(raw.pools).length === 0) delete raw.pools;
	const completed = env.complete(raw);
	const check = validatePools(completed.raw, env.families, completed.automatic);
	if (!check.ok) throw new EditError(`not saved, the result would be invalid:\n- ${check.errors.join("\n- ")}`);
	return { raw, message };
}
