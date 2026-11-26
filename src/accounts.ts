/**
 * One Pi provider per extra account, cloned from the built-in provider of its family.
 *
 * Each clone has its own id (`anthropic-account-2`), so Pi gives it its own `/login` entry, its own
 * token in auth.json and its own token refresh. Unlike a hidden alias it also publishes the family's
 * models under its own id (`anthropic-account-2/claude-opus-…`): switching account is then an
 * ordinary model selection, which Pi records in the session and restores on resume.
 */
import {
	type Api,
	type ApiKeyAuth,
	createProvider,
	type Model,
	type OAuthAuth,
	type Provider,
	type ProviderAuth,
	type ProviderStreams,
} from "@earendil-works/pi-ai";

/** Delegating wrapper: spreading would lose prototype methods of class-based implementations. */
function cloneOAuth(source: OAuthAuth, name: string): OAuthAuth {
	return {
		name,
		isSubscription: source.isSubscription,
		loginLabel: source.loginLabel,
		login: (interaction, options) => source.login(interaction, options),
		refresh: (credential, signal) => source.refresh(credential, signal),
		toAuth: (credential) => source.toAuth(credential),
	};
}

/**
 * An extra account must use ONLY its own stored key. The built-in resolver also falls back to
 * environment variables (ANTHROPIC_API_KEY…), which would make every account look logged in with
 * the same shared key.
 */
function cloneApiKey(source: ApiKeyAuth, name: string): ApiKeyAuth {
	return {
		name,
		...(source.login ? { login: (interaction) => source.login!(interaction) } : {}),
		async resolve({ credential }) {
			if (!credential?.key) return undefined;
			return { auth: { apiKey: credential.key }, env: credential.env, source: "stored credential" };
		},
	};
}

/** The family's chat models, renamed to belong to `id`. */
export function accountModels(id: string, template: Provider): Model<Api>[] {
	return template.getModels().map((model) => ({ ...model, provider: id }));
}

export function createAccountProvider(id: string, name: string, template: Provider): Provider {
	const auth: ProviderAuth = {
		...(template.auth.oauth ? { oauth: cloneOAuth(template.auth.oauth, name) } : {}),
		...(template.auth.apiKey ? { apiKey: cloneApiKey(template.auth.apiKey, name) } : {}),
	};
	const streams: ProviderStreams = {
		stream: (model, context, options) => template.stream(model as never, context, options as never),
		streamSimple: (model, context, options) => template.streamSimple(model as never, context, options),
	};
	return createProvider({
		id,
		name,
		baseUrl: template.baseUrl,
		headers: template.headers,
		auth,
		models: accountModels(id, template),
		api: streams,
	});
}
