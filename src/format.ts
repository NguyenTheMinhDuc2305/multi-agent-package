/** Text for `/switch-account list`. Pure. */
import { type AccountInfo, describeAccount } from "./switch.ts";

export interface FamilyView {
	family: string;
	/** Display name of the provider ("Anthropic"). */
	name: string;
	loggedIn: AccountInfo[];
	/** How the next free account appears in /login, when there is one. */
	nextLogin?: string;
}

export function formatList(views: readonly FamilyView[], current: string | undefined): string {
	const lines = ["Accounts (● = in use by this session):"];
	for (const view of views) {
		lines.push("", `${view.name}`);
		if (view.loggedIn.length === 0) lines.push("  (none logged in)");
		for (const account of view.loggedIn) {
			lines.push(`  ${account.id === current ? "●" : " "} ${describeAccount(account)}`);
		}
		if (view.nextLogin) lines.push(`  add another: /login → "${view.nextLogin}"`);
	}
	lines.push("", "Switch: /switch-account [account | number | name | email | next]  ·  Name: /label-account  ·  Usage: /usage");
	return lines.join("\n");
}
