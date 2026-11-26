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

test("labels and families round-trip; defaults are not written out", () => {
	const d = dir();
	const path = join(d, "multiple-account.json");
	try {
		writeSettings(path, { ...emptySettings(), labels: { "anthropic-account-2": "work" } });
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { labels: { "anthropic-account-2": "work" } });
		writeSettings(path, { labels: {}, families: ["anthropic"] });
		assert.deepEqual(readSettings(path).settings, { labels: {}, families: ["anthropic"] });
	} finally {
		rmSync(d, { recursive: true, force: true });
	}
});

test("a BOM is accepted; broken JSON or bad values fall back without throwing", () => {
	const d = dir();
	const path = join(d, "multiple-account.json");
	try {
		writeFileSync(path, `\uFEFF{"labels":{"anthropic":"  personal ","x":3,"y":""},"families":"anthropic"}`);
		const ok = readSettings(path);
		assert.equal(ok.error, undefined);
		assert.deepEqual(ok.settings.labels, { anthropic: "personal" });
		assert.deepEqual(ok.settings.families, emptySettings().families, "a non-array families keeps the default");
		writeFileSync(path, "{ not json");
		const broken = readSettings(path);
		assert.match(broken.error ?? "", /not valid JSON/);
		assert.deepEqual(broken.settings, emptySettings());
	} finally {
		rmSync(d, { recursive: true, force: true });
	}
});
