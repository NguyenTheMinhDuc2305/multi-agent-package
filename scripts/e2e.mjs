// End-to-end check with real `pi`, fake accounts and a fake upstream. Touches nothing in your real ~/.pi.
//
//   npm run e2e            (or: node scripts/e2e.mjs [--keep])
//
// Logged in (fake subscription logins): anthropic = token A, anthropic-account-2 = token B,
// anthropic-account-3 = token C (revoked: the provider answers 401), openai-codex = a ChatGPT token.
// Every chat request answers "served by key <token>", so each step shows which account Pi used; the
// fake usage endpoints answer per token. Keys in `limited` answer 429 (a used-up account). From step
// 10 on, anthropic-account-4 is an API key (D): it joins the pool last and runs anthropic_web_search.
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
const KEY_D = "sk-ant-api03-fake-D";
/** Keys whose chat requests are refused with 429, like an account that ran out. */
const limited = new Set();
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
		let parsed = {};
		try {
			parsed = JSON.parse(body);
		} catch {}
		const model = parsed.model ?? "?";
		// Tools: the initial list, then additions/removals Pi sends inside the conversation.
		const toolSet = new Set((parsed.tools ?? []).map((t) => t.name ?? t.type));
		for (const m of parsed.messages ?? []) {
			if (m.role !== "system" || !Array.isArray(m.content)) continue;
			for (const b of m.content) {
				if (b.type === "tool_addition") toolSet.add(b.tool?.definition?.name);
				if (b.type === "tool_removal") toolSet.delete(b.tool?.name);
			}
		}
		const tools = [...toolSet];

		// anthropic_web_search: a non-streaming Messages request with the server web search tool
		if (!parsed.stream && (parsed.tools ?? []).some((t) => String(t.type).startsWith("web_search"))) {
			seen.push({ key, kind: "search" });
			return json(res, 200, {
				stop_reason: "end_turn",
				content: [
					{ type: "server_tool_use", id: "s1", name: "web_search", input: { query: "pi agent" } },
					{ type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://pi.dev", title: "Pi" }] },
					{ type: "text", text: `Pi is a coding agent (searched with key ${key}).`, citations: [{ type: "web_search_result_location", url: "https://pi.dev", title: "Pi" }] },
				],
				usage: { server_tool_use: { web_search_requests: 1 } },
			});
		}

		seen.push({ key, model, kind: "chat", tools });
		if (limited.has(key)) {
			res.writeHead(429, { "content-type": "application/json", "retry-after": "120" });
			return res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "This request would exceed your account's rate limit." } }));
		}
		res.writeHead(200, { "content-type": "text/event-stream" });
		const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
		send("message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 1 } } });
		const finish = (stop) => {
			send("message_delta", { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 4 } });
			send("message_stop", { type: "message_stop" });
			res.end();
		};
		const messages = parsed.messages ?? [];
		const last = messages.at(-1);
		const lastText = typeof last?.content === "string" ? last.content : (last?.content ?? []).map((b) => b.text ?? "").join(" ");
		const toolResult = Array.isArray(last?.content) ? last.content.find((b) => b.type === "tool_result") : undefined;
		const search = /SEARCH:(.+)/.exec(lastText)?.[1];
		if (search && tools.includes("anthropic_web_search")) {
			send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${seen.length}`, name: "anthropic_web_search", input: {} } });
			send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ query: search }) } });
			send("content_block_stop", { type: "content_block_stop", index: 0 });
			return finish("tool_use");
		}
		const resultText = toolResult
			? (typeof toolResult.content === "string" ? toolResult.content : (toolResult.content ?? []).map((c) => c.text ?? "").join(" ")).replace(/\s+/g, " ")
			: undefined;
		const text = resultText ? `GOT: ${resultText}` : `served by key ${key}`;
		send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
		send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
		send("content_block_stop", { type: "content_block_stop", index: 0 });
		finish("end_turn");
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


/** A long-lived Pi (RPC mode), like a second open session; collects what the package shows it. */
function rpcSession() {
	const command = ["pi", "-e", PKG, "--mode", "rpc", "--no-session", "--model", `anthropic/${MODEL}`].map(quote).join(" ");
	const child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PI_CODING_AGENT_DIR: dir } });
	const notes = [];
	let buf = "";
	child.stdout.on("data", (d) => {
		buf += d;
		let i;
		while ((i = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, i).replace(/\r$/, "");
			buf = buf.slice(i + 1);
			try {
				const r = JSON.parse(line);
				if (r.type === "extension_ui_request" && r.method === "notify") notes.push(r.message);
			} catch {}
		}
	});
	return {
		/** Send a command and wait for what the package says back. */
		async ask(message) {
			const n = notes.length;
			child.stdin.write(`${JSON.stringify({ type: "prompt", message })}\n`);
			for (let t = 0; t < 300 && notes.length === n; t++) await new Promise((r) => setTimeout(r, 100));
			return notes.slice(n).join("\n");
		},
		close: () => killTree(child),
	};
}

let failures = 0;
async function scenario(title, args, checks) {
	const before = seen.length;
	const { out, code, timedOut, ms } = await pi(...args);
	const requests = seen.slice(before);
	const chats = requests.filter((s) => s.kind === "chat").map((s) => s.key);
	const usage = requests.filter((s) => s.kind === "usage").map((s) => s.key);
	const searches = requests.filter((s) => s.kind === "search").map((s) => s.key);
	console.log(`=== ${title}\n$ pi ${args.map(quote).join(" ")}\n${out.split("\n").map((l) => `  | ${l}`).join("\n")}`);
	console.log(`  exit ${code} after ${(ms / 1000).toFixed(1)}s${timedOut ? " (TIMED OUT, killed)" : ""}`);
	const short = (k) => (k === "codex" ? k : k.replace(/^sk-ant-(oat|api)0\d-fake-/, ""));
	console.log(
		`  chat requests: ${chats.length ? chats.map(short).join(", ") : "(none)"}${usage.length ? ` · usage requests: ${usage.map(short).join(", ")}` : ""}${searches.length ? ` · search requests: ${searches.map(short).join(", ")}` : ""}`,
	);
	if (timedOut) failures++;
	for (const [label, ok] of checks(out, chats, usage, searches, requests)) {
		console.log(`  ${ok ? "PASS" : "FAIL"} ${label}`);
		if (!ok) failures++;
	}
	console.log();
}

try {
	await scenario("1. Start on account 1", ["--model", `anthropic/${MODEL}`, "-p", "say hi"], (out, keys, _u, _s, requests) => [
		["answered by token A", out.includes(`served by key ${KEY_A}`) && keys.join() === KEY_A],
		["no API key yet: anthropic_web_search is not offered", requests.every((r) => !r.tools?.includes("anthropic_web_search"))],
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

	{
		console.log("=== 8. A name set in another session shows up in a session that is already open");
		const open = rpcSession();
		const before = await open.ask("/switch-account list");
		await pi("-p", "/label-account anthropic-account-3 Night night@example.com");
		const after = await open.ask("/switch-account list");
		open.close();
		console.log(after.split("\n").map((l) => `  | ${l}`).join("\n"));
		for (const [label, ok] of [
			["unnamed before", /anthropic-account-3\s*$/m.test(before)],
			["named after, without restarting", after.includes("anthropic-account-3 (Night · night@example.com)")],
		]) {
			console.log(`  ${ok ? "PASS" : "FAIL"} ${label}`);
			if (!ok) failures++;
		}
		console.log();
	}

	await scenario("9. Unknown account", ["-p", "/switch-account 5"], (out, keys) => [
		["explains it is not logged in", /account 5 is not logged in/.test(out)],
		["no model request", keys.length === 0],
	]);

	// ---- pools ----------------------------------------------------------------------------------
	// Log in account 4 with an API key (D).
	const auth = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"));
	auth["anthropic-account-4"] = { type: "api_key", key: KEY_D };
	writeFileSync(join(dir, "auth.json"), JSON.stringify(auth));
	const models = JSON.parse(readFileSync(join(dir, "models.json"), "utf8"));
	models.providers["anthropic-account-4"] = { baseUrl: upstream };
	writeFileSync(join(dir, "models.json"), JSON.stringify(models));

	await scenario("10. The pools follow the logins", ["-p", "/pool"], (out, keys) => [
		["anthropic pool, automatic", /\nanthropic · default: Anthropic models no other pool claims · automatic/.test(out)],
		[
			"subscriptions by number, then the API key",
			/ 1\. anthropic +subscription\n +2\. anthropic-account-2 \(Work · work@example\.com\) +subscription · ● this session\n +3\. anthropic-account-3 \(Night · night@example\.com\) +subscription\n +4\. anthropic-account-4 +API key \(billed per token\)/.test(out),
		],
		["anthropic-search holds the API key only", /\nanthropic-search · anthropic_web_search \(claude-haiku-5-5, ≤5 searches\) · automatic\n +1\. anthropic-account-4 +API key/.test(out)],
		["this session's pool", /This session: anthropic-account-2 \(Work · work@example\.com\) · claude-opus-4-8 → pool "anthropic"/.test(out)],
		["no model request", keys.length === 0],
	]);

	limited.add(KEY_B);
	await scenario("11. Account 2 has run out: the request moves to account 3 by itself", ["-p", "hello"], (out, keys) => [
		["answered by token C", out.includes(`served by key ${KEY_C}`)],
		["tried B, then C", keys.join() === `${KEY_B},${KEY_C}`],
		["said so", /anthropic-account-2 \(Work · work@example\.com\) → anthropic-account-3 \(Night · night@example\.com\) \(rate_limit \(429\)\)\. This session now uses anthropic-account-3/.test(out)],
	]);
	limited.delete(KEY_B);

	await scenario("12. The session stays on account 3 (no return to account 2)", ["-p", "again"], (out, keys) => [
		["answered by token C only", keys.join() === KEY_C],
		["recorded in the session file", (() => {
			const changes = readFileSync(session, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.type === "model_change");
			return changes.at(-1)?.provider === "anthropic-account-3";
		})()],
	]);

	await scenario("13. /pool shows the cooldown and the next /switch-account next skips it", ["-p", "/pool", "/switch-account next"], (out, keys) => [
		["account 2 cooling ~2 minutes", /anthropic-account-2 \(Work · work@example\.com\) +subscription · cooling (1m5\ds|2m00s) \(rate_limit \(429\), claude-opus-4-8\)/.test(out)],
		["next from 3 goes to 4 (API key)", /switched anthropic-account-3 \(Night · night@example\.com\) → anthropic-account-4 · claude-opus-4-8 · thinking \w+ \(API key, billed per token\)/.test(out)],
		["no model request", keys.length === 0],
	]);

	await scenario("14. Next again wraps around and skips the cooling account 2", ["-p", "/switch-account next"], (out) => [
		["4 → 1 (2 is cooling)", /switched anthropic-account-4 → anthropic · /.test(out)],
	]);

	for (const k of [KEY_A, KEY_B, KEY_C, KEY_D]) limited.add(k);
	await scenario("15. Every account has run out: one clear error", ["-p", "try"], (out, keys) => [
		["explains, per account", /quota exceeded or unavailable on every account of pool "anthropic"/.test(out) && /anthropic-account-4: rate_limit \(429\), usable again in/.test(out)],
		["every account was tried, the cooling one last", keys.slice(0, 4).join() === `${KEY_A},${KEY_C},${KEY_D},${KEY_B}`],
	]);
	limited.clear();

	await scenario("16. Clear the cooldowns", ["-p", "/pool clear", "hi"], (out, keys) => [
		["cleared", /cleared 4 cooldown\(s\)/.test(out)],
		["account 1 answers again", keys.join() === KEY_A],
	]);

	await scenario(
		"17. Edit a pool: take the API key out of the chat pool, refuse a subscription in the search pool",
		["-p", "/pool remove anthropic anthropic-account-4", "/pool add anthropic-search anthropic-account-2", "/pool priority anthropic anthropic-account-3 0"],
		(out) => {
			const file = JSON.parse(readFileSync(join(dir, "multiple-account.json"), "utf8"));
			const members = file.pools?.anthropic?.members?.map((m) => `${m.priority}:${m.account}`).join(",");
			return [
				["removed", /removed anthropic-account-4 → pool "anthropic" \[default\]: 1\. anthropic, 2\. anthropic-account-2, 3\. anthropic-account-3/.test(out)],
				["subscription refused in the search pool", /anthropic-account-2 is a subscription login; anthropic-search only takes API keys/.test(out)],
				["saved with the new priority", members === "1:anthropic,2:anthropic-account-2,0:anthropic-account-3"],
				["names kept in the same file", file.accounts?.["anthropic-account-2"]?.name === "Work"],
				["the search pool still follows the logins", file.pools?.["anthropic-search"] === undefined],
			];
		},
	);

	await scenario("18. anthropic_web_search runs on the API key only", ["-p", "SEARCH:what is pi"], (out, keys, _u, searches, requests) => [
		["the tool is offered now", requests.some((r) => r.kind === "chat" && r.tools?.includes("anthropic_web_search"))],
		["searched with key D", searches.join() === KEY_D],
		["the answer reached the model", /GOT: Pi is a coding agent \(searched with key sk-ant-api03-fake-D\)\. Sources: 1\. Pi — https:\/\/pi\.dev/.test(out)],
		["chat stayed on the session's account", keys.every((k) => k === KEY_A)],
	]);

	{
		console.log("=== 19. Another open Pi window holds its account; /pool shows it (shared across windows)");
		const open = rpcSession();
		await open.ask("/pool"); // wait until it is up and holds its lease
		const { out } = await pi("-p", "/pool");
		open.close();
		const line = out.split("\n").find((l) => /^ +1\. anthropic /.test(l)) ?? "";
		console.log(`  | ${line}`);
		for (const [label, ok] of [["account 1 used by this session and another window", /● this session, another Pi window|another Pi window, ● this session/.test(line)]]) {
			console.log(`  ${ok ? "PASS" : "FAIL"} ${label}`);
			if (!ok) failures++;
		}
		console.log();
	}
} finally {
	server.close();
	if (KEEP) console.log(`Kept: ${dir}`);
	else rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

console.log(failures === 0 ? "All checks passed." : `${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
