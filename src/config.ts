/**
 * Optional settings file, `<Pi config dir>/multiple-account.json`:
 *
 *   {
 *     "accounts": {
 *       "anthropic":           { "name": "Personal", "email": "me@example.com" },
 *       "anthropic-account-2": { "name": "Work",     "email": "me@company.com" }
 *     },
 *     "families": ["anthropic", "openai-codex"],
 *     "pools": { … }, "tools": { … }, "fallbackCooldownMinutes": 5, "maxCooldownMinutes": 60
 *   }
 *
 * `accounts` gives accounts a name and an email, shown in /login, /switch-account, /usage and /pool
 * (set them with /label-account). `families` chooses the providers that get extra accounts
 * (default: anthropic, openai-codex). The pool keys are described in pools.ts; they are kept as
 * written here and validated there. The 0.1 format `"labels": { "<account>": "<text>" }` is still
 * read, as the name. A missing or broken file reads as empty.
 */
import { POOL_KEYS, type PoolsRaw } from "./pools.ts";
import { DEFAULT_FAMILIES } from "./slots.ts";
import { writeFileAtomic } from "./state-file.ts";
import { readFileSync } from "node:fs";

/** What the user wrote down about an account. */
export interface AccountNote {
	name?: string;
	email?: string;
}

export interface Settings {
	accounts: Record<string, AccountNote>;
	families: string[];
	/** The pool part, as written in the file. */
	pools: PoolsRaw;
}

export function emptySettings(): Settings {
	return { accounts: {}, families: [...DEFAULT_FAMILIES], pools: {} };
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function readSettings(path: string): { settings: Settings; error?: string } {
	let raw: unknown;
	try {
		// Windows PowerShell 5.1 and some editors prepend a UTF-8 BOM.
		raw = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
	} catch (error) {
		const e = error as NodeJS.ErrnoException;
		if (e.code === "ENOENT") return { settings: emptySettings() };
		return {
			settings: emptySettings(),
			error: e instanceof SyntaxError ? `${path} is not valid JSON: ${e.message}` : `cannot read ${path}: ${e.message}`,
		};
	}
	const settings = emptySettings();
	const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

	// 0.1 format: labels become names
	if (obj.labels && typeof obj.labels === "object" && !Array.isArray(obj.labels)) {
		for (const [id, label] of Object.entries(obj.labels)) {
			const name = text(label);
			if (name) settings.accounts[id] = { name };
		}
	}
	if (obj.accounts && typeof obj.accounts === "object" && !Array.isArray(obj.accounts)) {
		for (const [id, value] of Object.entries(obj.accounts)) {
			if (!value || typeof value !== "object") continue;
			const note = value as Record<string, unknown>;
			const merged: AccountNote = { ...settings.accounts[id] };
			if (text(note.name)) merged.name = text(note.name);
			if (text(note.email)) merged.email = text(note.email);
			if (merged.name || merged.email) settings.accounts[id] = merged;
		}
	}
	if (Array.isArray(obj.families) && obj.families.every((f) => typeof f === "string" && f.length > 0)) {
		settings.families = [...new Set(obj.families as string[])];
	}
	for (const k of POOL_KEYS) if (obj[k] !== undefined) settings.pools[k] = obj[k];
	return { settings };
}

/** Write the whole file at once so a reader never sees it half-written. */
export function writeSettings(path: string, settings: Settings): void {
	const out: Record<string, unknown> = {};
	const accounts = Object.fromEntries(
		Object.entries(settings.accounts)
			.filter(([, note]) => note.name || note.email)
			.map(([id, note]) => [id, { ...(note.name ? { name: note.name } : {}), ...(note.email ? { email: note.email } : {}) }]),
	);
	if (Object.keys(accounts).length > 0) out.accounts = accounts;
	const defaults = [...DEFAULT_FAMILIES] as string[];
	if (settings.families.length !== defaults.length || settings.families.some((f, i) => f !== defaults[i])) {
		out.families = settings.families;
	}
	for (const k of POOL_KEYS) if (settings.pools[k] !== undefined) out[k] = settings.pools[k];
	writeFileAtomic(path, `${JSON.stringify(out, null, 2)}\n`);
}
