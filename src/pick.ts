/**
 * Which account to use. Pure: cooldowns, leases and logins come in as callbacks.
 *
 *   failoverOrder   accounts to try for one request, the requested one first
 *                   "next":   the session's account, then the ones after it in the pool (by
 *                             priority, wrapping around): what `/switch-account next` would pick
 *                   "spread": the agent's account, then accounts nobody uses, then the least used
 *                   Accounts cooling down come last (soonest first), as a last resort: a cooldown
 *                   can be an overestimate and a refused request is cheap.
 *   chooseAccount   the account an agent starts on: its last one if free, else a free one by
 *                   priority, else the least used
 *   stepAccount     `/switch-account next|prev` inside a pool
 */
import type { PoolMember } from "./pools.ts";

export interface AccountState {
	/** Until when the account is cooling down for this model, if it is. */
	coolingUntil(account: string): number | undefined;
	/** How many other sessions/agents use the account now. */
	users(account: string): number;
	/** Logged in (accounts that are not are never picked). */
	usable(account: string): boolean;
}

/** Pool accounts by priority, starting after `current` and wrapping around (current excluded). */
function after(accounts: readonly string[], current: string | undefined, step: 1 | -1 = 1): string[] {
	const i = current === undefined ? -1 : accounts.indexOf(current);
	if (i < 0) return step === 1 ? [...accounts] : [...accounts].reverse();
	const out: string[] = [];
	for (let k = 1; k < accounts.length; k++) out.push(accounts[(i + step * k + accounts.length * k) % accounts.length]!);
	return out;
}

export function failoverOrder(members: readonly PoolMember[], current: string, state: AccountState, mode: "next" | "spread"): string[] {
	const pool = members.map((m) => m.account).filter((a) => state.usable(a) || a === current);
	let others = after(pool, current);
	if (mode === "spread") {
		const rank = new Map(pool.map((a, i) => [a, i]));
		others = [...others].sort((a, b) => state.users(a) - state.users(b) || rank.get(a)! - rank.get(b)!);
	}
	const ready = others.filter((a) => state.coolingUntil(a) === undefined);
	const cooling = [current, ...others]
		.filter((a) => state.coolingUntil(a) !== undefined)
		.sort((a, b) => state.coolingUntil(a)! - state.coolingUntil(b)!);
	return [...(state.coolingUntil(current) === undefined ? [current] : []), ...ready, ...cooling];
}

export type ChoiceReason = "previous" | "free" | "shared" | "cooling";

export function chooseAccount(
	members: readonly PoolMember[],
	previous: string | undefined,
	state: AccountState,
): { account: string; reason: ChoiceReason } | undefined {
	const pool = members.map((m) => m.account).filter((a) => state.usable(a));
	if (pool.length === 0) return undefined;
	const ready = pool.filter((a) => state.coolingUntil(a) === undefined);
	if (previous && ready.includes(previous) && state.users(previous) === 0) return { account: previous, reason: "previous" };
	const free = ready.find((a) => state.users(a) === 0);
	if (free) return { account: free, reason: "free" };
	if (ready.length > 0) {
		const least = [...ready].sort((a, b) => state.users(a) - state.users(b))[0]!; // stable: priority breaks ties
		return { account: least, reason: "shared" };
	}
	const soonest = [...pool].sort((a, b) => state.coolingUntil(a)! - state.coolingUntil(b)!)[0]!;
	return { account: soonest, reason: "cooling" };
}

/** The account after (or before) `current` in the pool, skipping cooling ones while others are ready. */
export function stepAccount(members: readonly PoolMember[], current: string, direction: 1 | -1, state: AccountState): string | undefined {
	const pool = members.map((m) => m.account).filter((a) => state.usable(a));
	const candidates = after(pool, current, direction).filter((a) => a !== current);
	return candidates.find((a) => state.coolingUntil(a) === undefined) ?? candidates[0];
}
