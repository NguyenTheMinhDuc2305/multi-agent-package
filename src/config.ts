/**
 * Optional settings file, `<Pi config dir>/multiple-account.json`:
 *
 *   {
 *     "labels": { "anthropic": "personal", "anthropic-account-2": "work" },
 *     "families": ["anthropic", "openai-codex"]
 *   }
 *
 * `labels` names accounts in /login, /switch-account and the footer. `families` chooses the providers
 * that get extra accounts (default: anthropic, openai-codex). A missing or broken file reads as empty.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_FAMILIES } from "./slots.ts";

export interface Settings {
	labels: Record<string, string>;
	families: string[];
}

export function emptySettings(): Settings {
	return { labels: {}, families: [...DEFAULT_FAMILIES] };
}

export function readSettings(path: string): { settings: Settings; error?: string } {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { settings: emptySettings() };
		return { settings: emptySettings(), error: `cannot read ${path}: ${(error as Error).message}` };
	}
	let raw: unknown;
	try {
		// Windows PowerShell 5.1 and some editors prepend a UTF-8 BOM.
		raw = JSON.parse(text.replace(/^\uFEFF/, ""));
	} catch (error) {
		return { settings: emptySettings(), error: `${path} is not valid JSON: ${(error as Error).message}` };
	}
	const settings = emptySettings();
	const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	if (obj.labels && typeof obj.labels === "object" && !Array.isArray(obj.labels)) {
		for (const [id, label] of Object.entries(obj.labels)) {
			if (typeof label === "string" && label.trim()) settings.labels[id] = label.trim();
		}
	}
	if (Array.isArray(obj.families) && obj.families.every((f) => typeof f === "string" && f.length > 0)) {
		settings.families = [...new Set(obj.families as string[])];
	}
	return { settings };
}

/** Write the whole file at once so a reader never sees it half-written. */
export function writeSettings(path: string, settings: Settings): void {
	const out: Record<string, unknown> = {};
	if (Object.keys(settings.labels).length > 0) out.labels = settings.labels;
	const defaults = [...DEFAULT_FAMILIES] as string[];
	if (settings.families.length !== defaults.length || settings.families.some((f, i) => f !== defaults[i])) {
		out.families = settings.families;
	}
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`);
	try {
		renameSync(tmp, path);
	} catch (error) {
		try {
			unlinkSync(tmp);
		} catch {
			// ignore
		}
		throw error;
	}
}
