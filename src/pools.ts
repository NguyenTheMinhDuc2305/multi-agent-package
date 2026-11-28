/**
 * Account pools. Pure: no Pi imports, no I/O.
 *
 * A pool is an ordered list of accounts of one provider (family). Each model of the provider
 * belongs to exactly one pool: a pool that lists it in `models`, else the provider's default pool.
 * When a request on an account is refused for a limit or a login problem, the package moves on
 * to the next account of the model's pool.
 *
 * In multiple-account.json (every key optional):
 *
 *   "pools": {
 *     "anthropic": { "default": true, "members": [{ "account": "anthropic", "priority": 1 }, …] },
 *     "fable":     { "models": ["claude-fable-5-2"], "members": [{ "account": "anthropic-account-3" }] },
 *     "anthropic-search": { "members": [{ "account": "anthropic-account-4" }] }
 *   },
 *   "tools": { "anthropic_web_search": { "pool": "anthropic-search", "model": "claude-haiku-5-5", "maxSearches": 5 } },
 *   "fallbackCooldownMinutes": 5,
 *   "maxCooldownMinutes": 60
 *
 * Pools you have not written down follow your logins (see completePools):
 *   - one default pool per provider, named after it, with every logged-in account: subscription
 *     logins first, then API keys, each by account number
 *   - "anthropic-search" with the Anthropic API-key logins, for the anthropic_web_search tool
 *
 * Rules (validatePools): a model belongs to at most one pool; an account may be in several pools,
 * with a priority per pool; a pool holds accounts of one provider; at most one default pool per
 * provider, and it lists no models.
 */
import { accountsOf, parseAccount } from "./slots.ts";

export const SEARCH_TOOL = "anthropic_web_search";
export const SEARCH_POOL = "anthropic-search";
export const SEARCH_FAMILY = "anthropic";
export const SEARCH_MODEL = "claude-haiku-5-5";
export const DEFAULT_MAX_SEARCHES = 5;

export type CredentialKind = "oauth" | "api_key";

export interface Logins {
	/** Logged-in account ids. */
	ids: readonly string[];
	/** How each account is logged in, when known (auth.json). */
	kinds: ReadonlyMap<string, CredentialKind>;
}

/** The pool part of the settings file, as written (validated by validatePools). */
export interface PoolsRaw {
	pools?: unknown;
	tools?: unknown;
	fallbackCooldownMinutes?: unknown;
	maxCooldownMinutes?: unknown;
}
export const POOL_KEYS = ["pools", "tools", "fallbackCooldownMinutes", "maxCooldownMinutes"] as const;

export interface PoolMember {
	account: string;
	/** Lower = used first. */
	priority: number;
}

export interface ResolvedPool {
	name: string;
	/** Provider all members belong to (anthropic, openai-codex). */
	family: string;
	/** Models this pool claims; empty for a default pool. */
	models: string[];
	isDefault: boolean;
	/** The pool of the search tool. */
	isSearch: boolean;
	/** Not in the file: follows the logins. */
	automatic: boolean;
	/** By priority (ties keep file order). */
	members: PoolMember[];
}

export interface SearchTool {
	pool: ResolvedPool;
	model: string;
	maxSearches: number;
}

export interface ResolvedPools {
	pools: Map<string, ResolvedPool>;
	/** The search tool's wiring; undefined when off or not set up. */
	search?: SearchTool;
	searchOff: boolean;
	fallbackCooldownMs: number;
	maxCooldownMs: number;
	warnings: string[];
}

export type PoolsResult = { ok: true; value: ResolvedPools } | { ok: false; errors: string[] };

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const isRecord = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Logged-in accounts of `family` as pool members: subscription logins first, then API keys (or only
 * API keys), each by account number.
 */
export function autoMembers(family: string, logins: Logins, families: readonly string[], only?: "api_key"): PoolMember[] {
	const ids = accountsOf(family, logins.ids, families);
	const isKey = (id: string) => logins.kinds.get(id) === "api_key";
	const list = only === "api_key" ? ids.filter(isKey) : [...ids.filter((id) => !isKey(id)), ...ids.filter(isKey)];
	return list.map((account, i) => ({ account, priority: i + 1 }));
}

/** Provider of a raw pool: from its first member, or fixed for the search pool. */
export function rawPoolFamily(name: string, pool: unknown, families: readonly string[]): string | undefined {
	if (name === SEARCH_POOL) return SEARCH_FAMILY;
	const first = isRecord(pool) && Array.isArray(pool.members) ? pool.members[0] : undefined;
	return isRecord(first) && typeof first.account === "string" ? parseAccount(first.account, families)?.family : undefined;
}

/** The pool part of the file plus every automatic pool and default tool wiring it lacks. */
export function completePools(input: PoolsRaw, logins: Logins, families: readonly string[]): { raw: PoolsRaw; automatic: string[] } {
	const raw: Record<string, any> = {};
	for (const k of POOL_KEYS) if (input[k] !== undefined) raw[k] = structuredClone(input[k]);
	const automatic: string[] = [];
	if (raw.pools !== undefined && !isRecord(raw.pools)) return { raw, automatic }; // validation reports it
	raw.pools ??= {};

	for (const family of families) {
		if (raw.pools[family]) continue;
		const hasDefault = Object.entries(raw.pools).some(
			([name, pool]) => name !== SEARCH_POOL && isRecord(pool) && pool.default === true && rawPoolFamily(name, pool, families) === family,
		);
		if (hasDefault) continue;
		const members = autoMembers(family, logins, families);
		if (members.length === 0) continue;
		raw.pools[family] = { default: true, members };
		automatic.push(family);
	}

	if (families.includes(SEARCH_FAMILY)) {
		if (!raw.pools[SEARCH_POOL]) {
			raw.pools[SEARCH_POOL] = { members: autoMembers(SEARCH_FAMILY, logins, families, "api_key") };
			automatic.push(SEARCH_POOL);
		}
		if (raw.tools === undefined) raw.tools = {};
		if (isRecord(raw.tools) && raw.tools[SEARCH_TOOL] === undefined) raw.tools[SEARCH_TOOL] = { pool: SEARCH_POOL, model: SEARCH_MODEL };
	}
	return { raw, automatic };
}

function positiveNumber(value: unknown, fallback: number, label: string, errors: string[]): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		errors.push(`${label} must be a positive number`);
		return fallback;
	}
	return value;
}

export function validatePools(raw: PoolsRaw, families: readonly string[], automatic: readonly string[] = []): PoolsResult {
	const errors: string[] = [];
	const warnings: string[] = [];
	const fallbackMin = positiveNumber(raw.fallbackCooldownMinutes, 5, "fallbackCooldownMinutes", errors);
	const maxMin = positiveNumber(raw.maxCooldownMinutes, 60, "maxCooldownMinutes", errors);
	const accountHint = families.map((f) => `${f}, ${f}-account-2, …`).join("; ");

	const pools = new Map<string, ResolvedPool>();
	const owner = new Map<string, string>(); // family\0model → pool
	if (raw.pools !== undefined && !isRecord(raw.pools)) errors.push(`"pools" must be an object`);
	for (const [name, value] of Object.entries(isRecord(raw.pools) ? raw.pools : {})) {
		if (!ID_PATTERN.test(name)) {
			errors.push(`pool "${name}": a name may only contain letters, digits, . _ -`);
			continue;
		}
		if (!isRecord(value)) {
			errors.push(`pool "${name}": must be an object`);
			continue;
		}
		const isSearch = name === SEARCH_POOL;
		if (value.default !== undefined && typeof value.default !== "boolean") errors.push(`pool "${name}": "default" must be true or false`);
		const isDefault = value.default === true;
		if (isSearch && isDefault) {
			errors.push(`pool "${SEARCH_POOL}" runs ${SEARCH_TOOL}; it cannot be a default chat pool`);
			continue;
		}

		if (!Array.isArray(value.members) || (value.members.length === 0 && !isSearch)) {
			errors.push(`pool "${name}": "members" must be a non-empty list of accounts`);
			continue;
		}
		let family: string | undefined = isSearch ? SEARCH_FAMILY : undefined;
		const seen = new Set<string>();
		const members: Array<PoolMember & { index: number }> = [];
		value.members.forEach((member: unknown, index: number) => {
			if (!isRecord(member) || typeof member.account !== "string") {
				errors.push(`pool "${name}": members[${index}] needs an "account"`);
				return;
			}
			const parsed = parseAccount(member.account, families);
			if (!parsed) {
				errors.push(`pool "${name}": "${member.account}" is not an account id (${accountHint})`);
				return;
			}
			if (seen.has(member.account)) {
				errors.push(`pool "${name}": ${member.account} is listed twice`);
				return;
			}
			seen.add(member.account);
			let priority = index + 1;
			if (member.priority !== undefined) {
				if (typeof member.priority !== "number" || !Number.isFinite(member.priority)) {
					errors.push(`pool "${name}": the priority of ${member.account} must be a number`);
					return;
				}
				priority = member.priority;
			}
			if (family === undefined) family = parsed.family;
			else if (family !== parsed.family) {
				errors.push(`pool "${name}": mixes ${family} and ${parsed.family} accounts; a pool holds the accounts of one provider`);
				return;
			}
			members.push({ account: member.account, priority, index });
		});
		if (family === undefined) continue;

		let models: string[] = [];
		if (value.models !== undefined) {
			if (isDefault) errors.push(`pool "${name}": a default pool takes every model no other pool claims and cannot list "models"`);
			else if (isSearch) errors.push(`pool "${SEARCH_POOL}" runs ${SEARCH_TOOL}; it cannot claim chat models`);
			else if (!Array.isArray(value.models) || value.models.some((m: unknown) => typeof m !== "string" || m.length === 0)) {
				errors.push(`pool "${name}": "models" must be a list of model ids`);
			} else models = [...new Set(value.models as string[])];
		}
		for (const model of models) {
			const k = `${family}\0${model}`;
			const other = owner.get(k);
			if (other !== undefined && other !== name) errors.push(`model ${model} is claimed by pools "${other}" and "${name}"; a model belongs to one pool`);
			else owner.set(k, name);
		}

		if (isDefault) {
			const other = [...pools.values()].find((p) => p.isDefault && p.family === family);
			if (other) {
				errors.push(`pools "${other.name}" and "${name}" are both the default pool of ${family}; keep one (/pool default <pool> off)`);
				continue;
			}
		}
		members.sort((a, b) => a.priority - b.priority || a.index - b.index);
		pools.set(name, {
			name,
			family,
			models,
			isDefault,
			isSearch,
			automatic: automatic.includes(name),
			members: members.map(({ account, priority }) => ({ account, priority })),
		});
	}

	let search: SearchTool | undefined;
	let searchOff = false;
	if (raw.tools !== undefined && !isRecord(raw.tools)) errors.push(`"tools" must be an object`);
	for (const [tool, value] of Object.entries(isRecord(raw.tools) ? raw.tools : {})) {
		if (tool !== SEARCH_TOOL) {
			errors.push(`tools: unknown tool "${tool}" (known: ${SEARCH_TOOL})`);
			continue;
		}
		if (value === false) {
			searchOff = true;
			continue;
		}
		if (!isRecord(value) || typeof value.pool !== "string" || typeof value.model !== "string" || value.model.length === 0) {
			errors.push(`tools.${SEARCH_TOOL}: needs "pool" and "model", or false to turn it off`);
			continue;
		}
		const pool = pools.get(value.pool);
		if (!pool) {
			errors.push(`tools.${SEARCH_TOOL}: unknown pool "${value.pool}"`);
			continue;
		}
		if (pool.family !== SEARCH_FAMILY) {
			errors.push(`tools.${SEARCH_TOOL}: pool "${pool.name}" holds ${pool.family} accounts, the tool needs ${SEARCH_FAMILY} accounts`);
			continue;
		}
		let maxSearches = DEFAULT_MAX_SEARCHES;
		if (value.maxSearches !== undefined) {
			if (typeof value.maxSearches !== "number" || !Number.isInteger(value.maxSearches) || value.maxSearches < 1 || value.maxSearches > 20) {
				errors.push(`tools.${SEARCH_TOOL}: maxSearches must be a whole number from 1 to 20`);
				continue;
			}
			maxSearches = value.maxSearches;
		}
		search = { pool, model: value.model, maxSearches };
	}

	for (const pool of pools.values()) {
		if (!pool.isDefault && !pool.isSearch && pool.models.length === 0 && pool !== search?.pool) {
			warnings.push(`pool "${pool.name}" is unused: it claims no models (/pool models ${pool.name} m1,m2)`);
		}
	}

	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		value: {
			pools,
			...(search ? { search } : {}),
			searchOff,
			fallbackCooldownMs: fallbackMin * 60_000,
			maxCooldownMs: Math.max(maxMin, fallbackMin) * 60_000,
			warnings,
		},
	};
}

/** The file's pools completed with the automatic ones, validated. */
export function resolvePools(raw: PoolsRaw, logins: Logins, families: readonly string[]): PoolsResult {
	const completed = completePools(raw, logins, families);
	return validatePools(completed.raw, families, completed.automatic);
}

/** The pool that serves `modelId` of `family`: the pool claiming it, else the family's default. */
export function routeOf(pools: ResolvedPools, family: string, modelId: string): ResolvedPool | undefined {
	let fallback: ResolvedPool | undefined;
	for (const pool of pools.pools.values()) {
		if (pool.isSearch || pool.family !== family) continue;
		if (pool.models.includes(modelId)) return pool;
		if (pool.isDefault) fallback ??= pool;
	}
	return fallback;
}
