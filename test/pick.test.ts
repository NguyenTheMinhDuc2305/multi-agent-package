import assert from "node:assert/strict";
import { test } from "node:test";
import { type AccountState, chooseAccount, failoverOrder, stepAccount } from "../src/pick.ts";

const POOL = ["a1", "a2", "a3", "a4"].map((account, i) => ({ account, priority: i + 1 }));

function state(opts: { cooling?: Record<string, number>; users?: Record<string, number>; out?: string[] } = {}): AccountState {
	return {
		coolingUntil: (a) => opts.cooling?.[a],
		users: (a) => opts.users?.[a] ?? 0,
		usable: (a) => !(opts.out ?? []).includes(a),
	};
}

test("next: the chosen account first, then the ones after it in the pool, wrapping around", () => {
	assert.deepEqual(failoverOrder(POOL, "a2", state(), "next"), ["a2", "a3", "a4", "a1"]);
	assert.deepEqual(failoverOrder(POOL, "a4", state(), "next"), ["a4", "a1", "a2", "a3"]);
});

test("next: accounts cooling down go last, soonest first; the chosen one too", () => {
	assert.deepEqual(failoverOrder(POOL, "a1", state({ cooling: { a2: 50, a1: 90 } }), "next"), ["a3", "a4", "a2", "a1"]);
});

test("accounts that are not logged in are skipped; an account outside the pool is still tried first", () => {
	assert.deepEqual(failoverOrder(POOL, "a1", state({ out: ["a3"] }), "next"), ["a1", "a2", "a4"]);
	assert.deepEqual(failoverOrder(POOL, "x9", state(), "next"), ["x9", "a1", "a2", "a3", "a4"]);
});

test("spread: after the agent's account, free accounts before used ones", () => {
	assert.deepEqual(failoverOrder(POOL, "a1", state({ users: { a2: 1, a3: 2 } }), "spread"), ["a1", "a4", "a2", "a3"]);
});

test("an agent keeps its last account while it is free and ready", () => {
	assert.deepEqual(chooseAccount(POOL, "a3", state()), { account: "a3", reason: "previous" });
	assert.deepEqual(chooseAccount(POOL, "a3", state({ users: { a3: 1 } })), { account: "a1", reason: "free" });
	assert.deepEqual(chooseAccount(POOL, "a3", state({ cooling: { a3: 10 } })), { account: "a1", reason: "free" });
});

test("agents spread: the first free account by priority, else the least used", () => {
	assert.deepEqual(chooseAccount(POOL, undefined, state({ users: { a1: 1, a2: 1 } })), { account: "a3", reason: "free" });
	assert.deepEqual(chooseAccount(POOL, undefined, state({ users: { a1: 2, a2: 1, a3: 1, a4: 3 } })), { account: "a2", reason: "shared" });
});

test("every account cooling: the one that recovers first", () => {
	assert.deepEqual(chooseAccount(POOL, undefined, state({ cooling: { a1: 40, a2: 10, a3: 30, a4: 20 } })), { account: "a2", reason: "cooling" });
	assert.equal(chooseAccount(POOL, undefined, state({ out: ["a1", "a2", "a3", "a4"] })), undefined);
});

test("/switch-account next and prev step through the pool, skipping cooling accounts", () => {
	assert.equal(stepAccount(POOL, "a1", 1, state()), "a2");
	assert.equal(stepAccount(POOL, "a1", -1, state()), "a4");
	assert.equal(stepAccount(POOL, "a1", 1, state({ cooling: { a2: 5 } })), "a3");
	assert.equal(stepAccount(POOL, "a1", 1, state({ cooling: { a2: 5, a3: 5, a4: 5 } })), "a2", "all cooling: plain next");
	assert.equal(stepAccount([{ account: "a1", priority: 1 }], "a1", 1, state()), undefined);
});
