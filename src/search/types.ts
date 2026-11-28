export interface SearchSource {
	title: string;
	url: string;
}

export interface SearchResult {
	/** The provider's answer, as written. */
	text: string;
	/** Cited sources first, then the remaining search results; deduplicated by URL. */
	sources: SearchSource[];
	/** Queries the provider actually ran. */
	queries: string[];
	/** Provider-side search errors that did not fail the call (e.g. max_uses_exceeded). */
	warnings: string[];
	/** Billable searches, when the provider reports them. */
	searchCount?: number;
}

export interface SearchRequest {
	query: string;
	model: string;
	signal?: AbortSignal;
}

export class SourceList {
	#byUrl = new Map<string, SearchSource>();
	add(url: unknown, title: unknown): void {
		if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return;
		if (this.#byUrl.has(url)) return;
		this.#byUrl.set(url, { url, title: typeof title === "string" && title.trim() ? title.trim() : url });
	}
	list(): SearchSource[] {
		return [...this.#byUrl.values()];
	}
}
