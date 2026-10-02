import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Effect } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import {
  CHATGPT_REDIRECT_URI, completeSignIn, createSignIn, parseCallback, refreshAccount, type ChatGPTAuth,
} from "../src/modules/ai/chatgpt-auth";
import { translationLayerFromSettings } from "../src/modules/ai/configured";
import { AiProviders } from "../src/modules/ai/providers";
import { defaultSettings } from "../src/modules/settings/model";
import { missingConfiguration } from "../src/modules/translator/translate-batch";

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "test-key" };
async function idToken(claims: Record<string, unknown>) {
  const header = b64url(Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key" })));
  const payload = b64url(Buffer.from(JSON.stringify({ iss: "https://auth.openai.com", exp: Date.now() / 1000 + 600, ...claims })));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(signature))}`;
}
function authServer(token: (form: URLSearchParams) => Promise<Record<string, unknown>>, forms: URLSearchParams[] = []): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    if (url === "https://auth.openai.com/.well-known/openid-configuration") return Response.json({ jwks_uri: "https://auth.openai.com/jwks" });
    if (url === "https://auth.openai.com/jwks") return Response.json({ keys: [jwk] });
    assert.equal(url, "https://auth.openai.com/api/accounts/oauth/token");
    const form = new URLSearchParams(String(init?.body));
    forms.push(form);
    return Response.json(await token(form));
  };
}

test("first sign-in registers dynamically; returning sign-in reuses the issued client", async () => {
  const first = new URL((await createSignIn({ hostId: "urn:uuid:host" })).url);
  assert.equal(first.origin + first.pathname, "https://auth.openai.com/api/accounts/authorize");
  const params = first.searchParams;
  assert.equal(params.get("client_id"), "dynamic_agent_client");
  assert.equal(params.get("agent_name_hint"), "Open Browser Translate");
  assert.equal(params.get("ext_agent_host_id"), "urn:uuid:host");
  assert.equal(params.get("redirect_uri"), "http://127.0.0.1:45173/callback");
  assert.equal(params.get("scope"), "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct");
  assert.equal(params.get("resource"), "https://api.openai.com/v1");
  assert.equal(params.get("code_challenge_method"), "S256");
  const { url, attempt } = await createSignIn({ hostId: "urn:uuid:host", clientId: "oaiapp_1" });
  const returning = new URL(url).searchParams;
  assert.equal(returning.get("client_id"), "oaiapp_1");
  assert.equal(returning.get("agent_name_hint"), null);
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(attempt.verifier))));
  assert.equal(returning.get("code_challenge"), challenge);
});

test("callback validation rejects bad state and denial, and reads the issued client ID", async () => {
  const { attempt } = await createSignIn({ hostId: "urn:uuid:host" });
  const callback = (query: string) => `${CHATGPT_REDIRECT_URI}?${query}`;
  assert.throws(() => parseCallback(callback(`code=c&state=wrong&client_id=oaiapp_1`), attempt), { reason: "invalid" });
  assert.throws(() => parseCallback(callback(`error=access_denied&state=${attempt.state}`), attempt), { reason: "denied" });
  assert.throws(() => parseCallback(callback(`code=c&state=${attempt.state}`), attempt), { reason: "invalid" });
  assert.deepEqual(parseCallback(callback(`code=c&state=${attempt.state}&client_id=oaiapp_1`), attempt), { code: "c", clientId: "oaiapp_1" });
});

test("sign-in exchanges the code, verifies the ID token, and requires plan scope", async () => {
  const auth: ChatGPTAuth = { hostId: "urn:uuid:host" };
  const { attempt } = await createSignIn(auth);
  const callback = `${CHATGPT_REDIRECT_URI}?code=the-code&state=${attempt.state}&client_id=oaiapp_1`;
  const forms: URLSearchParams[] = [];
  const tokens = async (scope: string, nonce = attempt.nonce) => ({
    access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, scope,
    id_token: await idToken({ aud: "oaiapp_1", sub: "user-1", email: "a@example.com", nonce }),
  });
  const signedIn = await completeSignIn(auth, attempt, callback, authServer(() => tokens("openid chatgpt.tokens.use.direct"), forms));
  assert.equal(signedIn.clientId, "oaiapp_1");
  assert.equal(signedIn.account?.email, "a@example.com");
  assert.equal(signedIn.account?.accessToken, "access-1");
  assert.deepEqual(Object.fromEntries(forms[0]!), {
    grant_type: "authorization_code", code: "the-code", client_id: "oaiapp_1", redirect_uri: CHATGPT_REDIRECT_URI,
    code_verifier: attempt.verifier, resource: "https://api.openai.com/v1",
  });
  await assert.rejects(completeSignIn(auth, attempt, callback, authServer(() => tokens("openid"))), { reason: "no-plan" });
  await assert.rejects(completeSignIn(auth, attempt, callback, authServer(() => tokens("openid chatgpt.tokens.use.direct", "other"))), { reason: "invalid" });

  const refreshForms: URLSearchParams[] = [];
  const refreshed = await refreshAccount(signedIn, authServer(async () => ({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 }), refreshForms));
  assert.equal(refreshed.account?.accessToken, "access-2");
  assert.equal(refreshed.account?.refreshToken, "refresh-2");
  assert.deepEqual(refreshed.account?.scopes, signedIn.account?.scopes);
  assert.deepEqual(Object.fromEntries(refreshForms[0]!), {
    grant_type: "refresh_token", client_id: "oaiapp_1", refresh_token: "refresh-1", resource: "https://api.openai.com/v1",
  });
});

const completed = {
  id: "resp_1", object: "response", created_at: 1, model: "gpt-test", status: "completed",
  output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "你好", annotations: [] }] }],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
};
function sse(...events: unknown[]) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}

test("subscription translation streams Responses requests with the OAuth token", async () => {
  const settings = structuredClone(defaultSettings);
  settings.translation.provider = AiProviders.OpenAISubscription;
  settings.translation.models.OpenAISubscription = "gpt-test";
  settings.providers.VercelAIGateway.apiKey = "test-gateway";
  assert.equal(missingConfiguration(settings), "translation");
  const credentials = { accessToken: async () => "oauth-token" };
  assert.equal(missingConfiguration(settings, credentials), undefined);

  const fetchMock: typeof fetch = async (input, init) => {
    assert.equal(String(input), "https://api.openai.com/v1/responses");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer oauth-token");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "gpt-test");
    assert.equal(body.stream, true);
    assert.equal(body.store, false);
    return sse({ type: "response.created", response: { ...completed, status: "in_progress", output: [] } }, { type: "response.completed", response: completed });
  };
  const result = await Effect.runPromise(LanguageModel.generateText({ prompt: "Hello" }).pipe(
    Effect.provide(translationLayerFromSettings(settings, credentials)),
    Effect.provideService(FetchHttpClient.Fetch, fetchMock),
  ));
  assert.equal(result.text, "你好");

  const limited: typeof fetch = async () => sse({ type: "response.failed", response: { ...completed, status: "failed", output: [], error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } } });
  await assert.rejects(Effect.runPromise(LanguageModel.generateText({ prompt: "Hello" }).pipe(
    Effect.provide(translationLayerFromSettings(settings, credentials)),
    Effect.provideService(FetchHttpClient.Fetch, limited),
  )));
});

test("the translator's structured output works over the subscription", async () => {
  const { Translator } = await import("../src/modules/translator");
  const { Layer } = await import("effect");
  const settings = structuredClone(defaultSettings);
  settings.translation.provider = AiProviders.OpenAISubscription;
  settings.translation.models.OpenAISubscription = "gpt-test";
  const text = JSON.stringify({ translations: [{ id: 0, text: "你好" }], terms: [] });
  const fetchMock: typeof fetch = async (_, init) => {
    assert.equal(JSON.parse(String(init?.body)).text.format.type, "json_schema");
    return sse({ type: "response.completed", response: { ...completed, output: [{ ...completed.output[0], content: [{ type: "output_text", text, annotations: [] }] }] } });
  };
  const result = await Effect.runPromise(Translator.use((service) => service.translate(["Hello"], "简体中文")).pipe(
    Effect.provide(Translator.Live.pipe(Layer.provide(translationLayerFromSettings(settings, { accessToken: async () => "oauth-token" })))),
    Effect.provideService(FetchHttpClient.Fetch, fetchMock),
  ));
  assert.deepEqual(result, { translations: ["你好"], terms: [] });
});
