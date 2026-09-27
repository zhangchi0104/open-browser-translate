import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Effect } from "effect";
import { Decision, DecisionModel, LanguageModel } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import { Schema } from "effect";
import { defaultSettings, migrateSettings, validateModel } from "../src/modules/settings/model";
import { AiProviders } from "../src/modules/ai/providers";
import { analysisLayerFromSettings, translationLayerFromSettings } from "../src/modules/ai/configured";

test("models can be configured independently, while nonempty IDs remain validated", () => {
  assert.equal(validateModel(AiProviders.VercelAIGateway, ""), undefined);
  assert.equal(validateModel(AiProviders.TypeSafe, ""), undefined);
  assert.equal(validateModel(AiProviders.VercelAIGateway, "typesafe-ai/jev"), undefined);
  assert.ok(validateModel(AiProviders.VercelAIGateway, "invalid-model"));
  assert.ok(validateModel(AiProviders.OpenAIApi, "model with spaces"));
});

test("migration preserves keys and separates Jev from translation", () => {
  const settings = migrateSettings({ provider: AiProviders.TypeSafe, providers: {
    TypeSafe: { apiKey: "test-jev", model: "jev-custom" },
    VercelAIGateway: { apiKey: "test-gateway", model: "vendor/translator" },
  } });
  assert.equal(settings.analysis.provider, AiProviders.TypeSafe);
  assert.equal(settings.translation.provider, AiProviders.VercelAIGateway);
  assert.equal(settings.translation.models.VercelAIGateway, "vendor/translator");
  assert.equal(settings.analysis.models.TypeSafe, "jev-custom");
  assert.equal(settings.providers.TypeSafe.apiKey, "test-jev");
  assert.equal(settings.providers.VercelAIGateway.apiKey, "test-gateway");
  const jev = migrateSettings({ providers: { VercelAIGateway: { model: "typesafe-ai/jev" } } });
  assert.equal(jev.analysis.models.VercelAIGateway, "typesafe-ai/jev");
  assert.equal(jev.translation.models.VercelAIGateway, "");
  assert.deepEqual(migrateSettings(null), defaultSettings);
});

test("analysis and translation route independently through configured providers", async () => {
  const settings = structuredClone(defaultSettings);
  settings.providers.VercelAIGateway.apiKey = "test-gateway";
  settings.providers.OpenAIApi.apiKey = "test-direct";
  settings.translation.provider = AiProviders.OpenAIApi;
  settings.translation.models.OpenAIApi = "test-translator";
  const requests: string[] = [];
  const fetchMock: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push(url);
    const body = JSON.parse(String(init?.body));
    if (url.endsWith("systemone")) {
      assert.equal(url, "https://ai-gateway.vercel.sh/typesafe/v1/systemone");
      assert.equal(body.model, "typesafe-ai/jev");
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-gateway");
      return Response.json({ model: body.model, answers: { relevant: { type: "noul", noul: 0.9 } } });
    }
    assert.equal(url, "https://api.openai.com/v1/chat/completions");
    assert.equal(body.model, "test-translator");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-direct");
    return Response.json({ id: "test", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "你好" }, finish_reason: "stop" }] });
  };
  const definition = Decision.make({ input: Schema.String, decisions: { relevant: Decision.probability({ instructions: "Is this relevant?", criteria: { true: "Relevant", false: "Irrelevant" } }) } });
  const analysis = await Effect.runPromise(DecisionModel.decide(definition, { input: "Hello" }).pipe(Effect.provide(analysisLayerFromSettings(settings)), Effect.provideService(FetchHttpClient.Fetch, fetchMock)));
  assert.equal(analysis.answers.relevant.probability, 0.9);
  const translation = await Effect.runPromise(LanguageModel.generateText({ prompt: "Hello" }).pipe(Effect.provide(translationLayerFromSettings(settings)), Effect.provideService(FetchHttpClient.Fetch, fetchMock)));
  assert.equal(translation.text, "你好");
  assert.equal(requests.length, 2);
});

test("page analysis requires configuration and returns only serializable decisions", async () => {
  const { analyzePageContent } = await import("../src/modules/content-analyzer/page-analysis");
  const settings = structuredClone(defaultSettings);
  const blocks = [{ text: "Article text", tag: "p" }, { text: "Home", tag: "a" }];
  assert.deepEqual(await Effect.runPromise(analyzePageContent(blocks, settings)), { status: "not-configured" });
  settings.providers.VercelAIGateway.apiKey = "test-gateway";
  const labels = ["content", "navigation", "control", "auxiliary", "advertisement", "unknown"];
  const fetchMock: typeof globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://ai-gateway.vercel.sh/typesafe/v1/systemone");
    const request = JSON.parse(String(init?.body));
    assert.deepEqual(request.state.blocks.map(({ text, tag }: {text: string; tag: string}) => ({ text, tag })), blocks);
    return Response.json({ model: request.model, answers: Object.fromEntries(["content", "navigation"].map((label, index) => [String(index), {
      type: "choice", choice: label, confidence: 1,
      probabilities: Object.fromEntries(labels.map((value) => [value, value === label ? 1 : 0])),
    }])) });
  };
  const result = await Effect.runPromise(analyzePageContent(blocks, settings).pipe(Effect.provideService(FetchHttpClient.Fetch, fetchMock)));
  assert.deepEqual(result, { status: "ok", keep: [true, false], fallbackCount: 0 });
  const failedFetch: typeof globalThis.fetch = async () => Response.json({ message: "Unauthorized", error_type: "authentication_error" }, { status: 401 });
  const fallback = await Effect.runPromise(analyzePageContent(blocks, settings).pipe(Effect.provideService(FetchHttpClient.Fetch, failedFetch)));
  assert.deepEqual(fallback, { status: "ok", keep: [true, true], fallbackCount: 2 });
});
