import assert from "node:assert/strict";
import { test } from "node:test";
import { autoMembers, completePools, type Logins, resolvePools, routeOf, SEARCH_POOL, SEARCH_TOOL, validatePools } from "../src/pools.ts";

const FAMILIES = ["anthropic", "openai-codex"];
const logins = (entries: Record<string, "oauth" | "api_key">): Logins => ({ ids: Object.keys(entries), kinds: new Map(Object.entries(entries)) });

const LOGGED = logins({
	anthropic: "oauth",
	"anthropic-account-2": "oauth",
	"anthropic-account-3": "api_key",
	"anthropic-account-4": "oauth",
	"openai-codex": "oauth",
});

const ok = (r: ReturnType<typeof resolvePools>) => {
	if (!r.ok) throw new Error(r.errors.join("; "));
	return r.value;
};
const accounts = (members: { account: string }[]) => members.map((m) => m.account);

test("automatic pools: every login, subscriptions first then API keys, by account number", () => {
	const v = ok(resolvePools({}, LOGGED, FAMILIES));
	const anthropic = v.pools.get("anthropic")!;
	assert.equal(anthropic.isDefault, true);
	assert.equal(anthropic.automatic, true);
	assert.deepEqual(accounts(anthropic.members), ["anthropic", "anthropic-account-2", "anthropic-account-4", "anthropic-account-3"]);
	assert.deepEqual(accounts(v.pools.get("openai-codex")!.members), ["openai-codex"]);
});

test("the search pool holds only Anthropic API keys and is wired to the tool", () => {
	const v = ok(resolvePools({}, LOGGED, FAMILIES));
	assert.deepEqual(accounts(v.pools.get(SEARCH_POOL)!.members), ["anthropic-account-3"]);
	assert.equal(v.search?.pool.name, SEARCH_POOL);
	assert.equal(v.search?.maxSearches, 5);
	assert.deepEqual(autoMembers("anthropic", LOGGED, FAMILIES, "api_key").map((m) => m.account), ["anthropic-account-3"]);
});

test("no login: no chat pool, an empty search pool", () => {
	const v = ok(resolvePools({}, logins({}), FAMILIES));
	assert.equal(v.pools.has("anthropic"), false);
	assert.equal(v.pools.get(SEARCH_POOL)!.members.length, 0);
});

test("a dedicated pool takes its models; the rest go to the default pool", () => {
	const v = ok(
		resolvePools(
			{ pools: { fable: { models: ["claude-fable-5-2"], members: [{ account: "anthropic-account-4" }, { account: "anthropic-account-2" }] } } },
			LOGGED,
			FAMILIES,
		),
	);
	assert.equal(routeOf(v, "anthropic", "claude-fable-5-2")?.name, "fable");
	assert.equal(routeOf(v, "anthropic", "claude-opus-4-8")?.name, "anthropic");
	assert.equal(routeOf(v, "openai-codex", "gpt-5.6")?.name, "openai-codex");
	assert.equal(routeOf(v, "openai-codex", "claude-fable-5-2")?.name, "openai-codex", "a model id is looked up per provider");
	// an account can be in several pools
	assert.ok(v.pools.get("anthropic")!.members.some((m) => m.account === "anthropic-account-4"));
});

test("an edited pool keeps exactly its accounts; a new login does not join it", () => {
	const raw = { pools: { anthropic: { default: true, members: [{ account: "anthropic-account-2", priority: 1 }] } } };
	const v = ok(resolvePools(raw, logins({ ...Object.fromEntries(LOGGED.kinds), "anthropic-account-5": "oauth" }), FAMILIES));
	assert.deepEqual(accounts(v.pools.get("anthropic")!.members), ["anthropic-account-2"]);
	assert.equal(v.pools.get("anthropic")!.automatic, false);
});

test("another default pool of a provider replaces the automatic one", () => {
	const { automatic } = completePools({ pools: { main: { default: true, members: [{ account: "anthropic" }] } } }, LOGGED, FAMILIES);
	assert.ok(!automatic.includes("anthropic"));
	assert.ok(automatic.includes("openai-codex"));
});

test("members are ordered by priority, ties keep their order", () => {
	const v = ok(
		resolvePools(
			{ pools: { anthropic: { default: true, members: [{ account: "anthropic", priority: 3 }, { account: "anthropic-account-2", priority: 1 }, { account: "anthropic-account-4", priority: 3 }] } } },
			LOGGED,
			FAMILIES,
		),
	);
	assert.deepEqual(accounts(v.pools.get("anthropic")!.members), ["anthropic-account-2", "anthropic", "anthropic-account-4"]);
});

test("rules: one pool per model, one provider per pool, one default per provider", () => {
	const r = validatePools(
		{
			pools: {
				a: { models: ["m1"], members: [{ account: "anthropic" }] },
				b: { models: ["m1"], members: [{ account: "anthropic-account-2" }] },
				mixed: { models: ["m2"], members: [{ account: "anthropic" }, { account: "openai-codex" }] },
				d1: { default: true, members: [{ account: "anthropic" }] },
				d2: { default: true, members: [{ account: "anthropic-account-2" }] },
				bad: { default: true, models: ["x"], members: [{ account: "openai-codex" }] },
				nobody: { models: ["m3"], members: [{ account: "someone-else" }] },
			},
		},
		FAMILIES,
	);
	assert.equal(r.ok, false);
	if (r.ok) return;
	const all = r.errors.join("\n");
	assert.match(all, /model m1 is claimed by pools "a" and "b"/);
	assert.match(all, /mixes anthropic and openai-codex accounts/);
	assert.match(all, /both the default pool of anthropic/);
	assert.match(all, /a default pool takes every model/);
	assert.match(all, /"someone-else" is not an account id/);
});

test("the tool can be turned off, or moved to another Anthropic pool", () => {
	const off = ok(resolvePools({ tools: { [SEARCH_TOOL]: false } }, LOGGED, FAMILIES));
	assert.equal(off.search, undefined);
	assert.equal(off.searchOff, true);
	const moved = ok(
		resolvePools(
			{ pools: { keys: { models: ["claude-haiku-5-5"], members: [{ account: "anthropic-account-3" }] } }, tools: { [SEARCH_TOOL]: { pool: "keys", model: "claude-haiku-5-5", maxSearches: 2 } } },
			LOGGED,
			FAMILIES,
		),
	);
	assert.equal(moved.search?.pool.name, "keys");
	assert.equal(moved.search?.maxSearches, 2);
	const wrong = resolvePools({ tools: { [SEARCH_TOOL]: { pool: "openai-codex", model: "x" } } }, LOGGED, FAMILIES);
	assert.equal(wrong.ok, false);
});

test("cooldown settings default to 5 and 60 minutes", () => {
	const v = ok(resolvePools({}, LOGGED, FAMILIES));
	assert.equal(v.fallbackCooldownMs, 5 * 60_000);
	assert.equal(v.maxCooldownMs, 60 * 60_000);
	assert.equal(validatePools({ fallbackCooldownMinutes: -1 }, FAMILIES).ok, false);
});
