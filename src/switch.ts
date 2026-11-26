/** Which account `/switch-account <arg>` means, and how accounts are shown. Pure. */
import type { AccountNote } from "./config.ts";
import { accountId, parseAccount } from "./slots.ts";

export interface AccountInfo {
	id: string;
	family: string;
	/** Account number: 1 for the family's own provider, 2+ for `<family>-account-N`. */
	n: number;
	name?: string;
	email?: string;
}

export function accountInfos(ids: readonly string[], families: readonly string[], notes: Readonly<Record<string, AccountNote>>): AccountInfo[] {
	const out: AccountInfo[] = [];
	for (const id of ids) {
		const parsed = parseAccount(id, families);
		if (!parsed) continue;
		const note = notes[id] ?? {};
		out.push({ id, family: parsed.family, n: parsed.n, ...(note.name ? { name: note.name } : {}), ...(note.email ? { email: note.email } : {}) });
	}
	return out.sort((a, b) => a.family.localeCompare(b.family) || a.n - b.n);
}

/** "Work · me@company.com", "Work", "me@company.com" or "" */
export function noteText(note: AccountNote | AccountInfo): string {
	return [note.name, note.email].filter(Boolean).join(" · ");
}

/** "anthropic-account-2 (Work · me@company.com)" */
export function describeAccount(account: AccountInfo): string {
	const note = noteText(account);
	return note ? `${account.id} (${note})` : account.id;
}

export type Resolution = { ok: true; account: AccountInfo } | { ok: false; error: string };

/**
 * Resolve `arg` among the logged-in accounts of one family.
 *
 * Accepts the account id (`anthropic-account-2`), its number (`2`, `account-2`, `account 2`), its
 * name or email (case-insensitive), or `next` / `prev` relative to `current`.
 */
export function resolveTarget(arg: string, accounts: readonly AccountInfo[], current: string | undefined): Resolution {
	const text = arg.trim();
	const family = accounts[0]?.family;
	const names = () => accounts.map(describeAccount).join(", ") || "(none)";
	if (accounts.length === 0 || family === undefined) return { ok: false, error: "no account of this provider is logged in" };

	if (text === "next" || text === "prev") {
		if (accounts.length < 2) return { ok: false, error: `only one account is logged in (${names()}); add another with /login` };
		const index = accounts.findIndex((a) => a.id === current);
		const step = text === "next" ? 1 : -1;
		const from = index < 0 ? (text === "next" ? -1 : 0) : index;
		return { ok: true, account: accounts[(from + step + accounts.length) % accounts.length]! };
	}

	const byId = accounts.find((a) => a.id === text);
	if (byId) return { ok: true, account: byId };

	const number = /^(?:account[-\s]?)?(\d+)$/i.exec(text)?.[1];
	if (number !== undefined) {
		const id = accountId(family, Number(number));
		const match = accounts.find((a) => a.id === id);
		return match ? { ok: true, account: match } : { ok: false, error: `account ${number} is not logged in. Logged in: ${names()}` };
	}

	const lower = text.toLowerCase();
	const byNote = accounts.filter((a) => a.name?.toLowerCase() === lower || a.email?.toLowerCase() === lower);
	if (byNote.length === 1) return { ok: true, account: byNote[0]! };
	if (byNote.length > 1) return { ok: false, error: `"${text}" matches ${byNote.map((a) => a.id).join(" and ")}; use the account id` };

	return { ok: false, error: `no logged-in account "${text}". Logged in: ${names()}` };
}
