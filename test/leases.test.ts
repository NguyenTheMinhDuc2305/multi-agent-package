import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CooldownTracker } from "../src/cooldown.ts";
import { emptyLeases, LEASE_STALE_MS, LeaseBook, type LeaseState } from "../src/leases.ts";
import { cooldownStore, JsonFileStore } from "../src/state-file.ts";

const leaseStore = (path: string) =>
	new JsonFileStore<LeaseState>(path, { version: 1, empty: emptyLeases, parse: (raw) => ({ leases: raw.leases as any, last: raw.last as any }) });

function withDir(fn: (dir: string) => void) {
	const dir = mkdtempSync(join(tmpdir(), "mapkg-"));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("two processes see each other's leases through the file", () => {
	withDir((dir) => {
		const path = join(dir, "leases.json");
		const a = new LeaseBook({ store: leaseStore(path), isAlive: () => true });
		const b = new LeaseBook({ store: leaseStore(path), isAlive: () => true });
		a.hold("s1", { account: "anthropic", kind: "main", label: "main session", pid: 1 });
		b.hold("s2", { account: "anthropic-account-2", kind: "agent", label: "agent scout", pid: 2 });
		assert.equal(a.users("anthropic-account-2"), 1);
		assert.equal(b.users("anthropic"), 1);
		assert.equal(b.users("anthropic", "s1"), 0, "own lease not counted");
	});
});

test("releasing remembers the owner's last account", () => {
	const book = new LeaseBook({ isAlive: () => true });
	book.hold("s1", { account: "anthropic-account-3", kind: "agent", label: "agent scout", pid: 1 });
	book.release("s1", "scout@project");
	assert.equal(book.users("anthropic-account-3"), 0);
	assert.equal(book.last("scout@project"), "anthropic-account-3");
});

test("leases of dead processes and stale heartbeats do not count", () => {
	let now = 1_000_000;
	const book = new LeaseBook({ now: () => now, isAlive: (pid) => pid !== 99 });
	book.hold("dead", { account: "a", kind: "main", label: "main session", pid: 99 });
	book.hold("live", { account: "a", kind: "main", label: "main session", pid: 1 });
	assert.equal(book.users("a"), 1);
	now += LEASE_STALE_MS + 1;
	assert.equal(book.users("a"), 0);
	book.touch(["live"]);
	assert.equal(book.users("a"), 1, "a heartbeat keeps it alive");
});

test("cooldowns are shared between trackers through the file and escalate", () => {
	withDir((dir) => {
		const path = join(dir, "cooldowns.json");
		let now = 0;
		const a = new CooldownTracker({ store: cooldownStore(path), now: () => now });
		const b = new CooldownTracker({ store: cooldownStore(path), now: () => now });
		a.mark("anthropic-account-2", "opus", a.nextBackoff("anthropic-account-2", "opus", 1000, 8000), "rate_limit (429)");
		assert.equal(b.get("anthropic-account-2", "opus")?.until, 1000);
		assert.equal(b.nextBackoff("anthropic-account-2", "opus", 1000, 8000), 2000);
		a.mark("anthropic-account-2", "*", 5000, "auth (401)");
		assert.equal(b.get("anthropic-account-2", "sonnet")?.reason, "auth (401)", "account-wide applies to every model");
		b.success("anthropic-account-2", "opus");
		assert.equal(a.get("anthropic-account-2", "opus"), undefined);
		now = 10;
		assert.equal(a.clear(), 0);
	});
});
