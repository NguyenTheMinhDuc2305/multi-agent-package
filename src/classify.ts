/**
 * Decide whether a failed request should move on to the next account of the pool.
 *
 * Only failures that are specific to THIS account/model qualify. Overload (529), 5xx, bad requests,
 * context overflow and user aborts are the same on every account, so they pass through untouched.
 */

export type FailureKind = "rate_limit" | "billing" | "auth" | "forbidden" | "not_found";

export interface FailureInfo {
	/** HTTP status when known (authoritative; from the provider's onResponse hook). */
	status?: number;
	/** Error message from the provider/SDK. Used when no status was captured. */
	message?: string;
	/** Response headers when known (lower-cased keys). */
	headers?: Record<string, string>;
	/** True when the request was aborted by the user. */
	aborted?: boolean;
}

export type Verdict =
	| { failover: false }
	| {
			failover: true;
			kind: FailureKind;
			/** "model": only this (account, model) pair is blocked. "account": every model of the account. */
			scope: "model" | "account";
			/** Server-provided wait, when present. */
			retryAfterMs?: number;
			reason: string;
	  };

/** Fixed cooldowns for non-rate-limit kinds (a hint cannot be trusted to exist). */
export const FIXED_COOLDOWN_MS: Record<Exclude<FailureKind, "rate_limit">, number> = {
	billing: 60 * 60_000,
	auth: 10 * 60_000,
	forbidden: 30 * 60_000,
	not_found: 30 * 60_000,
};

const MIN_HINT_MS = 5_000;
const MAX_HINT_MS = 6 * 60 * 60_000;

export function parseRetryAfterMs(headers: Record<string, string> | undefined, now = Date.now()): number | undefined {
	if (!headers) return undefined;
	const get = (name: string) => {
		const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
		return key ? headers[key] : undefined;
	};
	let ms: number | undefined;
	const retryAfter = get("retry-after");
	if (retryAfter !== undefined && retryAfter.trim() !== "") {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds)) ms = seconds * 1000;
		else {
			const date = Date.parse(retryAfter);
			if (!Number.isNaN(date)) ms = date - now;
		}
	}
	if (ms === undefined) {
		// Best effort: Anthropic's unified limiter reports the reset as epoch seconds (or an ISO date).
		const reset = get("anthropic-ratelimit-unified-reset");
		if (reset !== undefined && reset.trim() !== "") {
			const n = Number(reset);
			const at = Number.isFinite(n) ? n * 1000 : Date.parse(reset);
			if (!Number.isNaN(at)) ms = at - now;
		}
	}
	if (ms === undefined || !Number.isFinite(ms)) return undefined;
	return Math.min(MAX_HINT_MS, Math.max(MIN_HINT_MS, ms));
}

function statusFromMessage(message: string): number | undefined {
	const m = /\b(401|402|403|404|429|529|5\d\d)\b/.exec(message);
	return m ? Number(m[1]) : undefined;
}

export function classifyFailure(info: FailureInfo, now = Date.now()): Verdict {
	if (info.aborted) return { failover: false };
	const message = info.message ?? "";
	// A 2xx/3xx status means the HTTP exchange succeeded and the error arrived inside the SSE stream
	// (e.g. rate_limit_error mid-stream); the message is the only signal then.
	const httpStatus = info.status !== undefined && info.status >= 400 ? info.status : undefined;
	const status = httpStatus ?? statusFromMessage(message);
	const retryAfterMs = parseRetryAfterMs(info.headers, now);

	// Error type names used by Anthropic-style bodies, checked when the status is missing/ambiguous.
	const byType = (): FailureKind | undefined => {
		if (/rate_limit_error|too many requests|usage limit|rate.?limit|quota/i.test(message)) return "rate_limit";
		if (/billing_error|credit balance|payment required/i.test(message)) return "billing";
		if (/authentication_error|invalid (x-api-key|api key|token)|token.*(expired|revoked|invalidated)/i.test(message)) return "auth";
		if (/permission_error|forbidden/i.test(message)) return "forbidden";
		if (/not_found_error/i.test(message)) return "not_found";
		return undefined;
	};

	let kind: FailureKind | undefined;
	switch (status) {
		case 429:
			kind = "rate_limit";
			break;
		case 402:
			kind = "billing";
			break;
		case 401:
			kind = "auth";
			break;
		case 403:
			kind = "forbidden";
			break;
		case 404:
			kind = "not_found";
			break;
		case undefined:
			kind = byType();
			break;
		default:
			// 529/5xx/400 etc. are not account-specific. (Some gateways report quota as 4xx text; still
			// honour an explicit rate-limit message for other 4xx codes.)
			kind = status >= 400 && status < 500 && status !== 400 && status !== 413 ? byType() : undefined;
	}
	if (!kind) return { failover: false };

	return {
		failover: true,
		kind,
		scope: kind === "billing" || kind === "auth" ? "account" : "model",
		...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
		reason: `${kind}${status !== undefined ? ` (${status})` : ""}`,
	};
}
