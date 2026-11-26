/** Which account `/switch-account <arg>` means, and how accounts are shown. Pure. */
import { accountId, parseAccount } from "./slots.ts";

export interface AccountInfo {
	id: string;
	family: string;
	/** Account number: 1 for the family's own provider, 2+ for `<family>-account-N`. */
	n: number;
	label?: string;
}

export function accountInfos(ids: readonly string[], families: readonly string[], labels: Readonly<Record<string, string>>): AccountInfo[] {
	const out: AccountInfo[] = [];
	for (const id of ids) {
		const parsed = parseAccount(id, families);
		if (parsed) out.push({ id, family: parsed.family, n: parsed.n, ...(labels[id] ? { label: labels[id] } : {}) });
	}
	return out.sort((a, b) => a.family.localeCompare(b.family) || a.n - b.n);
}

/** "anthropic-account-2 (work)" */
export function describeAccount(account: AccountInfo): string {
	return account.label ? `${account.id} (${account.label})` : account.id;
}

export type Resolution = { ok: true; account: AccountInfo } | { ok: false; error: string };

/**
 * Resolve `arg` among the logged-in accounts of one family.
 *
 * Accepts the account id (`anthropic-account-2`), its number (`2`, `account-2`, `account 2`), its
 * label (case-insensitive), or `next` / `prev` relative to `current`.
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

	const byLabel = accounts.filter((a) => a.label?.toLowerCase() === text.toLowerCase());
	if (byLabel.length === 1) return { ok: true, account: byLabel[0]! };
	if (byLabel.length > 1) return { ok: false, error: `"${text}" labels ${byLabel.map((a) => a.id).join(" and ")}; use the account id` };

	return { ok: false, error: `no logged-in account "${text}". Logged in: ${names()}` };
}
