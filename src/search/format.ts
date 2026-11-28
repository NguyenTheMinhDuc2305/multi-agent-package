/** Model-facing text of a search result. */
import type { SearchResult } from "./types.ts";

const MAX_SOURCES = 15;

export function formatSearchResult(tool: string, account: string, model: string, result: SearchResult): string {
	const lines: string[] = [];
	lines.push(result.text || "(The provider returned no answer text.)");
	if (result.sources.length > 0) {
		lines.push("", "Sources:");
		result.sources.slice(0, MAX_SOURCES).forEach((s, i) => lines.push(`${i + 1}. ${s.title} — ${s.url}`));
		if (result.sources.length > MAX_SOURCES) lines.push(`… ${result.sources.length - MAX_SOURCES} more`);
	}
	const meta = [`${tool} via ${account}`, model];
	if (result.queries.length > 0) meta.push(`queries: ${result.queries.map((q) => JSON.stringify(q)).join(", ")}`);
	if (result.searchCount !== undefined) meta.push(`${result.searchCount} search(es)`);
	if (result.warnings.length > 0) meta.push(`warnings: ${result.warnings.join(", ")}`);
	lines.push("", `[${meta.join(" · ")}]`);
	return lines.join("\n");
}
