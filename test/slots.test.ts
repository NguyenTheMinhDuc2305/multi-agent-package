import assert from "node:assert/strict";
import { test } from "node:test";
import { accountId, accountsOf, familyOf, MAX_ACCOUNTS, nextFreeAccount, parseAccount } from "../src/slots.ts";

const families = ["anthropic", "openai-codex"];

test("account ids follow pi-multi-account's naming and round-trip", () => {
	assert.equal(accountId("anthropic", 1), "anthropic");
	assert.equal(accountId("anthropic", 2), "anthropic-account-2");
	assert.equal(accountId("openai-codex", 7), "openai-codex-account-7");
	for (const id of ["anthropic", "anthropic-account-2", "openai-codex-account-20"]) {
		const parsed = parseAccount(id, families)!;
		assert.equal(accountId(parsed.family, parsed.n), id);
	}
});

test("only real account ids parse", () => {
	assert.equal(parseAccount("anthropic-2", families), undefined, "CustomPackage-style ids are not accounts here");
	assert.equal(parseAccount("anthropic-account-1", families), undefined, "account 1 is the plain provider id");
	assert.equal(parseAccount("anthropic-account-02", families), undefined);
	assert.equal(parseAccount(`anthropic-account-${MAX_ACCOUNTS + 1}`, families), undefined);
	assert.equal(parseAccount("openai-account-2", families), undefined, "not a configured family");
	assert.equal(familyOf("openai-codex-account-3", families), "openai-codex");
	assert.equal(familyOf(undefined, families), undefined);
});

test("accounts of a family are sorted by number, the next free one is the lowest gap", () => {
	const ids = ["openai-codex", "anthropic-account-3", "anthropic", "work", "anthropic-account-3"];
	assert.deepEqual(accountsOf("anthropic", ids, families), ["anthropic", "anthropic-account-3"]);
	assert.equal(nextFreeAccount("anthropic", ids, families), "anthropic-account-2");
	assert.equal(nextFreeAccount("openai-codex", [], families), "openai-codex-account-2");
	const full = Array.from({ length: MAX_ACCOUNTS }, (_, i) => accountId("anthropic", i + 1));
	assert.equal(nextFreeAccount("anthropic", full, families), undefined);
});
