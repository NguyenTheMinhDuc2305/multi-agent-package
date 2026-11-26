/**
 * Plan usage of subscription logins, for `/usage`.
 *
 *  - Anthropic (Claude Pro/Max/Team login): GET <api>/api/oauth/usage, the endpoint Claude Code's own
 *    /usage reads (5-hour session and weekly windows).
 *  - OpenAI Codex (ChatGPT login): GET <chatgpt backend>/wham/usage, the endpoint Codex CLI reads.
 *  - API keys have no plan windows (billed per token).
 *
 * Read-only requests; the token is only sent to the provider that issued it. Pure apart from the
 * injected fetch.
 */

export type FetchFn = typeof fetch;

export interface UsageWindow {
	/** "5h session", "7d weekly", … */
	label: string;
	/** 0–100 */
	usedPercent: number;
	/** Epoch ms of the reset, when known. */
	resetAt?: number;
}

export type UsageReport =
	| { status: "ok"; windows: UsageWindow[]; limitReached: boolean; plan?: string; email?: string }
	| { status: "api_key" }
	| { status: "error"; error: string; relogin: boolean };

export interface UsageRequest {
	family: string;
	/** The account's current access token / key, as Pi resolved it. */
	token: string;
	/** The provider's base URL (Anthropic API root, or ChatGPT backend for Codex). */
	baseUrl?: string;
	timeoutMs?: number;
}

const ANTHROPIC_BASE = "https://api.anthropic.com";
const CODEX_BASE = "https://chatgpt.com/backend-api";

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const pct = (v: unknown): number | undefined => {
	const n = num(v);
	return n === undefined ? undefined : Math.min(100, Math.max(0, n));
};
/** ISO string, epoch seconds or epoch ms → epoch ms. */
function epochMs(v: unknown): number | undefined {
	if (typeof v === "string" && v.trim()) {
		const parsed = Date.parse(v);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	const n = num(v);
	if (n === undefined || n <= 0) return undefined;
	return n < 10_000_000_000 ? n * 1000 : n;
}

function windowOf(label: string, source: unknown, usedKey: string, resetKey: string): UsageWindow | undefined {
	if (!source || typeof source !== "object") return undefined;
	const s = source as Record<string, unknown>;
	const usedPercent = pct(s[usedKey]);
	if (usedPercent === undefined) return undefined;
	const resetAt = epochMs(s[resetKey]);
	return { label, usedPercent, ...(resetAt !== undefined ? { resetAt } : {}) };
}

const PLAN: Record<string, string> = { plus: "Plus", pro: "Pro", team: "Team", business: "Business", enterprise: "Enterprise", free: "Free" };

export function parseAnthropicUsage(body: unknown): UsageReport | undefined {
	if (!body || typeof body !== "object") return undefined;
	const b = body as Record<string, unknown>;
	const windows = [
		windowOf("5h session", b.five_hour, "utilization", "resets_at"),
		windowOf("7d weekly", b.seven_day, "utilization", "resets_at"),
		windowOf("7d Opus", b.seven_day_opus, "utilization", "resets_at"),
		windowOf("7d Sonnet", b.seven_day_sonnet, "utilization", "resets_at"),
	].filter((w): w is UsageWindow => w !== undefined);
	if (windows.length === 0) return undefined;
	return { status: "ok", windows, limitReached: windows.some((w) => w.usedPercent >= 100) };
}

export function parseCodexUsage(body: unknown): UsageReport | undefined {
	if (!body || typeof body !== "object") return undefined;
	const b = body as Record<string, unknown>;
	const rl = (b.rate_limit && typeof b.rate_limit === "object" ? b.rate_limit : {}) as Record<string, unknown>;
	const windows = [
		windowOf("5h session", rl.primary_window, "used_percent", "reset_at"),
		windowOf("7d weekly", rl.secondary_window, "used_percent", "reset_at"),
	].filter((w): w is UsageWindow => w !== undefined);
	if (windows.length === 0 && typeof rl.limit_reached !== "boolean") return undefined;
	const plan = typeof b.plan_type === "string" ? (PLAN[b.plan_type.toLowerCase()] ?? b.plan_type) : undefined;
	const email = typeof b.email === "string" && b.email.includes("@") ? b.email : undefined;
	return {
		status: "ok",
		windows,
		limitReached: rl.limit_reached === true || rl.allowed === false || windows.some((w) => w.usedPercent >= 100),
		...(plan ? { plan } : {}),
		...(email ? { email } : {}),
	};
}

/** The ChatGPT account id is a claim inside the Codex access token (a JWT). */
export function codexAccountId(token: string): string | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	try {
		const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
		const id = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id;
		return typeof id === "string" && id ? id : undefined;
	} catch {
		return undefined;
	}
}

async function errorText(res: Response): Promise<string> {
	try {
		const body = await res.json();
		const message = body?.error?.message ?? body?.detail ?? body?.message;
		return typeof message === "string" ? message : "";
	} catch {
		return "";
	}
}

export async function fetchUsage(fetchFn: FetchFn, req: UsageRequest): Promise<UsageReport> {
	const timeout = AbortSignal.timeout(req.timeoutMs ?? 10_000);
	let url: string;
	const headers: Record<string, string> = { accept: "application/json", authorization: `Bearer ${req.token}` };
	let parse: (body: unknown) => UsageReport | undefined;

	if (req.family === "anthropic") {
		if (!req.token.startsWith("sk-ant-oat")) return { status: "api_key" };
		url = `${(req.baseUrl ?? ANTHROPIC_BASE).replace(/\/+$/, "").replace(/\/v1$/, "")}/api/oauth/usage`;
		headers["anthropic-beta"] = "oauth-2025-04-20";
		parse = parseAnthropicUsage;
	} else if (req.family === "openai-codex") {
		const accountId = codexAccountId(req.token);
		if (!accountId) return { status: "error", error: "the stored Codex login is not a ChatGPT token", relogin: true };
		url = `${(req.baseUrl ?? CODEX_BASE).replace(/\/+$/, "")}/wham/usage`;
		headers["chatgpt-account-id"] = accountId;
		parse = parseCodexUsage;
	} else {
		return { status: "error", error: `usage is not available for ${req.family}`, relogin: false };
	}

	let res: Response;
	try {
		res = await fetchFn(url, { headers, signal: timeout });
	} catch (error) {
		const name = (error as Error)?.name;
		return { status: "error", error: name === "TimeoutError" || name === "AbortError" ? "no answer (timed out)" : `request failed: ${(error as Error)?.message ?? error}`, relogin: false };
	}
	if (res.status === 401 || res.status === 403) {
		const detail = await errorText(res);
		return { status: "error", error: `login expired or revoked (HTTP ${res.status}${detail ? `: ${detail}` : ""})`, relogin: true };
	}
	if (!res.ok) {
		const detail = await errorText(res);
		return { status: "error", error: `HTTP ${res.status}${detail ? `: ${detail}` : ""}`, relogin: false };
	}
	const report = parse(await res.json().catch(() => undefined));
	return report ?? { status: "error", error: "the provider returned no usage windows", relogin: false };
}

// ---- formatting ---------------------------------------------------------------------------------

export interface UsageRow {
	id: string;
	/** "Work · me@company.com", or "" */
	note: string;
	report: UsageReport;
	/** /login entry to use when the login must be renewed. */
	loginEntry: string;
}

export interface UsageGroup {
	/** "Anthropic", "OpenAI Codex" */
	name: string;
	rows: UsageRow[];
}

export function formatDuration(ms: number): string {
	if (ms <= 0) return "now";
	const minutes = Math.ceil(ms / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
	return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function bar(percent: number): string {
	const filled = Math.round(percent / 10);
	return "\u2588".repeat(filled) + "\u2591".repeat(10 - filled);
}

export function formatUsage(groups: readonly UsageGroup[], current: string | undefined, now = Date.now()): string {
	const lines = ["Usage (\u25cf = this session)"];
	for (const group of groups) {
		lines.push("", group.name);
		if (group.rows.length === 0) lines.push("  (none logged in)");
		for (const row of group.rows) {
			const r = row.report;
			const extra = r.status === "ok" ? [r.plan, row.note ? "" : r.email].filter(Boolean).join(" · ") : "";
			const head = [row.id, row.note, extra].filter(Boolean).join(" · ");
			lines.push(`${row.id === current ? "\u25cf" : " "} ${head}`);
			if (r.status === "api_key") {
				lines.push("    API key: billed per token, no plan limits");
			} else if (r.status === "error") {
				lines.push(`    ${r.error}${r.relogin ? ` \u2192 /login \u2192 "${row.loginEntry}"` : ""}`);
			} else {
				for (const w of r.windows) {
					const reset = w.resetAt !== undefined ? ` \u00b7 resets in ${formatDuration(w.resetAt - now)}` : "";
					const full = w.usedPercent >= 100 ? "  \u2190 limit reached" : "";
					lines.push(`    ${w.label.padEnd(10)} ${bar(w.usedPercent)} ${String(Math.round(w.usedPercent)).padStart(3)}% used${reset}${full}`);
				}
				if (r.windows.length === 0 && r.limitReached) lines.push("    limit reached");
			}
		}
	}
	return lines.join("\n");
}
