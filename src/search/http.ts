/** Small HTTP helpers for the search clients. No Pi imports. */

export type FetchFn = typeof fetch;

/** Credentials of one account as Pi resolved them. */
export interface AccountCredentials {
	apiKey?: string;
	headers?: Record<string, string | null>;
	/** Endpoint root for this account (credential-specific, else the provider's). */
	baseUrl: string;
}

/** An upstream failure the pool runner can classify (status may be missing for in-stream errors). */
export class UpstreamError extends Error {
	readonly status?: number;
	readonly headers?: Record<string, string>;
	constructor(message: string, status?: number, headers?: Record<string, string>) {
		super(message);
		this.name = "UpstreamError";
		this.status = status;
		this.headers = headers;
	}
}

/** The account cannot be used for this tool (wrong credential kind); try the next one, no cooldown. */
export class SkipAccount extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SkipAccount";
	}
}

export function headersToObject(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	headers.forEach((value, name) => {
		out[name.toLowerCase()] = value;
	});
	return out;
}

/** Copy non-null header values; later sources override earlier ones (case-insensitive). */
export function mergeHeaders(...sources: Array<Record<string, string | null> | undefined>): Record<string, string> {
	const out = new Map<string, [string, string]>();
	for (const source of sources) {
		if (!source) continue;
		for (const [name, value] of Object.entries(source)) {
			if (value === null) out.delete(name.toLowerCase());
			else out.set(name.toLowerCase(), [name, value]);
		}
	}
	return Object.fromEntries([...out.values()]);
}

export function hasHeader(headers: Record<string, string>, name: string): boolean {
	return Object.keys(headers).some((k) => k.toLowerCase() === name.toLowerCase());
}

export async function throwIfNotOk(response: Response, label: string): Promise<void> {
	if (response.ok) return;
	let body = "";
	try {
		body = await response.text();
	} catch {
		// ignore
	}
	throw new UpstreamError(`${label} API error (${response.status}): ${body.slice(0, 500)}`, response.status, headersToObject(response.headers));
}

/**
 * Parse a server-sent-event body and call `onEvent` with each JSON `data:` payload.
 * Return `true` from `onEvent` to stop reading early.
 */
export async function readSse(
	response: Response,
	onEvent: (data: any) => boolean | void,
	signal?: AbortSignal,
): Promise<void> {
	if (!response.body) throw new UpstreamError("empty response body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const flush = (block: string): boolean => {
		const data = block
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n");
		if (!data || data === "[DONE]") return false;
		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch {
			return false; // keep-alives and comments
		}
		return onEvent(parsed) === true;
	};
	try {
		while (true) {
			if (signal?.aborted) throw signal.reason ?? new Error("aborted");
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let index: number;
			while ((index = buffer.search(/\r?\n\r?\n/)) >= 0) {
				const block = buffer.slice(0, index);
				buffer = buffer.slice(index).replace(/^\r?\n\r?\n/, "");
				if (flush(block)) return;
			}
		}
		if (buffer.trim()) flush(buffer);
	} finally {
		reader.cancel().catch(() => {});
	}
}
