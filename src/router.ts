/**
 * Send one model request through a pool: try accounts in the given order and move on when an
 * account is refused for a reason specific to it (limit, billing, login, model access).
 *
 *   1. Events are held back until the first content event. If the upstream fails BEFORE that with
 *      an account-specific error (classify.ts), the account gets a cooldown and the next account
 *      is tried. The caller never sees the failed attempt.
 *   2. Once content streams, the attempt is committed (`onCommit` tells which account serves it). A
 *      later failure is passed on as is, but still records a cooldown so the next request (or Pi's
 *      own retry) avoids that account.
 *   3. When every account failed, the stream ends with one error naming each account and when it
 *      can be used again.
 *
 * Pure with respect to Pi: credentials and the upstream call come in through `open`.
 */
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
} from "@earendil-works/pi-ai";
import { classifyFailure, FIXED_COOLDOWN_MS, type FailureInfo, type Verdict } from "./classify.ts";
import { ANY_MODEL, type CooldownTracker } from "./cooldown.ts";

export type FailoverVerdict = Extract<Verdict, { failover: true }>;

export interface Attempt {
	stream: AssistantMessageEventStream;
	/** Filled in by the opener's onResponse hook as the HTTP response arrives. */
	response: { status?: number; headers?: Record<string, string> };
}

export interface CooldownPolicy {
	fallbackCooldownMs: number;
	maxCooldownMs: number;
}

export interface Failure {
	account: string;
	reason: string;
}

export interface RouterDeps {
	cooldowns: CooldownTracker;
	policy: CooldownPolicy;
	now?: () => number;
	/**
	 * Start the request on `account`. Undefined when the account has no usable login. Throwing is
	 * treated as an account-wide login failure.
	 */
	open(account: string): Promise<Attempt | undefined>;
}

export interface RoutePlan {
	pool: string;
	/** Cooldown key: the model id. */
	modelKey: string;
	/** Accounts to try, in order. */
	order: readonly string[];
	/** The stream is committed to `account`; `failures` are the accounts tried before it. */
	onCommit?(account: string, failures: readonly Failure[]): void;
}

type PumpResult = { committed: true } | { committed: false; verdict: FailoverVerdict; message: string };

export function routeRequest(deps: RouterDeps, plan: RoutePlan, model: Model<Api>, signal?: AbortSignal): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();
	void run(deps, plan, model, signal, out).catch((error) => finishWithError(out, model, `pool "${plan.pool}": ${errorText(error)}`));
	return out;
}

/** Record a cooldown for a failed attempt; returns its duration. */
export function recordFailure(deps: Pick<RouterDeps, "cooldowns" | "policy">, account: string, modelKey: string, verdict: FailoverVerdict): number {
	const key = verdict.scope === "account" ? ANY_MODEL : modelKey;
	const ms =
		verdict.kind === "rate_limit"
			? (verdict.retryAfterMs ?? deps.cooldowns.nextBackoff(account, key, deps.policy.fallbackCooldownMs, deps.policy.maxCooldownMs))
			: FIXED_COOLDOWN_MS[verdict.kind];
	deps.cooldowns.mark(account, key, ms, verdict.reason);
	return ms;
}

export function formatDuration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	const h = Math.floor(m / 60);
	return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

// -------------------------------------------------------------------------------------------------

async function run(deps: RouterDeps, plan: RoutePlan, model: Model<Api>, signal: AbortSignal | undefined, out: AssistantMessageEventStream): Promise<void> {
	const now = deps.now ?? Date.now;
	const failures: Failure[] = [];
	let lastMessage: string | undefined;
	const fail = (account: string, verdict: FailoverVerdict) => {
		recordFailure(deps, account, plan.modelKey, verdict);
		failures.push({ account, reason: verdict.reason });
	};

	for (const account of plan.order) {
		if (signal?.aborted) {
			finishWithError(out, model, "Request aborted", "aborted");
			return;
		}
		let attempt: Attempt | undefined;
		try {
			attempt = await deps.open(account);
		} catch (error) {
			// A credential/refresh failure is account-wide whatever the wording.
			fail(account, { failover: true, kind: "auth", scope: "account", reason: "login error" });
			lastMessage = errorText(error);
			continue;
		}
		if (!attempt) {
			failures.push({ account, reason: "not logged in" });
			continue;
		}
		const result = await pump(deps, plan, model, account, attempt, out, now, failures);
		if (result.committed) return;
		fail(account, result.verdict);
		lastMessage = result.message;
	}

	// Wording avoids "rate limit"/status codes on purpose: Pi treats "quota exceeded" as a limit that
	// will not clear within seconds and fails fast instead of retrying in a tight loop.
	const t = now();
	const detail = failures
		.map((f) => {
			const cd = deps.cooldowns.get(f.account, plan.modelKey);
			return `${f.account}: ${f.reason}${cd ? `, usable again in ${formatDuration(cd.until - t)}` : ""}`;
		})
		.join("; ");
	finishWithError(
		out,
		model,
		`quota exceeded or unavailable on every account of pool "${plan.pool}" (${detail || "no account"})` +
			(lastMessage ? `. Last error: ${truncate(lastMessage, 200)}` : ""),
	);
}

async function pump(
	deps: RouterDeps,
	plan: RoutePlan,
	model: Model<Api>,
	account: string,
	attempt: Attempt,
	out: AssistantMessageEventStream,
	now: () => number,
	failures: readonly Failure[],
): Promise<PumpResult> {
	const held: AssistantMessageEvent[] = [];
	let committed = false;
	const commit = () => {
		committed = true;
		plan.onCommit?.(account, failures);
		for (const h of held) out.push(h);
		held.length = 0;
	};
	const failureOf = (event: Extract<AssistantMessageEvent, { type: "error" }>): FailureInfo => ({
		status: attempt.response.status,
		headers: attempt.response.headers,
		message: event.error.errorMessage,
		aborted: event.reason === "aborted",
	});

	try {
		for await (const event of attempt.stream) {
			if (!committed) {
				if (event.type === "start") {
					held.push(event);
					continue;
				}
				if (event.type === "error") {
					const verdict = classifyFailure(failureOf(event), now());
					if (verdict.failover) return { committed: false, verdict, message: event.error.errorMessage ?? "" };
				}
				commit();
			}
			out.push(event);
			if (event.type === "done") {
				deps.cooldowns.success(account, plan.modelKey);
				return { committed: true };
			}
			if (event.type === "error") {
				// Mid-stream failure: cannot be hidden, but steer the next request away from this account.
				const verdict = classifyFailure(failureOf(event), now());
				if (verdict.failover) recordFailure(deps, account, plan.modelKey, verdict);
				return { committed: true };
			}
		}
	} catch (error) {
		if (!committed) {
			const verdict = classifyFailure({ message: errorText(error), status: attempt.response.status }, now());
			if (verdict.failover) return { committed: false, verdict, message: errorText(error) };
			commit();
		}
		finishWithError(out, model, errorText(error));
		return { committed: true };
	}
	if (!committed) commit();
	finishWithError(out, model, "Upstream stream ended without a final event");
	return { committed: true };
}

function emptyUsage(): AssistantMessage["usage"] {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

/** Terminate `out` with a synthetic error message (no `start` was emitted, which the contract allows). */
function finishWithError(out: AssistantMessageEventStream, model: Model<Api>, message: string, reason: "error" | "aborted" = "error"): void {
	const error: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: reason,
		errorMessage: message,
		timestamp: Date.now(),
	};
	out.push({ type: "error", reason, error });
	out.end();
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
