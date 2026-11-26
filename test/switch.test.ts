import assert from "node:assert/strict";
import { test } from "node:test";
import { formatList } from "../src/format.ts";
import { accountInfos, describeAccount, noteText, resolveTarget } from "../src/switch.ts";

const families = ["anthropic", "openai-codex"];
const notes = {
	anthropic: { name: "personal" },
	"anthropic-account-2": { name: "Work", email: "me@company.com" },
	"anthropic-account-4": { name: "work" },
};
const accounts = accountInfos(["anthropic-account-3", "anthropic", "anthropic-account-2"], families, notes);

const target = (arg: string, current = "anthropic") => {
	const r = resolveTarget(arg, accounts, current);
	return r.ok ? r.account.id : `error: ${r.error}`;
};

test("accounts are ordered by number and carry their name and email", () => {
	assert.deepEqual(accounts.map((a) => a.id), ["anthropic", "anthropic-account-2", "anthropic-account-3"]);
	assert.equal(describeAccount(accounts[1]!), "anthropic-account-2 (Work \u00b7 me@company.com)");
	assert.equal(describeAccount(accounts[0]!), "anthropic (personal)");
	assert.equal(describeAccount(accounts[2]!), "anthropic-account-3");
	assert.equal(noteText({ email: "a@b.co" }), "a@b.co");
});

test("a target can be named by id, number, name or email", () => {
	assert.equal(target("anthropic-account-3"), "anthropic-account-3");
	assert.equal(target("2"), "anthropic-account-2");
	assert.equal(target("account-3"), "anthropic-account-3");
	assert.equal(target("account 1"), "anthropic");
	assert.equal(target("work"), "anthropic-account-2", "names match case-insensitively among logged-in accounts");
	assert.equal(target("PERSONAL", "anthropic-account-2"), "anthropic");
	assert.equal(target("ME@company.com"), "anthropic-account-2", "emails match case-insensitively");
});

test("next and prev cycle through the logged-in accounts", () => {
	assert.equal(target("next", "anthropic"), "anthropic-account-2");
	assert.equal(target("next", "anthropic-account-3"), "anthropic", "wraps around");
	assert.equal(target("prev", "anthropic"), "anthropic-account-3");
	assert.equal(target("next", "anthropic-account-9"), "anthropic", "from an account that is gone, next starts at the first");
});

test("unknown or logged-out targets explain what is available", () => {
	assert.match(target("5"), /account 5 is not logged in/);
	assert.match(target("nobody"), /no logged-in account "nobody".*anthropic-account-2 \(Work · me@company\.com\)/);
	const single = accountInfos(["anthropic"], families, {});
	const r = resolveTarget("next", single, "anthropic");
	assert.ok(!r.ok && /only one account/.test(r.error));
	const none = resolveTarget("2", [], undefined);
	assert.ok(!none.ok && /no account/.test(none.error));
});

test("the same name on two accounts must be disambiguated by id", () => {
	const twins = accountInfos(["anthropic-account-2", "anthropic-account-4"], families, notes);
	const r = resolveTarget("work", twins, undefined);
	assert.ok(!r.ok && /anthropic-account-2 and anthropic-account-4/.test(r.error));
});

test("the list marks the account in use and how to add another", () => {
	const text = formatList(
		[
			{ family: "anthropic", name: "Anthropic", loggedIn: accounts, nextLogin: "Anthropic (account 4)" },
			{ family: "openai-codex", name: "OpenAI Codex", loggedIn: [] },
		],
		"anthropic-account-2",
	);
	assert.match(text, /Anthropic\n {4}anthropic \(personal\)\n {2}\u25cf anthropic-account-2 \(Work · me@company\.com\)\n {4}anthropic-account-3/);
	assert.match(text, /add another: \/login → "Anthropic \(account 4\)"/);
	assert.match(text, /OpenAI Codex\n {2}\(none logged in\)/);
});
