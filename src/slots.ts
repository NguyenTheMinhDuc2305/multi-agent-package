/**
 * Account ids, following pi-multi-account's naming:
 *
 *   anthropic             account 1 = Pi's own login for the provider
 *   anthropic-account-2   account 2, its own Pi provider and its own token in auth.json
 *   anthropic-account-3   …
 *
 * A "family" is the built-in provider the accounts belong to (anthropic, openai-codex).
 * Pure helpers; the extension supplies who is logged in.
 */

export const DEFAULT_FAMILIES = ["anthropic", "openai-codex"] as const;
export const MAX_ACCOUNTS = 20;

export function accountId(family: string, n: number): string {
	return n <= 1 ? family : `${family}-account-${n}`;
}

/** `anthropic-account-3` → { family: "anthropic", n: 3 }; `anthropic` → n 1; anything else undefined. */
export function parseAccount(id: string, families: readonly string[]): { family: string; n: number } | undefined {
	if (families.includes(id)) return { family: id, n: 1 };
	const m = /^(.+)-account-(\d+)$/.exec(id);
	if (!m || !families.includes(m[1]!)) return undefined;
	const n = Number(m[2]);
	return n >= 2 && n <= MAX_ACCOUNTS && String(n) === m[2] ? { family: m[1]!, n } : undefined;
}

export function familyOf(id: string | undefined, families: readonly string[]): string | undefined {
	return id === undefined ? undefined : parseAccount(id, families)?.family;
}

/** Account ids among `ids` that belong to `family`, by account number (account 1 first). */
export function accountsOf(family: string, ids: Iterable<string>, families: readonly string[]): string[] {
	const out: Array<{ id: string; n: number }> = [];
	for (const id of new Set(ids)) {
		const parsed = parseAccount(id, families);
		if (parsed?.family === family) out.push({ id, n: parsed.n });
	}
	return out.sort((a, b) => a.n - b.n).map((a) => a.id);
}

/** Lowest unused extra account (≥ 2) of `family`, or undefined when all MAX_ACCOUNTS are used. */
export function nextFreeAccount(family: string, taken: Iterable<string>, families: readonly string[]): string | undefined {
	const used = new Set<number>();
	for (const id of taken) {
		const parsed = parseAccount(id, families);
		if (parsed?.family === family) used.add(parsed.n);
	}
	for (let n = 2; n <= MAX_ACCOUNTS; n++) if (!used.has(n)) return accountId(family, n);
	return undefined;
}
