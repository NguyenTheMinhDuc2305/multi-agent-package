// End-to-end check with real `pi`, fake accounts and a fake upstream. Touches nothing in your real ~/.pi.
//
//   npm run e2e            (or: node scripts/e2e.mjs [--keep])
//
// Logged in (fake subscription logins): anthropic = token A, anthropic-account-2 = token B,
// anthropic-account-3 = token C (revoked: the provider answers 401), openai-codex = a ChatGPT token.
// Every chat request answers "served by key <token>", so each step shows which account Pi used; the
// fake usage endpoints answer per token.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KEEP = process.argv.includes("--keep");
const MODEL = "claude-opus-4-8";
const KEY_A = "sk-ant-oat01-fake-A";
const KEY_B = "sk-ant-oat01-fake-B";
const KEY_C = "sk-ant-oat01-fake-C-revoked";
const jwt = (accountId) => {
	const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
	return `${enc({ alg: "none" })}.${enc({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })}.sig`;
};
const CODEX = jwt("acct-codex-1");

// ---- fake upstream ----------------------------------------------------------------------------
const seen = [];
const json = (res, status, body) => {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
};
const inHours = (h) => new Date(Date.now() + h * 3600_000).toISOString();
const ANTHROPIC_USAGE = {
	[KEY_A]: { five_hour: { utilization: 100, resets_at: inHours(2) }, seven_day: { utilization: 59, resets_at: inHours(100) } },
	[KEY_B]: { five_hour: { utilization: 35, resets_at: inHours(3) }, seven_day: { utilization: 15, resets_at: inHours(70) } },
};
const server = http.createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		const key = req.headers["x-api-key"] ?? String(req.headers.authorization ?? "").replace(/^Bearer /, "");
		if (req.method === "GET" && req.url.endsWith("/api/oauth/usage")) {
			seen.push({ key, kind: "usage" });
			if (key === KEY_C) return json(res, 401, { type: "error", error: { type: "authentication_error", message: "OAuth access token has been revoked." } });
			return ANTHROPIC_USAGE[key] ? json(res, 200, ANTHROPIC_USAGE[key]) : json(res, 404, {});
		}
		if (req.method === "GET" && req.url.endsWith("/wham/usage")) {
			seen.push({ key: "codex", kind: "usage" });
			const now = Math.floor(Date.now() / 1000);
			return json(res, 200, {
				email: "codex@example.com",
				plan_type: "plus",
				rate_limit: {
					allowed: true,
					limit_reached: false,
					primary_window: { used_percent: 4, reset_at: now + 4 * 3600 },
					secondary_window: { used_percent: 16, reset_at: now + 6 * 86400 },
				},
			});
		}
		let model = "?";
		try {
			model = JSON.parse(body).model;
		} catch {}
		seen.push({ key, model, kind: "chat" });
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
const far = Date.now() + 365 * 86400_000;
const oauth = (access) => ({ type: "oauth", access, refresh: "fake-refresh", expires: far });
writeFileSync(
	join(dir, "auth.json"),
	JSON.stringify({
		anthropic: oauth(KEY_A),
		"anthropic-account-2": oauth(KEY_B),
		"anthropic-account-3": oauth(KEY_C),
		"openai-codex": { ...oauth(CODEX), accountId: "acct-codex-1" },
	}),
);
writeFileSync(
	join(dir, "models.json"),
	JSON.stringify({
		providers: {
			anthropic: { baseUrl: upstream },
			"anthropic-account-2": { baseUrl: upstream },
			"anthropic-account-3": { baseUrl: upstream },
			"openai-codex": { baseUrl: `${upstream}/backend-api` },
		},
	}),
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
	const chats = seen.slice(before).filter((s) => s.kind === "chat").map((s) => s.key);
	const usage = seen.slice(before).filter((s) => s.kind === "usage").map((s) => s.key);
	console.log(`=== ${title}\n$ pi ${args.map(quote).join(" ")}\n${out.split("\n").map((l) => `  | ${l}`).join("\n")}`);
	console.log(`  exit ${code} after ${(ms / 1000).toFixed(1)}s${timedOut ? " (TIMED OUT, killed)" : ""}`);
	console.log(`  chat requests: ${chats.length ? chats.join(", ") : "(none)"}${usage.length ? ` · usage requests: ${usage.join(", ")}` : ""}`);
	if (timedOut) failures++;
	for (const [label, ok] of checks(out, chats, usage)) {
		console.log(`  ${ok ? "PASS" : "FAIL"} ${label}`);
		if (!ok) failures++;
	}
	console.log();
}

try {
	await scenario("1. Start on account 1", ["--model", `anthropic/${MODEL}`, "-p", "say hi"], (out, keys) => [
		["answered by token A", out.includes(`served by key ${KEY_A}`) && keys.join() === KEY_A],
	]);

	await scenario("2. List the accounts", ["-p", "/switch-account list"], (out, keys) => [
		["account 1 is in use", /\u25cf anthropic\b/.test(out)],
		["account 2 is listed", out.includes("anthropic-account-2")],
		["the next free login is offered", out.includes('"Anthropic (account 4)"')],
		["no model request", keys.length === 0],
	]);

	await scenario("3. Switch to account 2, then chat", ["-p", "/switch-account anthropic-account-2", "say hi again"], (out, keys) => [
		["switch confirmed", /switched anthropic → anthropic-account-2/.test(out)],
		["answered by token B", out.includes(`served by key ${KEY_B}`) && keys.join() === KEY_B],
	]);

	await scenario("4. Resume the session: account 2 is remembered", ["-p", "and once more"], (out, keys) => [
		["answered by token B", keys.join() === KEY_B],
	]);

	await scenario("5. Name account 2 (name and email)", ["-p", "/label-account anthropic-account-2 Work work@example.com"], (out) => [
		["saved", out.includes('anthropic-account-2 is now "Work · work@example.com"')],
		["written to the settings file", (() => {
			const s = JSON.parse(readFileSync(join(dir, "multiple-account.json"), "utf8"));
			return s.accounts?.["anthropic-account-2"]?.name === "Work" && s.accounts["anthropic-account-2"].email === "work@example.com";
		})()],
	]);

	await scenario("6. Switch back with next, then by name", ["-p", "/switch-account next", "hello", "/switch-account work", "bye"], (out, keys) => [
		["next went to account 3", /switched anthropic-account-2 \(Work · work@example\.com\) → anthropic-account-3/.test(out)],
		["the name went to account 2", /→ anthropic-account-2 \(Work · work@example\.com\)/.test(out)],
		["answered by C then B", keys.join() === `${KEY_C},${KEY_B}`],
	]);

	await scenario("7. Usage of every account", ["-p", "/usage"], (out, chats, usage) => [
		["account 1 at its limit", /anthropic\n {4}5h session \u2588{10} 100% used · resets in [12]h \d\dm  \u2190 limit reached/.test(out)],
		["account 2 named, in use, 35%", /\u25cf anthropic-account-2 · Work · work@example\.com\n {4}5h session \u2588{4}\u2591{6}  35% used/.test(out)],
		["revoked login explained", /anthropic-account-3\n {4}login expired or revoked \(HTTP 401: OAuth access token has been revoked\.\) → \/login → "Anthropic \(account 3\)"/.test(out)],
		["Codex plan and email", /openai-codex · Plus · codex@example\.com\n {4}5h session/.test(out)],
		["one usage request per account, no chat", usage.length === 4 && chats.length === 0],
	]);

	await scenario("8. Unknown account", ["-p", "/switch-account 5"], (out, keys) => [
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
