/**
 * Small JSON state files shared by every Pi process on this machine (each open Pi window, `pi -p`
 * runs, and the agents they start):
 *
 *   multiple-account-cooldowns.json   accounts that hit a limit, and until when
 *   multiple-account-leases.json      which session or agent uses which account right now
 *
 * - Reads are cheap: the file is re-parsed only when its mtime/size changed.
 * - Writes are read-modify-write with an atomic replace (temp file + rename), so a reader never
 *   sees a half-written file. Two processes writing at the same instant can lose one update; the
 *   state is advisory: a lost update can affect cooldowns, occupancy display or account affinity.
 * - A missing or corrupt file reads as empty state; it is never a fatal error.
 */
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type CooldownState, type CooldownStore, emptyCooldowns } from "./cooldown.ts";

export interface JsonStoreOptions<T> {
	version: number;
	empty: () => T;
	/** The state inside a parsed file, or undefined when it does not look right. */
	parse: (raw: Record<string, unknown>) => T | undefined;
}

export class JsonFileStore<T> {
	#path: string;
	#seen: string | undefined; // "mtimeMs:size" of the last read/write
	#options: JsonStoreOptions<T>;

	constructor(path: string, options: JsonStoreOptions<T>) {
		this.#path = path;
		this.#options = options;
	}

	get path(): string {
		return this.#path;
	}

	#stamp(): string | undefined {
		try {
			const s = statSync(this.#path);
			return `${s.mtimeMs}:${s.size}`;
		} catch {
			return undefined;
		}
	}

	read(): T {
		try {
			const raw = JSON.parse(readFileSync(this.#path, "utf8").replace(/^\uFEFF/, ""));
			if (!raw || typeof raw !== "object" || raw.version !== this.#options.version) return this.#options.empty();
			return this.#options.parse(raw) ?? this.#options.empty();
		} catch {
			return this.#options.empty();
		}
	}

	readIfChanged(): T | undefined {
		const stamp = this.#stamp();
		if (stamp === this.#seen) return undefined;
		this.#seen = stamp;
		return stamp === undefined ? this.#options.empty() : this.read();
	}

	update(mutate: (state: T) => void): T {
		const state = this.read();
		mutate(state);
		writeFileAtomic(this.#path, `${JSON.stringify({ version: this.#options.version, ...state }, null, 1)}\n`, 0o600);
		this.#seen = this.#stamp();
		return state;
	}
}

const isRecord = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

export function cooldownStore(path: string): CooldownStore & { path: string } {
	return new JsonFileStore<CooldownState>(path, {
		version: 1,
		empty: emptyCooldowns,
		parse: (raw) => (isRecord(raw.entries) && isRecord(raw.failures) ? { entries: raw.entries, failures: raw.failures } : undefined),
	});
}

/** Write a whole file so readers never see it half-written (temp file + rename). */
export function writeFileAtomic(path: string, text: string, mode?: number): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
	writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
	replaceWithRetry(tmp, path);
}

/** Windows refuses to replace a file another process has open for a moment; retry briefly. */
function replaceWithRetry(from: string, to: string): void {
	for (let attempt = 0; ; attempt++) {
		try {
			renameSync(from, to);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (attempt < 10 && (code === "EPERM" || code === "EBUSY" || code === "EACCES")) {
				const until = Date.now() + 15 * (attempt + 1);
				while (Date.now() < until) {
					// short synchronous back-off; writes are rare
				}
				continue;
			}
			try {
				unlinkSync(from);
			} catch {
				// ignore
			}
			throw error;
		}
	}
}
