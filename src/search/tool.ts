/**
 * The anthropic_web_search tool: Anthropic's web search through the Messages API, run on the
 * API-key accounts of its pool ("anthropic-search" unless set otherwise). Subscription logins are
 * never used (that would mean presenting as Claude Code); they are skipped.
 */
import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CooldownTracker } from "../cooldown.ts";
import { type ResolvedPools, SEARCH_TOOL } from "../pools.ts";
import type { CooldownPolicy } from "../router.ts";
import { anthropicSearch } from "./anthropic.ts";
import { formatSearchResult } from "./format.ts";
import type { AccountCredentials, FetchFn } from "./http.ts";
import { runWithPool, type ToolAttemptLog } from "./run.ts";
import type { SearchResult } from "./types.ts";

export interface SearchToolRuntime {
	/** Current pools, or why there are none. */
	pools(): { pools: ResolvedPools } | { reason: string };
	cooldowns: CooldownTracker;
	/** Accounts to try for the pool, in order (priority, cooling ones last). */
	order(poolName: string, model: string): string[];
	fetch?: FetchFn;
}

export interface SearchDetails {
	account?: string;
	model?: string;
	queries?: string[];
	sources?: SearchResult["sources"];
	attempts: ToolAttemptLog[];
}

async function resolveAccount(ctx: ExtensionToolContext, account: string, model: string): Promise<AccountCredentials | undefined> {
	const provider = ctx.modelRegistry.getProvider(account);
	if (!provider) throw new Error(`provider "${account}" is not registered`);
	const resolved = await ctx.modelRegistry.getProviderAuth(account);
	if (!resolved) return undefined;
	// The model's endpoint includes models.json overrides; the provider's is the built-in default.
	const baseUrl = resolved.auth.baseUrl ?? ctx.modelRegistry.find(account, model)?.baseUrl ?? provider.baseUrl;
	if (!baseUrl) throw new Error(`provider "${account}" has no base URL`);
	return { apiKey: resolved.auth.apiKey, headers: resolved.auth.headers, baseUrl };
}

function errorResult(message: string, attempts: ToolAttemptLog[] = []) {
	return { content: [{ type: "text" as const, text: `${SEARCH_TOOL} failed: ${message}` }], details: { attempts } as SearchDetails, isError: true };
}

const PARAMS = Type.Object({
	query: Type.String({ description: "What to search for: a question or keywords, in any language." }),
	allowed_domains: Type.Optional(Type.Array(Type.String(), { description: 'Only search these domains (e.g. "docs.python.org"). Cannot be combined with blocked_domains.' })),
	blocked_domains: Type.Optional(Type.Array(Type.String(), { description: "Never search these domains. Cannot be combined with allowed_domains." })),
});

export function createSearchTool(runtime: SearchToolRuntime): ToolDefinition<typeof PARAMS, SearchDetails> {
	return {
		name: SEARCH_TOOL,
		label: "Anthropic web search",
		description: "Search the web with Anthropic's web search, using the Anthropic API-key accounts of its pool. Returns an answer with cited sources.",
		promptSnippet: "Search the web (Anthropic, API-key billing) and get a cited answer",
		parameters: PARAMS,
		async execute(_id, params, signal, onUpdate, ctx) {
			const loaded = runtime.pools();
			if (!("pools" in loaded)) return errorResult(loaded.reason);
			const tool = loaded.pools.search;
			if (!tool) return errorResult(loaded.pools.searchOff ? `turned off. Turn it on with: /pool tool ${SEARCH_TOOL} on` : "no Anthropic provider is set up");
			if (tool.pool.members.length === 0) {
				return errorResult(
					`pool "${tool.pool.name}" has no account yet. It needs an Anthropic API key: /login \u2192 a free "Anthropic (account N)" entry \u2192 API key (it joins "${tool.pool.name}" by itself)`,
				);
			}
			const fetchFn = runtime.fetch ?? fetch;
			const run = await runWithPool(
				{
					cooldowns: runtime.cooldowns,
					policy: loaded.pools,
					resolveAccount: (account) => resolveAccount(ctx, account, tool.model),
				},
				{ name: tool.pool.name, order: runtime.order(tool.pool.name, tool.model), modelKey: tool.model, tool: SEARCH_TOOL },
				(account, creds) => {
					onUpdate?.({ content: [{ type: "text", text: `Searching via ${account}\u2026` }], details: { account, attempts: [] } });
					return anthropicSearch(fetchFn, creds, {
						query: params.query,
						model: tool.model,
						maxSearches: tool.maxSearches,
						allowedDomains: params.allowed_domains,
						blockedDomains: params.blocked_domains,
						signal,
					});
				},
				signal,
			);
			if (!run.ok) return errorResult(run.error, run.attempts);
			return {
				content: [{ type: "text" as const, text: formatSearchResult(SEARCH_TOOL, run.account, tool.model, run.value) }],
				details: { account: run.account, model: tool.model, queries: run.value.queries, sources: run.value.sources, attempts: run.attempts },
			};
		},
	};
}
