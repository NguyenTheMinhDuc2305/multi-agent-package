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

test("the chosen account first, then pool order, wrapping around", () => {
	assert.deepEqual(failoverOrder(POOL, "a2", state()), ["a2", "a3", "a4", "a1"]);
	assert.deepEqual(failoverOrder(POOL, "a4", state()), ["a4", "a1", "a2", "a3"]);
});

test("accounts cooling down go last, soonest first; the chosen one too", () => {
	assert.deepEqual(failoverOrder(POOL, "a1", state({ cooling: { a2: 50, a1: 90 } })), ["a3", "a4", "a2", "a1"]);
});

test("accounts not logged in are skipped; an explicitly requested account outside the pool is tried first", () => {
	assert.deepEqual(failoverOrder(POOL, "a1", state({ out: ["a3"] })), ["a1", "a2", "a4"]);
	assert.deepEqual(failoverOrder(POOL, "x9", state()), ["x9", "a1", "a2", "a3", "a4"]);
});

test("failover uses pool order, not free or least-used accounts", () => {
	assert.deepEqual(failoverOrder(POOL, "a1", state({ users: { a2: 10, a3: 2 } })), ["a1", "a2", "a3", "a4"]);
});

test("an agent keeps its last account even when other sessions use it", () => {
	assert.deepEqual(chooseAccount(POOL, "a3", state()), { account: "a3", reason: "previous" });
	assert.deepEqual(chooseAccount(POOL, "a3", state({ users: { a3: 10 } })), { account: "a3", reason: "previous" });
});

test("new agents use pool priority, even if that account is the busiest", () => {
	assert.deepEqual(chooseAccount(POOL, undefined, state({ users: { a1: 10, a2: 1 } })), { account: "a1", reason: "priority" });
	assert.deepEqual(chooseAccount(POOL, undefined, state({ cooling: { a1: 10 }, users: { a2: 20 } })), { account: "a2", reason: "priority" });
});

test("a cooling previous account moves to the next ready account in pool order", () => {
	assert.deepEqual(chooseAccount(POOL, "a3", state({ cooling: { a3: 10 } })), { account: "a4", reason: "next" });
	assert.deepEqual(chooseAccount(POOL, "a4", state({ cooling: { a4: 10, a1: 20 } })), { account: "a2", reason: "next" });
});

test("a recovered earlier account does not pull an agent back from its new account", () => {
	const moved = chooseAccount(POOL, "a1", state({ cooling: { a1: 10 } }))!;
	assert.equal(moved.account, "a2");
	assert.deepEqual(chooseAccount(POOL, moved.account, state({ users: { a2: 20 } })), { account: "a2", reason: "previous" });
});

test("previous account removed from the pool or logged out: choose by pool priority", () => {
	assert.deepEqual(chooseAccount(POOL, "x9", state()), { account: "a1", reason: "priority" });
	assert.deepEqual(chooseAccount(POOL, "a3", state({ out: ["a3"] })), { account: "a1", reason: "priority" });
});

test("selection never consults occupancy", () => {
	const s = state();
	s.users = () => { throw new Error("load balancing must not run"); };
	assert.equal(chooseAccount(POOL, "a2", s)?.account, "a2");
	assert.equal(chooseAccount(POOL, undefined, s)?.account, "a1");
	assert.deepEqual(failoverOrder(POOL, "a2", s), ["a2", "a3", "a4", "a1"]);
});

test("every account cooling: the one that recovers first; no logins or no members: no choice", () => {
	assert.deepEqual(chooseAccount(POOL, undefined, state({ cooling: { a1: 40, a2: 10, a3: 30, a4: 20 } })), { account: "a2", reason: "cooling" });
	assert.equal(chooseAccount(POOL, undefined, state({ out: ["a1", "a2", "a3", "a4"] })), undefined);
	assert.equal(chooseAccount([], undefined, state()), undefined);
});

test("/switch-account next and prev step through the pool, skipping cooling accounts", () => {
	assert.equal(stepAccount(POOL, "a1", 1, state()), "a2");
	assert.equal(stepAccount(POOL, "a1", -1, state()), "a4");
	assert.equal(stepAccount(POOL, "a1", 1, state({ cooling: { a2: 5 } })), "a3");
	assert.equal(stepAccount(POOL, "a1", 1, state({ cooling: { a2: 5, a3: 5, a4: 5 } })), "a2", "all cooling: plain next");
	assert.equal(stepAccount([{ account: "a1", priority: 1 }], "a1", 1, state()), undefined);
});
