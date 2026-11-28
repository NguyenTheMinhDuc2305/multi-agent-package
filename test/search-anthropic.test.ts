import assert from "node:assert/strict";
import { test } from "node:test";
import { ANTHROPIC_SEARCH_TOOL, anthropicSearch, messagesUrl } from "../src/search/anthropic.ts";
import { SkipAccount, UpstreamError } from "../src/search/http.ts";

type Call = { url: string; headers: Record<string, string>; body: any };

function fakeFetch(responses: Array<{ status?: number; json?: unknown; headers?: Record<string, string> }>) {
	const calls: Call[] = [];
	const fn = (async (url: string, init: RequestInit) => {
		calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
		const r = responses.shift()!;
		return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json", ...r.headers } });
	}) as unknown as typeof fetch;
	return { fn, calls };
}

const answer = {
	stop_reason: "end_turn",
	content: [
		{ type: "server_tool_use", id: "s1", name: "web_search", input: { query: "pi coding agent" } },
		{
			type: "web_search_tool_result",
			tool_use_id: "s1",
			content: [
				{ type: "web_search_result", url: "https://pi.dev", title: "Pi" },
				{ type: "web_search_result", url: "https://example.com/other", title: "Other" },
			],
		},
		{ type: "text", text: "Pi is a coding agent.", citations: [{ type: "web_search_result_location", url: "https://pi.dev", title: "Pi" }] },
	],
	usage: { server_tool_use: { web_search_requests: 1 } },
};

const creds = { apiKey: "sk-ant-api03-test", baseUrl: "https://api.anthropic.com" };
const req = { query: "what is pi", model: "claude-haiku-5-5", maxSearches: 3 };

test("sends the server tool with an API key and parses answer, sources, queries", async () => {
	const { fn, calls } = fakeFetch([{ json: answer }]);
	const r = await anthropicSearch(fn, creds, req);
	assert.equal(calls[0]!.url, "https://api.anthropic.com/v1/messages");
	assert.equal(calls[0]!.headers["x-api-key"], "sk-ant-api03-test");
	assert.ok(!("authorization" in calls[0]!.headers));
	assert.equal(calls[0]!.body.tools[0].type, ANTHROPIC_SEARCH_TOOL);
	assert.equal(calls[0]!.body.tools[0].max_uses, 3);
	assert.equal(calls[0]!.body.model, "claude-haiku-5-5");
	assert.equal(r.text, "Pi is a coding agent.");
	assert.deepEqual(r.sources.map((s) => s.url), ["https://pi.dev", "https://example.com/other"], "cited first, deduplicated");
	assert.deepEqual(r.queries, ["pi coding agent"]);
	assert.equal(r.searchCount, 1);
});

test("refuses subscription OAuth tokens instead of posing as Claude Code", async () => {
	const { fn, calls } = fakeFetch([]);
	await assert.rejects(anthropicSearch(fn, { ...creds, apiKey: "sk-ant-oat01-xyz" }, req), SkipAccount);
	assert.equal(calls.length, 0, "no request is sent");
});

test("pause_turn is continued with the partial turn", async () => {
	const paused = { stop_reason: "pause_turn", content: answer.content.slice(0, 2) };
	const rest = { stop_reason: "end_turn", content: [answer.content[2]] };
	const { fn, calls } = fakeFetch([{ json: paused }, { json: rest }]);
	const r = await anthropicSearch(fn, creds, req);
	assert.equal(calls.length, 2);
	assert.equal(calls[1]!.body.messages.length, 2);
	assert.equal(calls[1]!.body.messages[1].role, "assistant");
	assert.equal(r.text, "Pi is a coding agent.");
});

test("HTTP errors carry status and headers for failover classification", async () => {
	const { fn } = fakeFetch([{ status: 429, json: { error: { type: "rate_limit_error" } }, headers: { "retry-after": "30" } }]);
	const err = await anthropicSearch(fn, creds, req).catch((e) => e);
	assert.ok(err instanceof UpstreamError);
	assert.equal(err.status, 429);
	assert.equal(err.headers?.["retry-after"], "30");
});

test("all searches rate-limited with no answer becomes a 429", async () => {
	const limited = {
		stop_reason: "end_turn",
		content: [{ type: "web_search_tool_result", tool_use_id: "s", content: { type: "web_search_tool_result_error", error_code: "too_many_requests" } }],
	};
	const { fn } = fakeFetch([{ json: limited }]);
	const err = await anthropicSearch(fn, creds, req).catch((e) => e);
	assert.ok(err instanceof UpstreamError && err.status === 429);
});

test("other search errors are reported as warnings, not failures", async () => {
	const partial = {
		stop_reason: "end_turn",
		content: [
			{ type: "web_search_tool_result", tool_use_id: "s", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } },
			{ type: "text", text: "Partial answer." },
		],
	};
	const { fn } = fakeFetch([{ json: partial }]);
	const r = await anthropicSearch(fn, creds, req);
	assert.deepEqual(r.warnings, ["max_uses_exceeded"]);
});

test("domain filters are passed through and are mutually exclusive", async () => {
	const { fn, calls } = fakeFetch([{ json: answer }]);
	await anthropicSearch(fn, creds, { ...req, allowedDomains: ["pi.dev"] });
	assert.deepEqual(calls[0]!.body.tools[0].allowed_domains, ["pi.dev"]);
	await assert.rejects(anthropicSearch(fn, creds, { ...req, allowedDomains: ["a"], blockedDomains: ["b"] }), /cannot be used together/);
});

test("messagesUrl handles roots with or without /v1", () => {
	assert.equal(messagesUrl("https://x/"), "https://x/v1/messages");
	assert.equal(messagesUrl("https://x/v1"), "https://x/v1/messages");
});
