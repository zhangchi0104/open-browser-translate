import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Effect } from "effect";
import { Decision, DecisionModel, LanguageModel } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import { Schema } from "effect";
import { defaultSettings, findConnection, migrateSettings, migrateToConnections, migrateToGatewayAnalysis, migrateToOpenAIAnalysis, quickView, applyQuickChange, validateApiUrl, validateModel, type AISettings } from "../src/modules/shared/settings/model";
import { AiProviders } from "../src/modules/shared/settings/model";
import { analysisModelFor, modelsFor, translationModelFor } from "../src/modules/background/ai/models";
import { blocksIn, chatCompletion, chatRequest, decisionResponse, isDecisionRequest, requestedModel, type ChatRequest } from "./decision-mock";

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
  assert.deepEqual(migrateToConnections(migrateToGatewayAnalysis(migrateToOpenAIAnalysis(migrateSettings(null)))), defaultSettings);

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
  settings.analysis.connection = AiProviders.OpenAIApi;
  findConnection(settings, AiProviders.VercelAIGateway)!.apiKey = "test-gateway";
  findConnection(settings, AiProviders.OpenAIApi)!.apiKey = "test-direct";
  settings.translation.models.VercelAIGateway = "vendor/translator";
  const requests: string[] = [];
  const fetchMock: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push(url);
    const body = chatRequest(init);
    if (isDecisionRequest(body)) {
      assert.equal(url, "https://api.openai.com/v1/chat/completions");
      assert.equal(body.model, "gpt-6-luna");
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-direct");
      return decisionResponse(body, () => "true");
    }
    assert.equal(url, "https://ai-gateway.vercel.sh/v1/chat/completions");
    assert.equal(body.model, "vendor/translator");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-gateway");
    return chatCompletion(body.model, "你好");
  };
  const definition = Decision.make({ input: Schema.String, decisions: { relevant: Decision.probability({ instructions: "Is this relevant?", criteria: { true: "Relevant", false: "Irrelevant" } }) } });
  const analysis = await Effect.runPromise(DecisionModel.decide(definition, { input: "Hello" }).pipe(Effect.provide(analysisModelFor(settings)), Effect.provideService(FetchHttpClient.Fetch, fetchMock)));
  assert.equal(analysis.answers.relevant.probability, 1);
  const translation = await Effect.runPromise(LanguageModel.generateText({ prompt: "Hello" }).pipe(Effect.provide(translationModelFor(settings)), Effect.provideService(FetchHttpClient.Fetch, fetchMock)));
  assert.equal(translation.text, "你好");
  assert.equal(requests.length, 2);
});

test("page analysis requires configuration and returns only serializable decisions", async () => {
  const { analyzePageContent } = await import("../src/modules/background/content-analyzer/page-analysis");
  const settings = structuredClone(defaultSettings);
  settings.analysis.connection = AiProviders.OpenAIApi;
  const blocks = [{ text: "Article text", tag: "p" }, { text: "Home", tag: "a" }];
  assert.deepEqual(await Effect.runPromise(analyzePageContent(blocks).pipe(Effect.provide(modelsFor(settings)))), { status: "not-configured", purpose: "analysis" });
  findConnection(settings, AiProviders.OpenAIApi)!.apiKey = "test-direct";
  const fetchMock: typeof globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://api.openai.com/v1/chat/completions");
    return decisionResponse(chatRequest(init), (key, state) => {
      assert.deepEqual(blocksIn(state).map(({ text, tag }) => ({ text, tag })), blocks);
      return key === "0" ? "content" : "navigation";
    });
  };
  const result = await Effect.runPromise(analyzePageContent(blocks).pipe(Effect.provide(modelsFor(settings)), Effect.provideService(FetchHttpClient.Fetch, fetchMock)));
  assert.deepEqual(result, { status: "ok", blocks: [{ keep: true, priority: 0 }, { keep: false, priority: 2 }], fallbackCount: 0 });
  const failedFetch: typeof globalThis.fetch = async () => Response.json({ message: "Unauthorized", error_type: "authentication_error" }, { status: 401 });
  const fallback = await Effect.runPromise(analyzePageContent(blocks).pipe(Effect.provide(modelsFor(settings)), Effect.provideService(FetchHttpClient.Fetch, failedFetch)));
  assert.deepEqual(fallback, { status: "ok", blocks: [{ keep: true, priority: 1 }, { keep: true, priority: 1 }], fallbackCount: 2 });
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
  findConnection(settings, AiProviders.VercelAIGateway)!.apiKey = "test-gateway";
  const fetchMock: typeof globalThis.fetch = async (input, init) => {
    const model = requestedModel(init);
    assert.equal(String(input), "https://ai-gateway.vercel.sh/typesafe/v1/systemone");
    assert.equal(model, "typesafe-ai/jev");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-gateway");
    return Response.json({ model, answers: { relevant: { type: "noul", noul: 0.9 } } });
  };
  const definition = Decision.make({ input: Schema.String, decisions: { relevant: Decision.probability({ instructions: "Is this relevant?", criteria: { true: "Relevant", false: "Irrelevant" } }) } });
  const analysis = await Effect.runPromise(DecisionModel.decide(definition, { input: "Hello" }).pipe(Effect.provide(analysisModelFor(settings)), Effect.provideService(FetchHttpClient.Fetch, fetchMock)));
  assert.equal(analysis.answers.relevant.probability, 0.9);
});

test("reasoning effort reaches each provider in its own field, and is omitted by default", async () => {
  const bodies: ChatRequest[] = [];
  const chat: typeof globalThis.fetch = async (_input, init) => {
    const body = chatRequest(init);
    bodies.push(body);
    return isDecisionRequest(body) ? decisionResponse(body, () => "true") : chatCompletion(body.model, "你好");
  };
  const settings = structuredClone(defaultSettings);
  findConnection(settings, AiProviders.VercelAIGateway)!.apiKey = "test-gateway";
  findConnection(settings, AiProviders.OpenAIApi)!.apiKey = "test-direct";
  settings.translation.models.VercelAIGateway = "vendor/translator";
  const translate = () => Effect.runPromise(LanguageModel.generateText({ prompt: "Hello" }).pipe(
    Effect.provide(translationModelFor(settings)), Effect.provideService(FetchHttpClient.Fetch, chat)));
  await translate();
  assert.equal(bodies.at(-1)!.reasoning_effort, undefined);
  settings.translation.reasoningEffort = "low";
  await translate();
  assert.equal(bodies.at(-1)!.reasoning_effort, "low");

  settings.analysis.connection = AiProviders.OpenAIApi;
  settings.analysis.reasoningEffort = "minimal";
  const definition = Decision.make({ input: Schema.String, decisions: { relevant: Decision.probability({ instructions: "Is this relevant?", criteria: { true: "Relevant", false: "Irrelevant" } }) } });
  await Effect.runPromise(DecisionModel.decide(definition, { input: "Hello" }).pipe(
    Effect.provide(analysisModelFor(settings)), Effect.provideService(FetchHttpClient.Fetch, chat)));
  assert.equal(bodies.at(-1)!.reasoning_effort, "minimal");
});

test("fast mode is a ChatGPT plan option; key-based providers never send a service tier", async () => {
  const bodies: ChatRequest[] = [];
  const chat: typeof globalThis.fetch = async (_input, init) => {
    const body = chatRequest(init);
    bodies.push(body);
    return isDecisionRequest(body) ? decisionResponse(body, () => "true") : chatCompletion(body.model, "你好");
  };
  const settings = structuredClone(defaultSettings);
  findConnection(settings, AiProviders.VercelAIGateway)!.apiKey = "test-gateway";
  findConnection(settings, AiProviders.OpenAIApi)!.apiKey = "test-direct";
  settings.translation.models.VercelAIGateway = "vendor/translator";
  settings.translation.fast = true;
  settings.analysis.connection = AiProviders.OpenAIApi;
  settings.analysis.fast = true;
  await Effect.runPromise(LanguageModel.generateText({ prompt: "Hello" }).pipe(
    Effect.provide(translationModelFor(settings)), Effect.provideService(FetchHttpClient.Fetch, chat)));
  const definition = Decision.make({ input: Schema.String, decisions: { relevant: Decision.probability({ instructions: "Is this relevant?", criteria: { true: "Relevant", false: "Irrelevant" } }) } });
  await Effect.runPromise(DecisionModel.decide(definition, { input: "Hello" }).pipe(
    Effect.provide(analysisModelFor(settings)), Effect.provideService(FetchHttpClient.Fetch, chat)));
  for (const body of bodies) {
    assert.equal(body.service_tier, undefined);
    assert.equal(body.providerOptions, undefined);
  }
});

test("Jev's rounded probabilities are renormalized; a distribution far from 1 still fails", async () => {
  const settings = structuredClone(defaultSettings);
  findConnection(settings, AiProviders.VercelAIGateway)!.apiKey = "test-gateway";
  const respond = (probabilities: Record<string, number>): typeof globalThis.fetch => async (_input, init) => {
    return Response.json({ model: requestedModel(init), answers: { kind: { type: "choice", choice: "content", confidence: 0.9, probabilities } } });
  };
  const definition = Decision.make({ input: Schema.String, decisions: {
    kind: Decision.classify({ instructions: "What is this?", criteria: { content: "Content", navigation: "Navigation", advertisement: "Ad" } }),
  } });
  const decide = (fetch: typeof globalThis.fetch) => Effect.runPromise(DecisionModel.decide(definition, { input: "Hello" }).pipe(
    Effect.provide(analysisModelFor(settings)), Effect.provideService(FetchHttpClient.Fetch, fetch), Effect.result));

  const rounded = await decide(respond({ content: 0.8333, navigation: 0.1333, advertisement: 0.0332 }));
  assert.ok(rounded._tag === "Success", "a sum of 0.9998 is rounding, not a wrong answer");
  const probabilities = rounded.success.answers.kind.probabilities;
  assert.ok(Math.abs(Object.values(probabilities).reduce((sum, p) => sum + p, 0) - 1) < 1e-9);
  assert.equal(rounded.success.answers.kind.label, "content");

  const omitted = await decide(respond({ content: 0.9, navigation: 0.1 }));
  assert.ok(omitted._tag === "Success", "a label left out counts as 0");
  assert.equal(omitted.success.answers.kind.probabilities.advertisement, 0);

  const wrong = await decide(respond({ content: 0.4, navigation: 0.1, advertisement: 0.1 }));
  assert.ok(wrong._tag === "Failure", "a sum of 0.6 is a wrong answer and still fails");
});

test("version 5 turns each provider key into a named connection that purposes still point at", () => {
  const v4 = migrateToGatewayAnalysis(migrateToOpenAIAnalysis(migrateSettings({ providers: { VercelAIGateway: { apiKey: "test-gateway", model: "vendor/translator" } } })));
  v4.providers.OpenAIApi.apiKey = "test-direct";
  v4.analysis.provider = AiProviders.OpenAIApi;
  v4.translation.reasoningEffort = "low";
  const settings = migrateToConnections(v4);
  assert.deepEqual(settings.connections.map(({ id, kind, name, apiKey }) => [id, kind, name, apiKey]), [
    [AiProviders.VercelAIGateway, AiProviders.VercelAIGateway, "Vercel AI Gateway", "test-gateway"],
    [AiProviders.OpenAIApi, AiProviders.OpenAIApi, "OpenAI", "test-direct"],
  ]);
  assert.equal(settings.analysis.connection, AiProviders.OpenAIApi);
  assert.equal(settings.analysis.models.OpenAIApi, "gpt-6-luna");
  assert.equal(settings.translation.connection, AiProviders.VercelAIGateway);
  assert.equal(settings.translation.models.VercelAIGateway, "vendor/translator");
  assert.equal(settings.translation.reasoningEffort, "low");
  assert.equal(validateApiUrl("https://openrouter.ai/api/v1"), undefined);
  assert.equal(validateApiUrl("http://localhost:11434/v1"), undefined);
  assert.ok(validateApiUrl("openrouter.ai"));
  assert.ok(validateApiUrl(""));
});

test("each purpose uses its own connection, including a second key of the same kind and a custom API", async () => {
  const settings: AISettings = structuredClone(defaultSettings);
  settings.connections.push(
    { id: "work", kind: AiProviders.OpenAIApi, name: "工作", apiKey: "test-work" },
    { id: "local", kind: AiProviders.Custom, name: "本地", apiKey: "", apiUrl: "http://localhost:11434/v1/" },
  );
  findConnection(settings, AiProviders.OpenAIApi)!.apiKey = "test-direct";
  settings.analysis.connection = "work";
  settings.translation.connection = "local";
  settings.translation.models.local = "llama-test";
  const seen: string[] = [];
  const fetchMock: typeof globalThis.fetch = async (input, init) => {
    const body = chatRequest(init);
    seen.push(`${String(input)} ${new Headers(init?.headers).get("Authorization") ?? "no key"} ${body.model}`);
    return isDecisionRequest(body) ? decisionResponse(body, () => "true") : chatCompletion(body.model, "你好");
  };
  const definition = Decision.make({ input: Schema.String, decisions: { relevant: Decision.probability({ instructions: "Is this relevant?", criteria: { true: "Relevant", false: "Irrelevant" } }) } });
  await Effect.runPromise(DecisionModel.decide(definition, { input: "Hello" }).pipe(Effect.provide(analysisModelFor(settings)), Effect.provideService(FetchHttpClient.Fetch, fetchMock)));
  await Effect.runPromise(LanguageModel.generateText({ prompt: "Hello" }).pipe(Effect.provide(translationModelFor(settings)), Effect.provideService(FetchHttpClient.Fetch, fetchMock)));
  assert.deepEqual(seen, [
    "https://api.openai.com/v1/chat/completions Bearer test-work gpt-6-luna",
    "http://localhost:11434/v1/chat/completions no key llama-test",
  ]);
});

test("a purpose whose connection was removed, or a custom connection without an address, sends nothing", async () => {
  const { analyzePageContent } = await import("../src/modules/background/content-analyzer/page-analysis");
  const settings: AISettings = structuredClone(defaultSettings);
  settings.analysis.connection = "removed";
  assert.deepEqual(await Effect.runPromise(analyzePageContent([{ text: "Hi", tag: "p" }]).pipe(Effect.provide(modelsFor(settings)))), { status: "not-configured", purpose: "analysis" });
  settings.connections.push({ id: "custom", kind: AiProviders.Custom, name: "自定义", apiKey: "", apiUrl: " " });
  settings.analysis = { connection: "custom", models: { custom: "model" } };
  assert.deepEqual(await Effect.runPromise(analyzePageContent([{ text: "Hi", tag: "p" }]).pipe(Effect.provide(modelsFor(settings)))), { status: "not-configured", purpose: "analysis" });
});

test("the quick settings panel sees names and choices only, and its changes are checked", () => {
  const settings: AISettings = structuredClone(defaultSettings);
  findConnection(settings, AiProviders.VercelAIGateway)!.apiKey = "test-gateway";
  settings.connections.push({ id: "local", kind: AiProviders.Custom, name: "本机", apiKey: "test-local", apiUrl: "http://localhost:11434/v1" });
  const view = JSON.stringify(quickView(settings));
  assert.ok(!view.includes("test-gateway") && !view.includes("test-local") && !view.includes("localhost"), "the page sees no key or address");
  assert.deepEqual(quickView(settings).connections.map(({ name }) => name), ["ChatGPT 账号", "Vercel AI Gateway", "OpenAI", "本机"]);
  assert.deepEqual(quickView(settings).analysis, { connection: AiProviders.VercelAIGateway, model: "typesafe-ai/jev" });
  assert.equal(quickView(settings).language, "zh-CN");

  const changed = applyQuickChange(settings, { language: "en", translation: { connection: "local", model: " llama " } });
  assert.ok(!("error" in changed));
  assert.equal(changed.targetLanguage, "en");
  assert.equal(changed.translation.connection, "local");
  assert.equal(changed.translation.models.local, "llama");
  assert.equal(settings.translation.connection, AiProviders.VercelAIGateway, "the original settings are left alone");
  assert.deepEqual(applyQuickChange(settings, { language: "xx" }), { error: "不支持这个目标语言" });
  assert.deepEqual(applyQuickChange(settings, { analysis: { connection: "gone" } }), { error: "内容分析：选择的连接已被删除，请重新选择。" });
  assert.ok("error" in applyQuickChange(settings, { translation: { connection: AiProviders.VercelAIGateway, model: "no-slash" } }));
});
