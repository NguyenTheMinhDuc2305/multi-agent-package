import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyFailure, parseRetryAfterMs } from "../src/classify.ts";

test("429 is a model-scoped rate limit with Retry-After honoured", () => {
	const v = classifyFailure({ status: 429, headers: { "retry-after": "120" } }, 0);
	assert.ok(v.failover);
	if (v.failover) {
		assert.equal(v.kind, "rate_limit");
		assert.equal(v.scope, "model");
		assert.equal(v.retryAfterMs, 120_000);
	}
});

test("401/402 are account-wide, 403/404 model-scoped", () => {
	const scope = (status: number) => {
		const v = classifyFailure({ status });
		return v.failover ? v.scope : "none";
	};
	assert.equal(scope(401), "account");
	assert.equal(scope(402), "account");
	assert.equal(scope(403), "model");
	assert.equal(scope(404), "model");
});

test("overload, 5xx, 400 and aborts pass through", () => {
	for (const status of [400, 413, 500, 502, 529]) {
		assert.equal(classifyFailure({ status }).failover, false, String(status));
	}
	assert.equal(classifyFailure({ status: 429, aborted: true }).failover, false);
	assert.equal(classifyFailure({ message: "overloaded_error: Overloaded" }).failover, false);
});

test("falls back to the message when no status was captured", () => {
	const v = classifyFailure({ message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"x"}}' });
	assert.ok(v.failover && v.kind === "rate_limit");
	const a = classifyFailure({ message: "authentication_error: invalid x-api-key" });
	assert.ok(a.failover && a.kind === "auth");
	assert.equal(classifyFailure({ message: "something weird happened" }).failover, false);
	// a token count must not be mistaken for a status
	assert.equal(classifyFailure({ message: "processed 14290 tokens" }).failover, false);
});

test("Retry-After accepts seconds and HTTP dates and clamps", () => {
	assert.equal(parseRetryAfterMs({ "Retry-After": "1" }, 0), 5_000); // clamped up
	assert.equal(parseRetryAfterMs({ "retry-after": "999999" }, 0), 6 * 60 * 60_000); // clamped down
	const now = Date.parse("2030-01-01T00:00:00Z");
	assert.equal(parseRetryAfterMs({ "retry-after": "Tue, 01 Jan 2030 00:01:00 GMT" }, now), 60_000);
	assert.equal(parseRetryAfterMs({}, 0), undefined);
});
