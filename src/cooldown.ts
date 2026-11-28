/**
 * Cooldowns: accounts that hit a limit (or lost their login), and until when. Shared by every Pi
 * process on the machine through a state store (see state-file.ts), so an account that ran out in
 * one window or agent is skipped by all the others instead of each re-learning it with a failed
 * request.
 *
 * Keyed by (account, model). Account-wide failures (revoked login, billing) use the wildcard model
 * key and block every model of that account.
 */

export const ANY_MODEL = "*";

export interface CooldownEntry {
	account: string;
	/** Model id, or ANY_MODEL for account-wide. */
	model: string;
	until: number;
	reason: string;
	/** Consecutive failures without a success in between. Drives escalation. */
	failures: number;
}

/** Plain serialisable state: what the store persists. */
export interface CooldownState {
	entries: Record<string, CooldownEntry>;
	/** Consecutive-failure counters; outlive the entry so escalation survives expiry. */
	failures: Record<string, number>;
}

export interface CooldownStore {
	/** Latest persisted state, or undefined when nothing changed since the last read. */
	readIfChanged(): CooldownState | undefined;
	/** Read-modify-write the persisted state; returns the state that was written. */
	update(mutate: (state: CooldownState) => void): CooldownState;
}

export function emptyCooldowns(): CooldownState {
	return { entries: {}, failures: {} };
}

const key = (account: string, model: string) => `${account}\0${model}`;

export class CooldownTracker {
	#state: CooldownState = emptyCooldowns();
	#now: () => number;
	#store: CooldownStore | undefined;

	constructor(options: { now?: () => number; store?: CooldownStore } = {}) {
		this.#now = options.now ?? Date.now;
		this.#store = options.store;
		this.#sync();
	}

	#sync(): void {
		const latest = this.#store?.readIfChanged();
		if (latest) this.#state = latest;
	}

	#mutate(mutate: (state: CooldownState) => void): void {
		const now = this.#now();
		const apply = (state: CooldownState) => {
			mutate(state);
			prune(state, now);
		};
		if (this.#store) this.#state = this.#store.update(apply);
		else apply(this.#state);
	}

	/** Next cooldown for repeated failures without a server hint: base * 2^(n-1), capped. */
	nextBackoff(account: string, model: string, baseMs: number, maxMs: number): number {
		this.#sync();
		const n = (this.#state.failures[key(account, model)] ?? 0) + 1;
		return Math.min(maxMs, baseMs * 2 ** (n - 1));
	}

	mark(account: string, model: string, durationMs: number, reason: string): CooldownEntry {
		const k = key(account, model);
		let entry!: CooldownEntry;
		this.#mutate((state) => {
			const failures = (state.failures[k] ?? 0) + 1;
			state.failures[k] = failures;
			entry = { account, model, until: this.#now() + durationMs, reason, failures };
			state.entries[k] = entry;
		});
		return entry;
	}

	/** Active cooldown affecting (account, model): an account-wide entry wins if it lasts longer. */
	get(account: string, model: string): CooldownEntry | undefined {
		this.#sync();
		const now = this.#now();
		let best: CooldownEntry | undefined;
		for (const m of [model, ANY_MODEL]) {
			const entry = this.#state.entries[key(account, m)];
			if (!entry || entry.until <= now) continue;
			if (!best || entry.until > best.until) best = entry;
		}
		return best;
	}

	/** A successful request resets escalation for that (account, model) and any account-wide mark. */
	success(account: string, model: string): void {
		const keys = [key(account, model), key(account, ANY_MODEL)];
		this.#sync();
		// Skip the write (and file churn) when there is nothing to clear.
		if (!keys.some((k) => k in this.#state.entries || k in this.#state.failures)) return;
		this.#mutate((state) => {
			for (const k of keys) {
				delete state.entries[k];
				delete state.failures[k];
			}
		});
	}

	/** Active entries, soonest-to-expire first. */
	list(): CooldownEntry[] {
		this.#sync();
		const now = this.#now();
		return Object.values(this.#state.entries)
			.filter((e) => e.until > now)
			.sort((a, b) => a.until - b.until);
	}

	/** Forget cooldowns (of one account, or all); returns how many active ones were removed. */
	clear(account?: string): number {
		const now = this.#now();
		let removed = 0;
		this.#mutate((state) => {
			removed = 0;
			for (const [k, entry] of Object.entries(state.entries)) {
				if (account === undefined || entry.account === account) {
					if (entry.until > now) removed++;
					delete state.entries[k];
				}
			}
			for (const k of Object.keys(state.failures)) {
				if (account === undefined || k.startsWith(`${account}\0`)) delete state.failures[k];
			}
		});
		return removed;
	}
}

/**
 * Forget entries a day after they expired, together with their failure counter. Until then an
 * expired entry is inert (reads ignore it) but keeps escalation alive for a flaky account.
 */
function prune(state: CooldownState, now: number): void {
	const DAY = 24 * 60 * 60_000;
	for (const [k, entry] of Object.entries(state.entries)) {
		if (entry.until + DAY <= now) {
			delete state.entries[k];
			delete state.failures[k];
		}
	}
}
