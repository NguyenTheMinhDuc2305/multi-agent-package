import assert from "node:assert/strict";
import { test } from "node:test";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { createAccountProvider } from "../src/accounts.ts";

const builtin = (id: string) => {
	const provider = builtinProviders().find((p) => p.id === id);
	if (!provider) throw new Error(`no built-in provider ${id}`);
	return provider;
};

test("an account provider publishes the family's models under its own id", () => {
	const template = builtin("anthropic");
	const account = createAccountProvider("anthropic-account-2", "Anthropic (account 2)", template);
	assert.equal(account.id, "anthropic-account-2");
	assert.equal(account.name, "Anthropic (account 2)");
	assert.equal(account.baseUrl, template.baseUrl);
	const models = account.getModels();
	assert.ok(models.length > 0);
	assert.deepEqual(models.map((m) => m.id), template.getModels().map((m) => m.id), "same model ids as account 1");
	assert.ok(models.every((m) => m.provider === "anthropic-account-2"));
	assert.ok(template.getModels().every((m) => m.provider === "anthropic"), "the built-in catalog is not modified");
});

test("login methods are delegated to the family's own (OAuth and API key)", () => {
	const template = builtin("anthropic");
	const account = createAccountProvider("anthropic-account-2", "Anthropic (work)", template);
	assert.ok(account.auth.oauth, "subscription login offered");
	assert.equal(account.auth.oauth!.name, "Anthropic (work)");
	assert.equal(account.auth.oauth!.isSubscription, template.auth.oauth!.isSubscription);
	assert.ok(account.auth.apiKey, "API-key login offered");
	const codex = createAccountProvider("openai-codex-account-2", "OpenAI Codex (account 2)", builtin("openai-codex"));
	assert.ok(codex.auth.oauth);
	assert.equal(codex.auth.apiKey, undefined, "Codex has no API-key login, so neither does its account");
});

test("an API-key account uses only its own stored key, never the environment", async () => {
	const account = createAccountProvider("anthropic-account-2", "Anthropic (account 2)", builtin("anthropic"));
	const resolve = account.auth.apiKey!.resolve;
	process.env.ANTHROPIC_API_KEY = "sk-ant-api03-from-env";
	try {
		assert.equal(await resolve({ credential: undefined } as never), undefined);
		const own = await resolve({ credential: { type: "api_key", key: "sk-ant-api03-own" } } as never);
		assert.equal(own?.auth.apiKey, "sk-ant-api03-own");
	} finally {
		delete process.env.ANTHROPIC_API_KEY;
	}
});
