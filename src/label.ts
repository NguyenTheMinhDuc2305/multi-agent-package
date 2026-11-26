/** Arguments of `/label-account`. Pure. */
import { accountId, parseAccount } from "./slots.ts";
import type { AccountInfo } from "./switch.ts";

export type LabelArgs =
	/** Show the current name/email of an account (no change). */
	| { kind: "show"; account: string }
	| { kind: "set"; account: string; name?: string; email?: string }
	| { kind: "clear"; account: string }
	| { kind: "error"; error: string };

export const LABEL_USAGE = [
	"/label-account                                   pick an account and type its name and email",
	"/label-account <account> <name> [email]          e.g. /label-account anthropic-account-2 Work me@company.com",
	"/label-account <account> name <text>             set only the name",
	"/label-account <account> email <address>         set only the email",
	"/label-account <account> clear                   forget both",
].join("\n");

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const isEmail = (text: string): boolean => EMAIL.test(text);

/**
 * Which account `/label-account <arg>` means: its id, a number of the current session's provider
 * (`2`, `account-2`), or an existing name/email. Any valid slot id is accepted, logged in or not, so
 * an account can be named before or after its login.
 */
export function resolveLabelAccount(
	arg: string,
	known: readonly AccountInfo[],
	families: readonly string[],
	currentFamily: string | undefined,
): { ok: true; id: string } | { ok: false; error: string } {
	if (parseAccount(arg, families)) return { ok: true, id: arg };
	const number = /^(?:account[-\s]?)?(\d+)$/i.exec(arg)?.[1];
	if (number !== undefined) {
		if (!currentFamily) return { ok: false, error: `"${arg}" is ambiguous here; use the account id, e.g. ${families.map((f) => accountId(f, Number(number))).join(" or ")}` };
		return { ok: true, id: accountId(currentFamily, Number(number)) };
	}
	const lower = arg.toLowerCase();
	const matches = known.filter((a) => a.name?.toLowerCase() === lower || a.email?.toLowerCase() === lower);
	if (matches.length === 1) return { ok: true, id: matches[0]!.id };
	if (matches.length > 1) return { ok: false, error: `"${arg}" matches ${matches.map((a) => a.id).join(" and ")}; use the account id` };
	return { ok: false, error: `"${arg}" is not an account (e.g. ${families.map((f) => `${f}, ${f}-account-2`).join("; ")})` };
}

/**
 * `<account> <words…>`: a word that looks like an email is the email, the other words are the name.
 * `name <text>` / `email <address>` set one field only; `clear` forgets both.
 */
export function parseLabelArgs(argv: readonly string[]): LabelArgs {
	const [account, ...rest] = argv;
	if (!account) return { kind: "error", error: `usage:\n${LABEL_USAGE}` };
	if (rest.length === 0) return { kind: "show", account };
	if (rest.length === 1 && rest[0]!.toLowerCase() === "clear") return { kind: "clear", account };

	const field = rest[0]!.toLowerCase();
	if (field === "name" && rest.length > 1) return { kind: "set", account, name: rest.slice(1).join(" ") };
	if (field === "email" && rest.length > 1) {
		const email = rest.slice(1).join("").trim();
		return isEmail(email) ? { kind: "set", account, email } : { kind: "error", error: `"${email}" is not an email address` };
	}

	const emails = rest.filter(isEmail);
	if (emails.length > 1) return { kind: "error", error: "give at most one email address" };
	const malformed = rest.find((w) => w.includes("@") && !isEmail(w));
	if (malformed) return { kind: "error", error: `"${malformed}" is not an email address` };
	const name = rest.filter((w) => !isEmail(w)).join(" ").trim();
	return { kind: "set", account, ...(name ? { name } : {}), ...(emails[0] ? { email: emails[0] } : {}) };
}
