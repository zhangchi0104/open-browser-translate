import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Effect } from "effect";
import { Decision, DecisionModel, LanguageModel } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import { Schema } from "effect";
import { defaultSettings, migrateSettings, migrateToGatewayAnalysis, migrateToOpenAIAnalysis, validateModel } from "../src/modules/settings/model";
import { AiProviders } from "../src/modules/ai/providers";
import { analysisLayerFromSettings, translationLayerFromSettings } from "../src/modules/ai/configured";
import { decisionResponse, isDecisionRequest } from "./decision-mock";

test("models can be configured independently, while nonempty IDs remain validated", () => {
  assert.equal(validateModel(AiProviders.VercelAIGateway, ""), undefined);
  assert.equal(validateModel(AiProviders.OpenAIApi, ""), undefined);
  assert.equal(validateModel(AiProviders.OpenAIApi, "gpt-6-luna"), undefined);
  assert.ok(validateModel(AiProviders.VercelAIGateway, "invalid-model"));
  assert.ok(validateModel(AiProviders.OpenAIApi, "model with spaces"));
});

test("migration keeps translation settings and moves analysis from Jev to OpenAI", () => {
  const v2 = migrateSettings({ provider: "TypeSafe", providers: {
    TypeSafe: { apiKey: "test-jev", model: "jev-custom" },
    VercelAIGateway: { apiKey: "test-gateway", model: "vendor/translator" },
  } });
  assert.equal(v2.analysis.provider, "TypeSafe");
  assert.equal(v2.translation.models.VercelAIGateway, "vendor/translator");
  const settings = migrateToOpenAIAnalysis(v2);
  assert.equal(settings.analysis.provider, AiProviders.OpenAIApi);
  assert.equal(settings.analysis.models.OpenAIApi, "gpt-6-luna");
  assert.equal(settings.translation.provider, AiProviders.VercelAIGateway);
  assert.equal(settings.translation.models.VercelAIGateway, "vendor/translator");
  assert.equal(settings.providers.VercelAIGateway.apiKey, "test-gateway");
  assert.equal("TypeSafe" in settings.providers, false);
  const jev = migrateToOpenAIAnalysis(migrateSettings({ providers: { VercelAIGateway: { model: "typesafe-ai/jev" } } }));
  assert.equal(jev.translation.models.VercelAIGateway, "");
  assert.deepEqual(migrateToGatewayAnalysis(migrateToOpenAIAnalysis(migrateSettings(null))), defaultSettings);

  const signedIn = structuredClone(v2);
  signedIn.providers.OpenAIApi = { apiKey: "test-direct" };
  signedIn.translation = { provider: AiProviders.OpenAISubscription, models: { ...signedIn.translation.models, OpenAISubscription: "plan-model" } };
  const plan = migrateToOpenAIAnalysis(signedIn);
  assert.equal(plan.analysis.provider, AiProviders.OpenAISubscription);
  assert.equal(plan.analysis.models.OpenAISubscription, "plan-model");
  assert.equal(plan.providers.OpenAIApi.apiKey, "test-direct");
});

test("analysis and translation route independently through configured providers", async () => {
  const settings = structuredClone(defaultSettings);
  settings.analysis.provider = AiProviders.OpenAIApi;
  settings.providers.VercelAIGateway.apiKey = "test-gateway";
  settings.providers.OpenAIApi.apiKey = "test-direct";
  settings.translation.models.VercelAIGateway = "vendor/translator";
  const requests: string[] = [];
  const fetchMock: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push(url);
    const body = JSON.parse(String(init?.body));
    if (isDecisionRequest(body)) {
      assert.equal(url, "https://api.openai.com/v1/chat/completions");
      assert.equal(body.model, "gpt-6-luna");
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-direct");
      return decisionResponse(body, () => "true");
    }
    assert.equal(url, "https://ai-gateway.vercel.sh/v1/chat/completions");
    assert.equal(body.model, "vendor/translator");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-gateway");
    return Response.json({ id: "test", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "你好" }, finish_reason: "stop" }] });
  };
  const definition = Decision.make({ input: Schema.String, decisions: { relevant: Decision.probability({ instructions: "Is this relevant?", criteria: { true: "Relevant", false: "Irrelevant" } }) } });
  const analysis = await Effect.runPromise(DecisionModel.decide(definition, { input: "Hello" }).pipe(Effect.provide(analysisLayerFromSettings(settings)), Effect.provideService(FetchHttpClient.Fetch, fetchMock)));
  assert.equal(analysis.answers.relevant.probability, 1);
  const translation = await Effect.runPromise(LanguageModel.generateText({ prompt: "Hello" }).pipe(Effect.provide(translationLayerFromSettings(settings)), Effect.provideService(FetchHttpClient.Fetch, fetchMock)));
  assert.equal(translation.text, "你好");
  assert.equal(requests.length, 2);
});

test("page analysis requires configuration and returns only serializable decisions", async () => {
  const { analyzePageContent } = await import("../src/modules/content-analyzer/page-analysis");
  const settings = structuredClone(defaultSettings);
  settings.analysis.provider = AiProviders.OpenAIApi;
  const blocks = [{ text: "Article text", tag: "p" }, { text: "Home", tag: "a" }];
  assert.deepEqual(await Effect.runPromise(analyzePageContent(blocks, settings)), { status: "not-configured" });
  settings.providers.OpenAIApi.apiKey = "test-direct";
  const fetchMock: typeof globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://api.openai.com/v1/chat/completions");
    const request = JSON.parse(String(init?.body));
    return decisionResponse(request, (key, state) => {
      assert.deepEqual(state.blocks.map(({ text, tag }: {text: string; tag: string}) => ({ text, tag })), blocks);
      return key === "0" ? "content" : "navigation";
    });
  };
  const result = await Effect.runPromise(analyzePageContent(blocks, settings).pipe(Effect.provideService(FetchHttpClient.Fetch, fetchMock)));
  assert.deepEqual(result, { status: "ok", keep: [true, false], fallbackCount: 0 });
  const failedFetch: typeof globalThis.fetch = async () => Response.json({ message: "Unauthorized", error_type: "authentication_error" }, { status: 401 });
  const fallback = await Effect.runPromise(analyzePageContent(blocks, settings).pipe(Effect.provideService(FetchHttpClient.Fetch, failedFetch)));
  assert.deepEqual(fallback, { status: "ok", keep: [true, true], fallbackCount: 2 });
});

test("version 4 moves analysis without an OpenAI key to the gateway and keeps configured choices", () => {
  const v3 = migrateToOpenAIAnalysis(migrateSettings({ providers: { VercelAIGateway: { apiKey: "test-gateway", model: "vendor/translator" } } }));
  const moved = migrateToGatewayAnalysis(v3);
  assert.equal(moved.analysis.provider, AiProviders.VercelAIGateway);
  assert.equal(moved.analysis.models.VercelAIGateway, "typesafe-ai/jev");
  assert.equal(moved.providers.VercelAIGateway.apiKey, "test-gateway");
  assert.equal(moved.translation.models.VercelAIGateway, "vendor/translator");

  const direct = structuredClone(v3);
  direct.providers.OpenAIApi.apiKey = "test-direct";
  assert.equal(migrateToGatewayAnalysis(direct).analysis.provider, AiProviders.OpenAIApi);
  const plan = structuredClone(v3);
  plan.analysis.provider = AiProviders.OpenAISubscription;
  assert.equal(migrateToGatewayAnalysis(plan).analysis.provider, AiProviders.OpenAISubscription);
});

test("gateway analysis asks an evaluation model through the gateway's System One API", async () => {
  const settings = structuredClone(defaultSettings);
  settings.providers.VercelAIGateway.apiKey = "test-gateway";
  const fetchMock: typeof globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(String(input), "https://ai-gateway.vercel.sh/typesafe/v1/systemone");
    assert.equal(body.model, "typesafe-ai/jev");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-gateway");
    return Response.json({ model: body.model, answers: { relevant: { type: "noul", noul: 0.9 } } });
  };
  const definition = Decision.make({ input: Schema.String, decisions: { relevant: Decision.probability({ instructions: "Is this relevant?", criteria: { true: "Relevant", false: "Irrelevant" } }) } });
  const analysis = await Effect.runPromise(DecisionModel.decide(definition, { input: "Hello" }).pipe(Effect.provide(analysisLayerFromSettings(settings)), Effect.provideService(FetchHttpClient.Fetch, fetchMock)));
  assert.equal(analysis.answers.relevant.probability, 0.9);
});

test("reasoning effort reaches each provider in its own field, and is omitted by default", async () => {
  const bodies: any[] = [];
  const chat: typeof globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    return isDecisionRequest(body)
      ? decisionResponse(body, () => "true")
      : Response.json({ id: "test", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "你好" }, finish_reason: "stop" }] });
  };
  const settings = structuredClone(defaultSettings);
  settings.providers.VercelAIGateway.apiKey = "test-gateway";
  settings.providers.OpenAIApi.apiKey = "test-direct";
  settings.translation.models.VercelAIGateway = "vendor/translator";
  const translate = () => Effect.runPromise(LanguageModel.generateText({ prompt: "Hello" }).pipe(
    Effect.provide(translationLayerFromSettings(settings)), Effect.provideService(FetchHttpClient.Fetch, chat)));
  await translate();
  assert.equal("reasoning_effort" in bodies.at(-1), false);
  settings.translation.reasoningEffort = "low";
  await translate();
  assert.equal(bodies.at(-1).reasoning_effort, "low");

  settings.analysis.provider = AiProviders.OpenAIApi;
  settings.analysis.reasoningEffort = "minimal";
  const definition = Decision.make({ input: Schema.String, decisions: { relevant: Decision.probability({ instructions: "Is this relevant?", criteria: { true: "Relevant", false: "Irrelevant" } }) } });
  await Effect.runPromise(DecisionModel.decide(definition, { input: "Hello" }).pipe(
    Effect.provide(analysisLayerFromSettings(settings)), Effect.provideService(FetchHttpClient.Fetch, chat)));
  assert.equal(bodies.at(-1).reasoning_effort, "minimal");
});

test("fast mode is a ChatGPT plan option; key-based providers never send a service tier", async () => {
  const bodies: any[] = [];
  const chat: typeof globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    return isDecisionRequest(body)
      ? decisionResponse(body, () => "true")
      : Response.json({ id: "test", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "你好" }, finish_reason: "stop" }] });
  };
  const settings = structuredClone(defaultSettings);
  settings.providers.VercelAIGateway.apiKey = "test-gateway";
  settings.providers.OpenAIApi.apiKey = "test-direct";
  settings.translation.models.VercelAIGateway = "vendor/translator";
  settings.translation.fast = true;
  settings.analysis.provider = AiProviders.OpenAIApi;
  settings.analysis.fast = true;
  await Effect.runPromise(LanguageModel.generateText({ prompt: "Hello" }).pipe(
    Effect.provide(translationLayerFromSettings(settings)), Effect.provideService(FetchHttpClient.Fetch, chat)));
  const definition = Decision.make({ input: Schema.String, decisions: { relevant: Decision.probability({ instructions: "Is this relevant?", criteria: { true: "Relevant", false: "Irrelevant" } }) } });
  await Effect.runPromise(DecisionModel.decide(definition, { input: "Hello" }).pipe(
    Effect.provide(analysisLayerFromSettings(settings)), Effect.provideService(FetchHttpClient.Fetch, chat)));
  for (const body of bodies) {
    assert.equal("service_tier" in body, false);
    assert.equal("providerOptions" in body, false);
  }
});
