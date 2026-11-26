// End-to-end check with real `pi`, fake accounts and a fake Anthropic upstream. Touches nothing in
// your real ~/.pi.
//
//   npm run e2e            (or: node scripts/e2e.mjs [--keep])
//
// Two Anthropic accounts are "logged in" (anthropic = key A, anthropic-account-2 = key B). Every chat
// request reaches the fake upstream, which answers "served by key <key>", so each step shows which
// account Pi actually used.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KEEP = process.argv.includes("--keep");
const MODEL = "claude-opus-4-8";
const KEY_A = "sk-ant-api03-fake-A";
const KEY_B = "sk-ant-api03-fake-B";

// ---- fake Anthropic upstream ------------------------------------------------------------------
const seen = [];
const server = http.createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		const key = req.headers["x-api-key"] ?? String(req.headers.authorization ?? "").replace(/^Bearer /, "");
		let model = "?";
		try {
			model = JSON.parse(body).model;
		} catch {}
		seen.push({ key, model });
		res.writeHead(200, { "content-type": "text/event-stream" });
		const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
		const text = `served by key ${key}`;
		send("message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 1 } } });
		send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
		send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
		send("content_block_stop", { type: "content_block_stop", index: 0 });
		send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } });
		send("message_stop", { type: "message_stop" });
		res.end();
	});
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const upstream = `http://127.0.0.1:${server.address().port}`;

// ---- fake agent dir ---------------------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), "pi-multiple-account-e2e-"));
const session = join(dir, "session.jsonl");
writeFileSync(
	join(dir, "auth.json"),
	JSON.stringify({ anthropic: { type: "api_key", key: KEY_A }, "anthropic-account-2": { type: "api_key", key: KEY_B } }),
);
writeFileSync(
	join(dir, "models.json"),
	JSON.stringify({ providers: { anthropic: { baseUrl: upstream }, "anthropic-account-2": { baseUrl: upstream } } }),
);

// ---- run pi -----------------------------------------------------------------------------------
const quote = (a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
const STEP_TIMEOUT_MS = 90_000;

/** Kill a shell-spawned child with its whole process tree (pi runs under cmd.exe on Windows). */
function killTree(child) {
	if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
	else child.kill("SIGKILL");
}

/** Run pi asynchronously (the fake upstream lives in this process and must keep serving). */
function pi(...args) {
	const command = ["pi", "-e", PKG, "--session", session, ...args].map(quote).join(" ");
	const started = Date.now();
	return new Promise((ok) => {
		// stdin must not stay an open pipe: `pi -p` reads piped stdin as extra input and waits for EOF.
		const child = spawn(command, { shell: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PI_CODING_AGENT_DIR: dir } });
		let out = "";
		let timedOut = false;
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (out += d));
		const timer = setTimeout(() => {
			timedOut = true;
			killTree(child);
		}, STEP_TIMEOUT_MS);
		child.on("close", (code) => {
			clearTimeout(timer);
			ok({ out: out.trim(), code, timedOut, ms: Date.now() - started });
		});
	});
}

let failures = 0;
async function scenario(title, args, checks) {
	const before = seen.length;
	const { out, code, timedOut, ms } = await pi(...args);
	const keys = seen.slice(before).map((s) => s.key);
	console.log(`=== ${title}\n$ pi ${args.map(quote).join(" ")}\n${out.split("\n").map((l) => `  | ${l}`).join("\n")}`);
	console.log(`  exit ${code} after ${(ms / 1000).toFixed(1)}s${timedOut ? " (TIMED OUT, killed)" : ""}`);
	console.log(`  upstream saw: ${keys.length ? keys.join(", ") : "(no request)"}`);
	if (timedOut) failures++;
	for (const [label, ok] of checks(out, keys)) {
		console.log(`  ${ok ? "PASS" : "FAIL"} ${label}`);
		if (!ok) failures++;
	}
	console.log();
}

try {
	await scenario("1. Start on account 1", ["--model", `anthropic/${MODEL}`, "-p", "say hi"], (out, keys) => [
		["answered by key A", out.includes(`served by key ${KEY_A}`) && keys.join() === KEY_A],
	]);

	await scenario("2. List the accounts", ["-p", "/switch-account list"], (out, keys) => [
		["account 1 is in use", /\u25cf anthropic\b/.test(out)],
		["account 2 is listed", out.includes("anthropic-account-2")],
		["the next free login is offered", out.includes('"Anthropic (account 3)"')],
		["no model request", keys.length === 0],
	]);

	await scenario("3. Switch to account 2, then chat", ["-p", "/switch-account anthropic-account-2", "say hi again"], (out, keys) => [
		["switch confirmed", /switched anthropic → anthropic-account-2/.test(out)],
		["answered by key B", out.includes(`served by key ${KEY_B}`) && keys.join() === KEY_B],
	]);

	await scenario("4. Resume the session: account 2 is remembered", ["-p", "and once more"], (out, keys) => [
		["answered by key B", keys.join() === KEY_B],
	]);

	await scenario("5. Label account 2", ["-p", "/switch-account label anthropic-account-2 work"], (out) => [
		["label saved", out.includes('anthropic-account-2 is now labelled "work"')],
	]);

	await scenario("6. Switch back with next, then by label", ["-p", "/switch-account next", "hello", "/switch-account work", "bye"], (out, keys) => [
		["next went to account 1", /switched anthropic-account-2 \(work\) → anthropic/.test(out)],
		["label went to account 2", /switched anthropic → anthropic-account-2 \(work\)/.test(out)],
		["answered by A then B", keys.join() === `${KEY_A},${KEY_B}`],
	]);

	await scenario("7. Unknown account", ["-p", "/switch-account 5"], (out, keys) => [
		["explains it is not logged in", /account 5 is not logged in/.test(out)],
		["no model request", keys.length === 0],
	]);
} finally {
	server.close();
	if (KEEP) console.log(`Kept: ${dir}`);
	else rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

console.log(failures === 0 ? "All checks passed." : `${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
