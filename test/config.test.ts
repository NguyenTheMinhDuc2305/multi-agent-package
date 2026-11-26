import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { emptySettings, readSettings, writeSettings } from "../src/config.ts";

const dir = () => mkdtempSync(join(tmpdir(), "multiple-account-"));

test("a missing file reads as defaults", () => {
	const d = dir();
	try {
		const { settings, error } = readSettings(join(d, "multiple-account.json"));
		assert.equal(error, undefined);
		assert.deepEqual(settings, emptySettings());
	} finally {
		rmSync(d, { recursive: true, force: true });
	}
});

test("names, emails and families round-trip; defaults and empty notes are not written out", () => {
	const d = dir();
	const path = join(d, "multiple-account.json");
	try {
		writeSettings(path, {
			...emptySettings(),
			accounts: { "anthropic-account-2": { name: "Work", email: "me@company.com" }, anthropic: { name: "Personal" }, gone: {} },
		});
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
			accounts: { "anthropic-account-2": { name: "Work", email: "me@company.com" }, anthropic: { name: "Personal" } },
		});
		assert.deepEqual(readSettings(path).settings.accounts["anthropic-account-2"], { name: "Work", email: "me@company.com" });
		writeSettings(path, { accounts: {}, families: ["anthropic"] });
		assert.deepEqual(readSettings(path).settings, { accounts: {}, families: ["anthropic"] });
	} finally {
		rmSync(d, { recursive: true, force: true });
	}
});

test("0.1 labels are read as names, and an accounts entry adds to them", () => {
	const d = dir();
	const path = join(d, "multiple-account.json");
	try {
		writeFileSync(path, JSON.stringify({ labels: { anthropic: "personal", "anthropic-account-2": "work" }, accounts: { "anthropic-account-2": { email: "w@x.com" } } }));
		assert.deepEqual(readSettings(path).settings.accounts, {
			anthropic: { name: "personal" },
			"anthropic-account-2": { name: "work", email: "w@x.com" },
		});
	} finally {
		rmSync(d, { recursive: true, force: true });
	}
});

test("a BOM is accepted; broken JSON or bad values fall back without throwing", () => {
	const d = dir();
	const path = join(d, "multiple-account.json");
	try {
		writeFileSync(path, `\uFEFF{"accounts":{"anthropic":{"name":"  personal ","email":3},"x":"nope","y":{"name":""}},"families":"anthropic"}`);
		const ok = readSettings(path);
		assert.equal(ok.error, undefined);
		assert.deepEqual(ok.settings.accounts, { anthropic: { name: "personal" } });
		assert.deepEqual(ok.settings.families, emptySettings().families, "a non-array families keeps the default");
		writeFileSync(path, "{ not json");
		const broken = readSettings(path);
		assert.match(broken.error ?? "", /not valid JSON/);
		assert.deepEqual(broken.settings, emptySettings());
	} finally {
		rmSync(d, { recursive: true, force: true });
	}
});
