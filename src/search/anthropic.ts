/**
 * Anthropic web search through the Messages API server tool, with an API key.
 *
 * Subscription OAuth tokens (sk-ant-oat…) are deliberately refused: using them outside Claude Code
 * means presenting as Claude Code, which this package does not do. Such accounts are skipped so
 * the pool moves on to the next (API-key) account.
 */
import { type AccountCredentials, type FetchFn, hasHeader, mergeHeaders, SkipAccount, throwIfNotOk, UpstreamError } from "./http.ts";
import { type SearchRequest, type SearchResult, SourceList } from "./types.ts";

export const ANTHROPIC_SEARCH_TOOL = "web_search_20260209";
const MAX_CONTINUATIONS = 3;

export interface AnthropicSearchRequest extends SearchRequest {
	maxSearches: number;
	allowedDomains?: string[];
	blockedDomains?: string[];
}

export function isSubscriptionToken(creds: AccountCredentials): boolean {
	if (creds.apiKey?.includes("sk-ant-oat")) return true;
	const auth = Object.entries(creds.headers ?? {}).find(([k]) => k.toLowerCase() === "authorization")?.[1];
	return typeof auth === "string" && auth.includes("sk-ant-oat");
}

export function messagesUrl(baseUrl: string): string {
	const base = baseUrl.replace(/\/+$/, "");
	return base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
}

export function buildAnthropicBody(req: AnthropicSearchRequest, messages: unknown[]): Record<string, unknown> {
	const tool: Record<string, unknown> = {
		type: ANTHROPIC_SEARCH_TOOL,
		name: "web_search",
		max_uses: req.maxSearches,
		allowed_callers: ["direct"],
	};
	if (req.allowedDomains?.length) tool.allowed_domains = req.allowedDomains;
	if (req.blockedDomains?.length) tool.blocked_domains = req.blockedDomains;
	return {
		model: req.model,
		max_tokens: 4096,
		system: "Answer the user's question using web search. Be concise and factual, and cite the sources you used.",
		messages,
		tools: [tool],
	};
}

interface Accumulator {
	text: string;
	cited: SourceList;
	results: SourceList;
	queries: string[];
	errors: string[];
	searchCount: number;
}

/** Fold one Messages API response into the accumulator. Pure. */
export function absorbAnthropicResponse(acc: Accumulator, response: any): void {
	for (const block of Array.isArray(response?.content) ? response.content : []) {
		if (block?.type === "text" && typeof block.text === "string") {
			acc.text += block.text;
			for (const c of Array.isArray(block.citations) ? block.citations : []) {
				if (c?.type === "web_search_result_location") acc.cited.add(c.url, c.title);
			}
		} else if (block?.type === "server_tool_use" && block.name === "web_search") {
			const q = block.input?.query;
			if (typeof q === "string" && !acc.queries.includes(q)) acc.queries.push(q);
		} else if (block?.type === "web_search_tool_result") {
			if (Array.isArray(block.content)) {
				for (const r of block.content) acc.results.add(r?.url, r?.title);
			} else if (block.content?.type === "web_search_tool_result_error") {
				acc.errors.push(String(block.content.error_code ?? "unknown_error"));
			}
		}
	}
	const n = response?.usage?.server_tool_use?.web_search_requests;
	if (typeof n === "number") acc.searchCount += n;
}

export async function anthropicSearch(
	fetchFn: FetchFn,
	creds: AccountCredentials,
	req: AnthropicSearchRequest,
): Promise<SearchResult> {
	if (isSubscriptionToken(creds)) {
		throw new SkipAccount("subscription OAuth login; anthropic_web_search only uses API keys");
	}
	if (req.allowedDomains?.length && req.blockedDomains?.length) {
		throw new Error("allowed_domains and blocked_domains cannot be used together");
	}
	const headers = mergeHeaders(
		{ "content-type": "application/json", "anthropic-version": "2023-06-01" },
		creds.headers,
	);
	if (creds.apiKey && !hasHeader(headers, "x-api-key") && !hasHeader(headers, "authorization")) {
		headers["x-api-key"] = creds.apiKey;
	}
	if (!hasHeader(headers, "x-api-key") && !hasHeader(headers, "authorization")) {
		throw new SkipAccount("no API key");
	}

	const acc: Accumulator = { text: "", cited: new SourceList(), results: new SourceList(), queries: [], errors: [], searchCount: 0 };
	const messages: unknown[] = [{ role: "user", content: req.query }];

	for (let turn = 0; ; turn++) {
		const response = await fetchFn(messagesUrl(creds.baseUrl), {
			method: "POST",
			headers,
			body: JSON.stringify(buildAnthropicBody(req, messages)),
			signal: req.signal,
		});
		await throwIfNotOk(response, "Anthropic");
		const json: any = await response.json();
		absorbAnthropicResponse(acc, json);
		// Long searches pause; sending the partial turn back lets the server continue it.
		if (json?.stop_reason === "pause_turn" && turn < MAX_CONTINUATIONS) {
			messages.push({ role: "assistant", content: json.content });
			continue;
		}
		break;
	}

	// Every search refused for rate reasons and nothing answered: let the pool try another key.
	if (!acc.text.trim() && acc.errors.length > 0 && acc.errors.every((e) => e === "too_many_requests")) {
		throw new UpstreamError("web search rate limited (too_many_requests)", 429);
	}

	const sources = new SourceList();
	for (const s of [...acc.cited.list(), ...acc.results.list()]) sources.add(s.url, s.title);
	return {
		text: acc.text.trim(),
		sources: sources.list(),
		queries: acc.queries,
		warnings: [...new Set(acc.errors)],
		searchCount: acc.searchCount || undefined,
	};
}
