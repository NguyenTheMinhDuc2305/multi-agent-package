import assert from "node:assert/strict";
import { test } from "node:test";
import { codexAccountId, fetchUsage, formatDuration, formatUsage, parseAnthropicUsage, parseCodexUsage } from "../src/usage.ts";

const jwt = (accountId: string) => {
	const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
	return `${enc({ alg: "none" })}.${enc({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })}.sig`;
};

// Shapes as returned by the real endpoints (trimmed).
const anthropicBody = {
	five_hour: { utilization: 100, resets_at: "2026-11-26T05:20:00.494407+00:00" },
	seven_day: { utilization: 59, resets_at: "2026-12-02T00:00:00.494426+00:00" },
	seven_day_opus: null,
	extra_usage: { is_enabled: false },
};
const codexBody = {
	email: "me@gmail.com",
	plan_type: "plus",
	rate_limit: {
		allowed: true,
		limit_reached: false,
		primary_window: { used_percent: 4, limit_window_seconds: 18000, reset_at: 1795673820 },
		secondary_window: { used_percent: 16, limit_window_seconds: 604800, reset_at: 1796193809 },
	},
};

test("Anthropic usage: 5h and weekly windows, limit reached at 100%", () => {
	const r = parseAnthropicUsage(anthropicBody);
	assert.ok(r && r.status === "ok");
	if (r?.status !== "ok") return;
	assert.deepEqual(r.windows.map((w) => [w.label, w.usedPercent]), [["5h session", 100], ["7d weekly", 59]]);
	assert.equal(r.windows[0]!.resetAt, Date.parse("2026-11-26T05:20:00.494Z"));
	assert.equal(r.limitReached, true);
	assert.equal(parseAnthropicUsage({ five_hour: null }), undefined);
});

test("Codex usage: windows, plan and email; epoch-second resets", () => {
	const r = parseCodexUsage(codexBody);
	assert.ok(r && r.status === "ok");
	if (r?.status !== "ok") return;
	assert.deepEqual(r.windows.map((w) => [w.label, w.usedPercent, w.resetAt]), [
		["5h session", 4, 1795673820000],
		["7d weekly", 16, 1796193809000],
	]);
	assert.equal(r.plan, "Plus");
	assert.equal(r.email, "me@gmail.com");
	assert.equal(r.limitReached, false);
	const blocked = parseCodexUsage({ rate_limit: { allowed: false, primary_window: { used_percent: 100, reset_at: 1 } } });
	assert.ok(blocked?.status === "ok" && blocked.limitReached);
});

function fakeFetch(status: number, body: unknown) {
	const calls: Array<{ url: string; headers: Record<string, string> }> = [];
	const fn = (async (url: string, init: RequestInit) => {
		calls.push({ url, headers: init.headers as Record<string, string> });
		return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	}) as unknown as typeof fetch;
	return { fn, calls };
}

test("fetchUsage calls the right endpoint with the account's own token", async () => {
	const a = fakeFetch(200, anthropicBody);
	const r = await fetchUsage(a.fn, { family: "anthropic", token: "sk-ant-oat01-x", baseUrl: "https://api.anthropic.com/v1" });
	assert.equal(r.status, "ok");
	assert.equal(a.calls[0]!.url, "https://api.anthropic.com/api/oauth/usage");
	assert.equal(a.calls[0]!.headers.authorization, "Bearer sk-ant-oat01-x");
	assert.equal(a.calls[0]!.headers["anthropic-beta"], "oauth-2025-04-20");

	const c = fakeFetch(200, codexBody);
	await fetchUsage(c.fn, { family: "openai-codex", token: jwt("acct-9") });
	assert.equal(c.calls[0]!.url, "https://chatgpt.com/backend-api/wham/usage");
	assert.equal(c.calls[0]!.headers["chatgpt-account-id"], "acct-9");
	assert.equal(codexAccountId("not-a-jwt"), undefined);
});

test("API keys, revoked logins and other failures", async () => {
	const none = fakeFetch(200, {});
	assert.deepEqual(await fetchUsage(none.fn, { family: "anthropic", token: "sk-ant-api03-key" }), { status: "api_key" });
	assert.equal(none.calls.length, 0, "an API key is never sent to the usage endpoint");

	const revoked = fakeFetch(401, { type: "error", error: { type: "authentication_error", message: "OAuth access token has been revoked." } });
	const r = await fetchUsage(revoked.fn, { family: "anthropic", token: "sk-ant-oat01-x" });
	assert.deepEqual(r, { status: "error", error: "login expired or revoked (HTTP 401: OAuth access token has been revoked.)", relogin: true });

	const down = fakeFetch(503, {});
	const d = await fetchUsage(down.fn, { family: "anthropic", token: "sk-ant-oat01-x" });
	assert.ok(d.status === "error" && !d.relogin && /HTTP 503/.test(d.error));

	const failing = (async () => {
		throw new Error("getaddrinfo ENOTFOUND");
	}) as unknown as typeof fetch;
	const f = await fetchUsage(failing, { family: "openai-codex", token: jwt("a") });
	assert.ok(f.status === "error" && /ENOTFOUND/.test(f.error));
});

test("the report shows bars, resets, the account in use and how to fix a dead login", () => {
	const now = Date.parse("2026-11-26T02:00:00Z");
	const text = formatUsage(
		[
			{
				name: "Anthropic",
				rows: [
					{ id: "anthropic", note: "Personal", report: parseAnthropicUsage(anthropicBody)!, loginEntry: "Anthropic" },
					{ id: "anthropic-account-2", note: "", report: { status: "error", error: "login expired or revoked (HTTP 401)", relogin: true }, loginEntry: "Anthropic (account 2)" },
					{ id: "anthropic-account-3", note: "company key", report: { status: "api_key" }, loginEntry: "Anthropic (account 3)" },
				],
			},
			{ name: "OpenAI Codex", rows: [{ id: "openai-codex", note: "", report: parseCodexUsage(codexBody)!, loginEntry: "OpenAI Codex" }] },
		],
		"anthropic",
		now,
	);
	assert.match(text, /\u25cf anthropic · Personal\n {4}5h session \u2588{10} 100% used · resets in 3h 21m  \u2190 limit reached/);
	assert.match(text, /7d weekly {2}\u2588{6}\u2591{4}  59% used · resets in 5d 22h/);
	assert.match(text, / {2}anthropic-account-2\n {4}login expired or revoked \(HTTP 401\) \u2192 \/login \u2192 "Anthropic \(account 2\)"/);
	assert.match(text, /anthropic-account-3 · company key\n {4}API key: billed per token/);
	assert.match(text, / {2}openai-codex · Plus · me@gmail\.com\n {4}5h session/);
});

test("durations", () => {
	assert.equal(formatDuration(-5), "now");
	assert.equal(formatDuration(45 * 60_000), "45m");
	assert.equal(formatDuration(3 * 3600_000 + 5 * 60_000), "3h 05m");
	assert.equal(formatDuration(50 * 3600_000), "2d 2h");
});
