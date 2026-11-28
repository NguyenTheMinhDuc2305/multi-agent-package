/**
 * Which account to use. Pure: cooldowns, leases and logins come in as callbacks.
 *
 *   failoverOrder   accounts to try for one request: the session's account, then the ones after
 *                   it in the pool (by priority, wrapping around), for main sessions AND agents
 *                   Accounts cooling down come last (soonest first), as a last resort: a cooldown
 *                   can be an overestimate and a refused request is cheap.
 *   chooseAccount   keep the agent's last usable account; otherwise follow the same failover
 *                   order. New agents start by pool priority. No load balancing.
 *   stepAccount     `/switch-account next|prev` inside a pool
 */
import type { PoolMember } from "./pools.ts";

export interface AccountState {
	/** Until when the account is cooling down for this model, if it is. */
	coolingUntil(account: string): number | undefined;
	/** Informational only. Account selection deliberately ignores occupancy. */
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

export function failoverOrder(members: readonly PoolMember[], current: string, state: AccountState): string[] {
	const pool = members.map((m) => m.account).filter((a) => state.usable(a) || a === current);
	const others = after(pool, current);
	const ready = others.filter((a) => state.coolingUntil(a) === undefined);
	const cooling = [current, ...others]
		.filter((a) => state.coolingUntil(a) !== undefined)
		.sort((a, b) => state.coolingUntil(a)! - state.coolingUntil(b)!);
	return [...(state.coolingUntil(current) === undefined ? [current] : []), ...ready, ...cooling];
}

export type ChoiceReason = "previous" | "priority" | "next" | "cooling";

export function chooseAccount(
	members: readonly PoolMember[],
	previous: string | undefined,
	state: AccountState,
): { account: string; reason: ChoiceReason } | undefined {
	const pool = members.filter((m) => state.usable(m.account));
	if (pool.length === 0) return undefined;
	const hasPrevious = previous !== undefined && pool.some((m) => m.account === previous);
	const start = hasPrevious ? previous! : pool[0]!.account;
	const account = failoverOrder(pool, start, state)[0]!;
	const reason: ChoiceReason = state.coolingUntil(account) !== undefined
		? "cooling"
		: account === previous ? "previous" : hasPrevious ? "next" : "priority";
	return { account, reason };
}

/** The account after (or before) `current` in the pool, skipping cooling ones while others are ready. */
export function stepAccount(members: readonly PoolMember[], current: string, direction: 1 | -1, state: AccountState): string | undefined {
	const pool = members.map((m) => m.account).filter((a) => state.usable(a));
	const candidates = after(pool, current, direction).filter((a) => a !== current);
	return candidates.find((a) => state.coolingUntil(a) === undefined) ?? candidates[0];
}
