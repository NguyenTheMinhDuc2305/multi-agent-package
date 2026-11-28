/**
 * Who uses which account right now, across every Pi process on the machine (shared state file).
 *
 * A lease is held per session id: the main session of each Pi window holds the account of its
 * current model; an agent holds the account it was given for the length of its run. Agents use
 * this to spread over the accounts nobody else is using.
 *
 * A lease goes away when it is released, when its process is gone, or when its heartbeat is older
 * than LEASE_STALE_MS (a crashed or killed Pi).
 *
 * `last` remembers, per owner (e.g. an agent), the account it used last, so its next run can stay
 * on it while it is free (its prompt cache lives there).
 */

export const LEASE_STALE_MS = 3 * 60_000;
export const HEARTBEAT_MS = 60_000;
const LAST_TTL_MS = 30 * 24 * 60 * 60_000;

export interface Lease {
	account: string;
	kind: "main" | "agent";
	/** "main session", "agent scout" … */
	label: string;
	pid: number;
	heartbeat: number;
}

export interface LeaseState {
	leases: Record<string, Lease>;
	last: Record<string, { account: string; at: number }>;
}

export interface LeaseStore {
	readIfChanged(): LeaseState | undefined;
	update(mutate: (state: LeaseState) => void): LeaseState;
}

export function emptyLeases(): LeaseState {
	return { leases: {}, last: {} };
}

/** Whether a process exists (signal 0 checks without signalling). */
export function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export interface LeaseHolder {
	key: string;
	lease: Lease;
}

export class LeaseBook {
	#state: LeaseState = emptyLeases();
	#store: LeaseStore | undefined;
	#now: () => number;
	#alive: (pid: number) => boolean;

	constructor(options: { store?: LeaseStore; now?: () => number; isAlive?: (pid: number) => boolean } = {}) {
		this.#store = options.store;
		this.#now = options.now ?? Date.now;
		this.#alive = options.isAlive ?? processAlive;
		this.#sync();
	}

	#sync(): void {
		const latest = this.#store?.readIfChanged();
		if (latest) this.#state = latest;
	}

	#stale(lease: Lease, now: number): boolean {
		return now - lease.heartbeat > LEASE_STALE_MS || !this.#alive(lease.pid);
	}

	#mutate(mutate: (state: LeaseState) => void): void {
		const now = this.#now();
		const apply = (state: LeaseState) => {
			mutate(state);
			for (const [key, lease] of Object.entries(state.leases)) if (this.#stale(lease, now)) delete state.leases[key];
			for (const [owner, last] of Object.entries(state.last)) if (now - last.at > LAST_TTL_MS) delete state.last[owner];
		};
		if (this.#store) this.#state = this.#store.update(apply);
		else apply(this.#state);
	}

	/** Hold (or move) the lease of `key`. Skips the write when nothing changed. */
	hold(key: string, lease: Omit<Lease, "heartbeat">): void {
		this.#sync();
		const current = this.#state.leases[key];
		if (current && current.account === lease.account && current.kind === lease.kind && current.label === lease.label && current.pid === lease.pid) {
			if (this.#now() - current.heartbeat < HEARTBEAT_MS) return;
		}
		this.#mutate((state) => {
			state.leases[key] = { ...lease, heartbeat: this.#now() };
		});
	}

	/** Drop the lease of `key`; with `owner`, remember its account as the owner's last one. */
	release(key: string, owner?: string): void {
		this.#sync();
		if (!this.#state.leases[key] && !owner) return;
		this.#mutate((state) => {
			const lease = state.leases[key];
			if (lease && owner) state.last[owner] = { account: lease.account, at: this.#now() };
			delete state.leases[key];
		});
	}

	/** Refresh the heartbeat of these leases (the ones this process holds). */
	touch(keys: readonly string[]): void {
		if (keys.length === 0) return;
		this.#mutate((state) => {
			for (const key of keys) {
				const lease = state.leases[key];
				if (lease) lease.heartbeat = this.#now();
			}
		});
	}

	get(key: string): Lease | undefined {
		this.#sync();
		const lease = this.#state.leases[key];
		return lease && !this.#stale(lease, this.#now()) ? lease : undefined;
	}

	/** Live leases. */
	holders(): LeaseHolder[] {
		this.#sync();
		const now = this.#now();
		return Object.entries(this.#state.leases)
			.filter(([, lease]) => !this.#stale(lease, now))
			.map(([key, lease]) => ({ key, lease }));
	}

	/** How many live leases use `account`, not counting `exceptKey`. */
	users(account: string, exceptKey?: string): number {
		return this.holders().filter((h) => h.lease.account === account && h.key !== exceptKey).length;
	}

	/** The account `owner` used last, if remembered. */
	last(owner: string): string | undefined {
		this.#sync();
		return this.#state.last[owner]?.account;
	}
}
