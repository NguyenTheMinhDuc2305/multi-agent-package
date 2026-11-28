/**
 * Run the search tool on a pool: try the accounts in order, move on when one is refused for a
 * reason specific to it, and record cooldowns in the shared tracker. Pure apart from the callbacks.
 */
import { classifyFailure } from "../classify.ts";
import { type CooldownPolicy, recordFailure } from "../router.ts";
import type { CooldownTracker } from "../cooldown.ts";
import { type AccountCredentials, SkipAccount, UpstreamError } from "./http.ts";

export interface ToolAttemptLog {
	account: string;
	outcome: "ok" | "skipped" | "failed";
	detail?: string;
	cooldownMs?: number;
}

export interface ToolRunDeps {
	cooldowns: CooldownTracker;
	policy: CooldownPolicy;
	/** Credentials for an account, or undefined when it is not logged in. */
	resolveAccount(account: string): Promise<AccountCredentials | undefined>;
	now?: () => number;
}

export type ToolRunResult<T> =
	| { ok: true; value: T; account: string; attempts: ToolAttemptLog[] }
	| { ok: false; error: string; attempts: ToolAttemptLog[] };

export async function runWithPool<T>(
	deps: ToolRunDeps,
	pool: { name: string; order: readonly string[]; modelKey: string; tool: string },
	attempt: (account: string, creds: AccountCredentials) => Promise<T>,
	signal?: AbortSignal,
): Promise<ToolRunResult<T>> {
	const attempts: ToolAttemptLog[] = [];
	const now = deps.now ?? Date.now;

	for (const account of pool.order) {
		if (signal?.aborted) return { ok: false, error: "aborted", attempts };
		let creds: AccountCredentials | undefined;
		try {
			creds = await deps.resolveAccount(account);
		} catch (error) {
			const cooldownMs = recordFailure(deps, account, pool.modelKey, { failover: true, kind: "auth", scope: "account", reason: "login error" });
			attempts.push({ account, outcome: "failed", detail: `login error: ${text(error)}`, cooldownMs });
			continue;
		}
		if (!creds) {
			attempts.push({ account, outcome: "skipped", detail: "not logged in" });
			continue;
		}
		try {
			const value = await attempt(account, creds);
			deps.cooldowns.success(account, pool.modelKey);
			attempts.push({ account, outcome: "ok" });
			return { ok: true, value, account, attempts };
		} catch (error) {
			if (signal?.aborted || (error as Error)?.name === "AbortError") return { ok: false, error: "aborted", attempts };
			if (error instanceof SkipAccount) {
				attempts.push({ account, outcome: "skipped", detail: error.message });
				continue;
			}
			const upstream = error instanceof UpstreamError ? error : undefined;
			const verdict = classifyFailure({ status: upstream?.status, headers: upstream?.headers, message: text(error) }, now());
			if (!verdict.failover) {
				// Not account-specific (bad request, overload, 5xx): another account would fail the same way.
				attempts.push({ account, outcome: "failed", detail: text(error) });
				return { ok: false, error: text(error), attempts };
			}
			const cooldownMs = recordFailure(deps, account, pool.modelKey, verdict);
			attempts.push({ account, outcome: "failed", detail: `${verdict.reason}: ${truncate(text(error), 160)}`, cooldownMs });
		}
	}
	const summary = attempts.length > 0 ? attempts.map((a) => `${a.account}: ${a.detail ?? a.outcome}`).join("; ") : "no account";
	return { ok: false, error: `no account of pool "${pool.name}" could run ${pool.tool} (${summary})`, attempts };
}

function text(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function truncate(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
