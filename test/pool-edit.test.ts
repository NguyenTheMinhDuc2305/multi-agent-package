import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPoolEdit, EditError, type EditEnv } from "../src/pool-edit.ts";
import { completePools, type PoolsRaw, resolvePools, SEARCH_POOL, SEARCH_TOOL } from "../src/pools.ts";

const FAMILIES = ["anthropic", "openai-codex"];
const KINDS = new Map<string, "oauth" | "api_key">([
	["anthropic", "oauth"],
	["anthropic-account-2", "oauth"],
	["anthropic-account-3", "api_key"],
	["openai-codex", "oauth"],
]);
const LOGINS = { ids: [...KINDS.keys()], kinds: KINDS };

function env(raw: PoolsRaw = {}): EditEnv {
	const r = resolvePools(raw, LOGINS, FAMILIES);
	if (!r.ok) throw new Error(r.errors.join("; "));
	const autoPools: EditEnv["autoPools"] = {};
	for (const p of r.value.pools.values()) if (p.automatic) (autoPools as any)[p.name] = { isDefault: p.isDefault, members: p.members };
	return {
		families: FAMILIES,
		loggedIn: new Set(KINDS.keys()),
		kinds: KINDS,
		autoPools,
		complete: (x) => completePools(x, LOGINS, FAMILIES),
		modelIds: (family) => (family === "anthropic" ? ["claude-opus-4-8", "claude-fable-5-2", "claude-haiku-5-5"] : ["gpt-5.6"]),
	};
}
const edit = (raw: PoolsRaw, line: string) => applyPoolEdit(raw, line.split(" "), env(raw));
const members = (raw: PoolsRaw, pool: string) => (raw.pools as any)[pool].members.map((m: any) => `${m.priority}:${m.account}`);

test("removing an account writes the automatic pool to the file, without that account", () => {
	const r = edit({}, "remove anthropic anthropic-account-3");
	assert.deepEqual(members(r.raw, "anthropic"), ["1:anthropic", "2:anthropic-account-2"]);
	assert.equal((r.raw.pools as any).anthropic.default, true);
	assert.match(r.message, /removed anthropic-account-3/);
});

test("adding an account puts it last unless a priority is given", () => {
	let raw = edit({}, "remove anthropic anthropic-account-2").raw;
	raw = edit(raw, "add anthropic anthropic-account-2").raw;
	assert.deepEqual(members(raw, "anthropic"), ["1:anthropic", "3:anthropic-account-3", "4:anthropic-account-2"]);
	raw = edit(raw, "priority anthropic anthropic-account-2 0").raw;
	assert.equal(members(raw, "anthropic")[2], "0:anthropic-account-2");
});

test("a pool takes accounts of its own provider only, each once", () => {
	assert.throws(() => edit({}, "add anthropic openai-codex"), /openai-codex account; this pool holds anthropic accounts/);
	assert.throws(() => edit({}, "add anthropic anthropic-account-2"), /already in pool/);
	assert.throws(() => edit({}, "add anthropic nobody"), /is not an account/);
});

test("the last account cannot be removed; delete the pool instead", () => {
	assert.throws(() => edit({}, "remove openai-codex openai-codex"), /last account/);
});

test("a dedicated pool needs models, known ones, and takes them from the default pool", () => {
	assert.throws(() => edit({}, "new fable anthropic-account-2"), /--models/);
	assert.throws(() => edit({}, "new fable anthropic-account-2 --models claude-nope"), /unknown anthropic model: claude-nope/);
	const r = edit({}, "new fable anthropic-account-2 anthropic --models claude-fable-5-2");
	assert.deepEqual(members(r.raw, "fable"), ["1:anthropic-account-2", "2:anthropic"]);
	const resolved = resolvePools(r.raw, LOGINS, FAMILIES);
	assert.ok(resolved.ok && resolved.value.pools.get("fable")!.models.includes("claude-fable-5-2"));
});

test("models: full list, +/- changes, none; a model stays in one pool", () => {
	let raw = edit({}, "new fable anthropic-account-2 --models claude-fable-5-2").raw;
	raw = edit(raw, "models fable +claude-opus-4-8").raw;
	assert.deepEqual((raw.pools as any).fable.models, ["claude-fable-5-2", "claude-opus-4-8"]);
	raw = edit(raw, "models fable -claude-fable-5-2").raw;
	assert.deepEqual((raw.pools as any).fable.models, ["claude-opus-4-8"]);
	assert.throws(() => edit(raw, "new other anthropic --models claude-opus-4-8"), /claimed by pools "fable" and "other"/);
	assert.throws(() => edit(raw, "models anthropic claude-opus-4-8"), /default pool/);
});

test("the search pool takes API keys only", () => {
	assert.throws(() => edit({}, `add ${SEARCH_POOL} anthropic-account-2`), /subscription login; anthropic-search only takes API keys/);
	assert.throws(() => edit({}, `delete ${SEARCH_POOL}`), /cannot be deleted/);
});

test("the tool can be turned off and on", () => {
	const off = edit({}, `tool ${SEARCH_TOOL} off`).raw;
	assert.equal((off.tools as any)[SEARCH_TOOL], false);
	const on = edit(off, `tool ${SEARCH_TOOL} on`).raw;
	assert.equal(on.tools, undefined);
});

test("deleting an edited provider pool makes it automatic again; a dedicated pool is gone", () => {
	let raw = edit({}, "remove anthropic anthropic-account-3").raw;
	const r = edit(raw, "delete anthropic");
	assert.match(r.message, /follows your logins again/);
	raw = edit({}, "new fable anthropic --models claude-fable-5-2").raw;
	assert.equal((edit(raw, "delete fable").raw.pools as any)?.fable, undefined);
	assert.throws(() => edit({}, "delete anthropic"), /already follows your logins/);
});

test("errors are EditErrors with the usage line", () => {
	assert.throws(() => edit({}, "add"), (e: unknown) => e instanceof EditError && /usage: \/pool add/.test(e.message));
	assert.throws(() => edit({}, "frobnicate"), /unknown subcommand/);
});
