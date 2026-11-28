import assert from "node:assert/strict";
import { test } from "node:test";
import { type Api, type AssistantMessage, type AssistantMessageEventStream, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { CooldownTracker } from "../src/cooldown.ts";
import { type Attempt, type Failure, routeRequest } from "../src/router.ts";

const model = { id: "opus", name: "opus", api: "anthropic-messages", provider: "anthropic", baseUrl: "http://x", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1, maxTokens: 1 } as Model<Api>;

const message = (over: Partial<AssistantMessage> = {}): AssistantMessage => ({
	role: "assistant",
	content: [],
	api: model.api,
	provider: model.provider,
	model: model.id,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "stop",
	timestamp: 0,
	...over,
});

function stream(kind: "ok" | "fail" | "mid", text: string): AssistantMessageEventStream {
	const s = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const partial = message({ stopReason: "stop" });
		if (kind === "fail") {
			s.push({ type: "error", reason: "error", error: message({ stopReason: "error", errorMessage: text }) });
		} else {
			s.push({ type: "start", partial });
			s.push({ type: "text_start", contentIndex: 0, partial });
			if (kind === "mid") s.push({ type: "error", reason: "error", error: message({ stopReason: "error", errorMessage: "429 rate_limit_error" }) });
			else s.push({ type: "done", reason: "stop", message: message({ content: [{ type: "text", text }] }) });
		}
		s.end();
	});
	return s;
}

type Behaviour = "ok" | "429" | "401" | "529" | "mid429" | "nologin" | "throw";

function run(order: string[], behaviour: Record<string, Behaviour>, cooldowns = new CooldownTracker()) {
	const calls: string[] = [];
	let committed: { account: string; failures: readonly Failure[] } | undefined;
	const open = async (account: string): Promise<Attempt | undefined> => {
		calls.push(account);
		const b = behaviour[account] ?? "ok";
		if (b === "nologin") return undefined;
		if (b === "throw") throw new Error("token refresh failed");
		const response: Attempt["response"] = {};
		if (b === "429") return { stream: stream("fail", "rate_limit_error"), response: { status: 429, headers: { "retry-after": "120" } } };
		if (b === "401") return { stream: stream("fail", "authentication_error: OAuth access token has been revoked"), response: { status: 401 } };
		if (b === "529") return { stream: stream("fail", "overloaded_error"), response: { status: 529 } };
		if (b === "mid429") return { stream: stream("mid", ""), response: { status: 200 } };
		return { stream: stream("ok", `served by ${account}`), response };
	};
	const out = routeRequest(
		{ cooldowns, policy: { fallbackCooldownMs: 60_000, maxCooldownMs: 600_000 }, open },
		{ pool: "anthropic", modelKey: "opus", order, onCommit: (account, failures) => (committed = { account, failures }) },
		model,
	);
	return {
		calls,
		cooldowns,
		committed: () => committed,
		result: async () => {
			const events = [];
			for await (const e of out) events.push(e);
			return { events, final: await out.result() };
		},
	};
}

const textOf = (m: AssistantMessage) => m.content.map((c) => (c.type === "text" ? c.text : "")).join("");

test("the chosen account serves when it works", async () => {
	const r = run(["a2", "a3"], {});
	const { final } = await r.result();
	assert.equal(textOf(final), "served by a2");
	assert.deepEqual(r.calls, ["a2"]);
	assert.equal(r.committed()?.account, "a2");
});

test("429 before any content: the next account serves, invisibly, and the first one cools down", async () => {
	const r = run(["a2", "a3", "a1"], { a2: "429" });
	const { events, final } = await r.result();
	assert.equal(textOf(final), "served by a3");
	assert.ok(!events.some((e) => e.type === "error"));
	assert.deepEqual(r.committed()?.failures, [{ account: "a2", reason: "rate_limit (429)" }]);
	const cd = r.cooldowns.get("a2", "opus");
	assert.ok(cd && cd.reason === "rate_limit (429)");
});

test("a revoked login (401) and a refresh failure cool the whole account", async () => {
	const r = run(["a1", "a2", "a3"], { a1: "401", a2: "throw" });
	assert.equal(textOf((await r.result()).final), "served by a3");
	assert.ok(r.cooldowns.get("a1", "another-model"), "401 is account-wide");
	assert.ok(r.cooldowns.get("a2", "another-model"), "a login error is account-wide");
});

test("overload (529) is not the account's fault: no switch", async () => {
	const r = run(["a1", "a2"], { a1: "529" });
	const { final } = await r.result();
	assert.equal(final.stopReason, "error");
	assert.deepEqual(r.calls, ["a1"]);
	assert.equal(r.cooldowns.get("a1", "opus"), undefined);
});

test("not logged in: skipped without a cooldown", async () => {
	const r = run(["a1", "a2"], { a1: "nologin" });
	assert.equal(textOf((await r.result()).final), "served by a2");
	assert.equal(r.cooldowns.get("a1", "opus"), undefined);
});

test("a failure after content started cannot be hidden, but cools the account", async () => {
	const r = run(["a1", "a2"], { a1: "mid429" });
	const { final } = await r.result();
	assert.equal(final.stopReason, "error");
	assert.deepEqual(r.calls, ["a1"]);
	assert.ok(r.cooldowns.get("a1", "opus"));
});

test("every account refused: one error naming each account and when it is usable again", async () => {
	const r = run(["a1", "a2"], { a1: "429", a2: "401" });
	const { final } = await r.result();
	assert.equal(final.stopReason, "error");
	assert.match(final.errorMessage ?? "", /quota exceeded or unavailable on every account of pool "anthropic"/);
	assert.match(final.errorMessage ?? "", /a1: rate_limit \(429\), usable again in 2m00s/);
	assert.match(final.errorMessage ?? "", /a2: auth \(401\), usable again in 10m00s/);
});
