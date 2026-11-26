import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLabelArgs, resolveLabelAccount } from "../src/label.ts";
import { accountInfos } from "../src/switch.ts";

const families = ["anthropic", "openai-codex"];
const parse = (line: string) => parseLabelArgs(line.split(/\s+/).filter(Boolean));

test("name and email in one go; the email can be anywhere", () => {
	assert.deepEqual(parse("anthropic-account-2 Work me@company.com"), { kind: "set", account: "anthropic-account-2", name: "Work", email: "me@company.com" });
	assert.deepEqual(parse("anthropic-account-2 me@company.com Duc Nguyen"), {
		kind: "set",
		account: "anthropic-account-2",
		name: "Duc Nguyen",
		email: "me@company.com",
	});
	assert.deepEqual(parse("anthropic Personal"), { kind: "set", account: "anthropic", name: "Personal" });
	assert.deepEqual(parse("anthropic me@x.io"), { kind: "set", account: "anthropic", email: "me@x.io" });
});

test("one field at a time, show and clear", () => {
	assert.deepEqual(parse("anthropic name Duc Nguyen"), { kind: "set", account: "anthropic", name: "Duc Nguyen" });
	assert.deepEqual(parse("anthropic email me@x.io"), { kind: "set", account: "anthropic", email: "me@x.io" });
	assert.deepEqual(parse("anthropic"), { kind: "show", account: "anthropic" });
	assert.deepEqual(parse("anthropic clear"), { kind: "clear", account: "anthropic" });
});

test("bad input is explained", () => {
	assert.equal(parse("").kind, "error");
	assert.match((parse("anthropic email nope") as { error: string }).error, /not an email/);
	assert.match((parse("anthropic Work me@x") as { error: string }).error, /"me@x" is not an email/);
	assert.match((parse("anthropic a@b.co c@d.co") as { error: string }).error, /at most one email/);
});

test("which account: id, number of the session's provider, or an existing name/email", () => {
	const known = accountInfos(["anthropic", "anthropic-account-2"], families, { "anthropic-account-2": { name: "Work", email: "w@x.com" } });
	const id = (arg: string, family?: string) => {
		const r = resolveLabelAccount(arg, known, families, family);
		return r.ok ? r.id : `error: ${r.error}`;
	};
	assert.equal(id("anthropic-account-3"), "anthropic-account-3", "any slot, even before its login");
	assert.equal(id("2", "openai-codex"), "openai-codex-account-2");
	assert.equal(id("account-1", "anthropic"), "anthropic");
	assert.match(id("2"), /ambiguous.*anthropic-account-2 or openai-codex-account-2/);
	assert.equal(id("work"), "anthropic-account-2");
	assert.equal(id("W@X.COM"), "anthropic-account-2");
	assert.match(id("nobody"), /not an account/);
});
