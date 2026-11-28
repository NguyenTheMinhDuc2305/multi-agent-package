/** Text of `/pool` (status). Pure formatting. */
import type { CooldownEntry } from "./cooldown.ts";
import { type LeaseHolder } from "./leases.ts";
import { type CredentialKind, type PoolsResult, type ResolvedPool, SEARCH_TOOL } from "./pools.ts";
import { formatDuration } from "./router.ts";

export interface StatusInput {
	result: PoolsResult;
	settingsPath: string;
	/** Display name of a provider ("Anthropic"). */
	providerName(family: string): string;
	/** "anthropic-account-2 (Work · me@company.com)" */
	describe(account: string): string;
	loggedIn: ReadonlySet<string>;
	kinds: ReadonlyMap<string, CredentialKind>;
	cooldowns: readonly CooldownEntry[];
	holders: readonly LeaseHolder[];
	/** Lease key of this window's main session. */
	mainKey?: string;
	pid: number;
	now?: number;
}

function who(holder: LeaseHolder, input: StatusInput): string {
	if (holder.key === input.mainKey) return "\u25cf this session";
	const here = holder.lease.pid === input.pid;
	if (holder.lease.kind === "agent") return `${holder.lease.label}${here ? "" : " (other window)"}`;
	return here ? holder.lease.label : "another Pi window";
}

function scope(pool: ResolvedPool, input: StatusInput, result: Extract<PoolsResult, { ok: true }>): string {
	const search = result.value.search;
	if (pool.isSearch || search?.pool === pool) {
		const tool = search?.pool === pool ? `${SEARCH_TOOL} (${search.model}, \u2264${search.maxSearches} searches)` : `${SEARCH_TOOL} (off)`;
		return pool.isSearch ? tool : `${tool} · ${pool.isDefault ? "default" : `models: ${pool.models.join(", ") || "none"}`}`;
	}
	if (pool.isDefault) return `default: ${input.providerName(pool.family)} models no other pool claims`;
	return pool.models.length > 0 ? `models: ${pool.models.join(", ")}` : "no models (unused)";
}

export function formatPoolStatus(input: StatusInput): string {
	const { result } = input;
	if (!result.ok) return [`Pools: ${input.settingsPath} is not valid:`, ...result.errors.map((e) => `  - ${e}`), "Fix the file (or undo the last edit); until then requests are not switched."].join("\n");
	const now = input.now ?? Date.now();
	const lines = [`Pools \u00b7 ${input.settingsPath}`, "(automatic = follows your logins; a pool you edit keeps exactly what you set)"];
	if (result.value.pools.size === 0) lines.push("", "No pool yet: log in with /login; each provider's logins then form a pool by themselves.");

	for (const pool of result.value.pools.values()) {
		lines.push("", `${pool.name} \u00b7 ${scope(pool, input, result)}${pool.automatic ? " \u00b7 automatic" : ""}`);
		if (pool.members.length === 0) {
			lines.push(pool.isSearch ? "  (empty: log in an Anthropic API key in a free /login slot; it joins by itself)" : `  (empty: /pool add ${pool.name} <account>)`);
		}
		const width = Math.max(...pool.members.map((m) => input.describe(m.account).length), 0);
		for (const m of pool.members) {
			const facts: string[] = [];
			if (!input.loggedIn.has(m.account)) facts.push("NOT logged in");
			else facts.push(input.kinds.get(m.account) === "api_key" ? "API key (billed per token)" : "subscription");
			const model = pool.isSearch ? result.value.search?.model : undefined;
			const cooling = input.cooldowns
				.filter((c) => c.account === m.account && (c.model === "*" || pool.models.length === 0 || pool.models.includes(c.model) || c.model === model))
				.sort((a, b) => b.until - a.until)[0];
			if (cooling) facts.push(`cooling ${formatDuration(cooling.until - now)} (${cooling.reason}${cooling.model === "*" ? "" : `, ${cooling.model}`})`);
			const users = input.holders.filter((h) => h.lease.account === m.account).map((h) => who(h, input));
			if (users.length > 0) facts.push(users.join(", "));
			lines.push(`  ${String(m.priority).padStart(2)}. ${input.describe(m.account).padEnd(width)}  ${facts.join(" \u00b7 ")}`);
		}
	}
	if (result.value.searchOff) lines.push("", `${SEARCH_TOOL}: off (/pool tool ${SEARCH_TOOL} on)`);
	if (result.value.warnings.length > 0) lines.push("", "Notes:", ...result.value.warnings.map((w) => `  - ${w}`));
	lines.push(
		"",
		"When an account is refused (limit, billing, login), the session moves to the next account of the model's pool and stays there.",
		"Cooldowns and who uses which account are shared by every Pi window on this machine. Edit: /pool help",
	);
	return lines.join("\n");
}
