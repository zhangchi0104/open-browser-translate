import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Effect, Redacted, Schema, Stream } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import { anthropicLayer, listAnthropicModels } from "../src/modules/background/ai/anthropic";
import { listOpenRouterModels, openRouterLayer } from "../src/modules/background/ai/openrouter";
import { missingConfiguration, translationModelFor } from "../src/modules/background/ai/models";
import { testConnection } from "../src/modules/background/ai/connection-test";
import { AiProviders, defaultSettings, validateModel, type AISettings } from "../src/modules/shared/settings/model";

/** A fetch that answers with `respond` and records each request with its JSON body. */
function recorder(respond: (request: Request, body: any) => Response) {
  const requests: { request: Request; body: any }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ request, body });
    return respond(request, body);
  }) as typeof globalThis.fetch;
  return { requests, fetch };
}

// The usage block the Messages API returns, cache fields included.
const claudeUsage = (output: number) => ({
  input_tokens: 5, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, server_tool_use: null, service_tier: "standard", inference_geo: "global",
});
const claudeMessage = (text: string) => Response.json({
  id: "msg_test", type: "message", role: "assistant", model: "claude-test",
  content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null,
  usage: claudeUsage(2),
});

test("Claude gets structured output and effort through the Messages API, with the browser-access header", async () => {
  const { requests, fetch } = recorder(() => claudeMessage('{"text":"你好"}'));
  const response = await Effect.runPromise(
    LanguageModel.generateObject({ objectName: "out", schema: Schema.Struct({ text: Schema.String }), prompt: "Translate Hello" }).pipe(
      Effect.provide(anthropicLayer({ apiKey: Redacted.make("sk-ant-test"), model: "claude-test", reasoningEffort: "minimal" })),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    ),
  );
  assert.deepEqual(response.value, { text: "你好" });
  const { request, body } = requests[0]!;
  assert.equal(new URL(request!.url).origin + new URL(request!.url).pathname, "https://api.anthropic.com/v1/messages");
  assert.equal(request!.headers.get("x-api-key"), "sk-ant-test");
  assert.ok(request!.headers.get("anthropic-version"));
  assert.equal(request!.headers.get("anthropic-dangerous-direct-browser-access"), "true");
  assert.equal(request!.headers.has("authorization"), false);
  assert.equal(body.model, "claude-test");
  assert.equal(body.output_config.format.type, "json_schema");
  assert.equal(body.output_config.effort, "low", "Claude has no minimal effort; the lowest it takes is low");
  assert.equal(typeof body.max_tokens, "number");
});

test("Claude streams text for in-place translation, and sends no effort unless one is set", async () => {
  const events = [
    { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, stop_sequence: null, usage: claudeUsage(0) } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "好" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { input_tokens: 5, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null } },
    { type: "message_stop" },
  ];
  const sse = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  const { requests, fetch } = recorder(() => new Response(sse, { headers: { "Content-Type": "text/event-stream" } }));
  let text = "";
  await Effect.runPromise(
    Stream.runForEach(LanguageModel.streamText({ prompt: "Translate Hello" }), (part) => Effect.sync(() => {
      if (part.type === "text-delta") text += part.delta;
    })).pipe(
      Effect.provide(anthropicLayer({ apiKey: Redacted.make("sk-ant-test"), model: "claude-test" })),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    ),
  );
  assert.equal(text, "你好");
  assert.equal(requests[0]!.body.stream, true);
  assert.equal(requests[0]!.body.output_config, undefined);
});

test("OpenRouter gets Chat Completions with the key, and effort as its reasoning_effort shorthand", async () => {
  const { requests, fetch } = recorder((_, body) => Response.json({
    id: "gen-test", object: "chat.completion", created: 1, model: body.model, system_fingerprint: null,
    choices: [{ index: 0, message: { role: "assistant", content: "你好" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  }));
  const response = await Effect.runPromise(
    LanguageModel.generateText({ prompt: "Translate Hello" }).pipe(
      Effect.provide(openRouterLayer({ apiKey: Redacted.make("sk-or-test"), model: "anthropic/claude-test", reasoningEffort: "high" })),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    ),
  );
  assert.equal(response.text, "你好");
  const { request, body } = requests[0]!;
  assert.equal(request!.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(request!.headers.get("authorization"), "Bearer sk-or-test");
  assert.equal(body.model, "anthropic/claude-test");
  assert.equal(body.reasoning_effort, "high");
});

test("a purpose on an Anthropic or OpenRouter connection runs there, and needs its key", async () => {
  for (const [kind, url] of [[AiProviders.Anthropic, "https://api.anthropic.com/v1/messages?beta=true"], [AiProviders.OpenRouter, "https://openrouter.ai/api/v1/chat/completions"]] as const) {
    const settings: AISettings = structuredClone(defaultSettings);
    settings.connections.push({ id: "mine", kind, name: kind, apiKey: "" });
    settings.translation = { connection: "mine", models: { mine: "some/model" } };
    assert.equal(missingConfiguration(settings, false, ["translation"]), "translation", `${kind} without a key`);

    settings.connections.at(-1)!.apiKey = "test-key";
    assert.equal(missingConfiguration(settings, false, ["translation"]), undefined);
    const { requests, fetch } = recorder(() => new Response("{}", { status: 500 }));
    await Effect.runPromiseExit(
      LanguageModel.generateText({ prompt: "Hello" }).pipe(
        Effect.provide(translationModelFor(settings)),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      ),
    );
    assert.equal(requests[0]?.request.url, url, kind);
  }
});

test("OpenRouter model IDs are provider/model, a variant allowed", () => {
  assert.equal(validateModel(AiProviders.OpenRouter, "anthropic/claude-test:free"), undefined);
  assert.match(validateModel(AiProviders.OpenRouter, "claude-test") ?? "", /provider\/model/);
  assert.equal(validateModel(AiProviders.Anthropic, "claude-test"), undefined);
});

test("Claude's catalog lists the key's models, newest first, by display name", async () => {
  const { requests, fetch } = recorder(() => Response.json({ data: [
    { type: "model", id: "claude-old", display_name: "Claude Old", created_at: "2025-01-01T00:00:00Z" },
    { type: "model", id: "claude-new", display_name: "Claude New", created_at: "2026-09-01T00:00:00Z" },
  ], has_more: false }));
  const models = await listAnthropicModels("sk-ant-test", fetch);
  assert.deepEqual(models, [{ slug: "claude-new", displayName: "Claude New" }, { slug: "claude-old", displayName: "Claude Old" }]);
  assert.equal(requests[0]!.request.url, "https://api.anthropic.com/v1/models?limit=1000");
  assert.equal(requests[0]!.request.headers.get("x-api-key"), "sk-ant-test");
  await assert.rejects(listAnthropicModels("bad", recorder(() => new Response("invalid x-api-key", { status: 401 })).fetch), /401/);
});

test("OpenRouter's catalog is the key's own list of text models, newest first", async () => {
  const { requests, fetch } = recorder(() => Response.json({ data: [
    { id: "a/old", name: "Old", created: 1, architecture: { output_modalities: ["text"] } },
    { id: "a/image", name: "Image", created: 9, architecture: { output_modalities: ["image"] } },
    { id: "a/new", name: "New", created: 5, architecture: { output_modalities: ["text", "image"] } },
  ] }));
  const models = await listOpenRouterModels("sk-or-test", fetch);
  assert.deepEqual(models.map(({ slug }) => slug), ["a/new", "a/old"]);
  assert.equal(requests[0]!.request.url, "https://openrouter.ai/api/v1/models/user");
  assert.equal(requests[0]!.request.headers.get("authorization"), "Bearer sk-or-test");
});

test("a connection test asks each API for models the way it takes keys", async () => {
  const { requests, fetch } = recorder(() => Response.json({ data: [{ id: "m" }] }));
  const anthropic = await testConnection({ apiUrl: "https://api.anthropic.com", apiKey: "sk-ant-test", api: "anthropic" }, { fetcher: fetch });
  const openrouter = await testConnection({ apiUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or-test", api: "openrouter" }, { fetcher: fetch });
  assert.equal(anthropic.status, "ok");
  assert.equal(openrouter.status, "ok");
  assert.equal(requests[0]!.request.url, "https://api.anthropic.com/v1/models?limit=1000");
  assert.equal(requests[0]!.request.headers.get("x-api-key"), "sk-ant-test");
  assert.equal(requests[0]!.request.headers.get("anthropic-dangerous-direct-browser-access"), "true");
  assert.equal(requests[1]!.request.url, "https://openrouter.ai/api/v1/models/user");
  assert.equal(requests[1]!.request.headers.get("authorization"), "Bearer sk-or-test");

  const unauthorized = await testConnection({ apiUrl: "https://api.anthropic.com", apiKey: "bad", api: "anthropic" }, {
    fetcher: recorder(() => Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 })).fetch,
  });
  assert.equal(unauthorized.status === "error" && unauthorized.reason, "unauthorized");
  assert.equal(unauthorized.status === "error" && unauthorized.detail, "invalid x-api-key");
});
