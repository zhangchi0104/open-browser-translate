import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Effect } from "effect";
import { modelsFor } from "../src/modules/background/ai/models";
import { FetchHttpClient } from "effect/unstable/http";
import { defaultSettings } from "../src/modules/shared/settings/model";
import { AiProviders } from "../src/modules/shared/settings/model";
import { decideTranslationPlan } from "../src/modules/background/content-analyzer/page-plan";
import { translateBatch } from "../src/modules/background/translation-service/translate-batch";
import { blocksIn, chatCompletion, chatCompletionStream, chatRequest, decisionResponse, isDecisionRequest, translationInput, type ChatRequest } from "./decision-mock";

const settings = structuredClone(defaultSettings);
settings.analysis.provider = AiProviders.OpenAIApi;
settings.providers.VercelAIGateway.apiKey = "test-placeholder";
settings.providers.OpenAIApi.apiKey = "test-openai";
settings.translation.models.VercelAIGateway = "test/translator";
function mockFetch(output: unknown, requests: string[], bodies: ChatRequest[] = []): typeof globalThis.fetch {
  return async (input, init) => {
    requests.push(String(input));
    const body = chatRequest(init);
    bodies.push(body);
    if (isDecisionRequest(body)) {
      assert.equal(String(input), "https://api.openai.com/v1/chat/completions");
      assert.equal(body.model, "gpt-6-luna");
      return decisionResponse(body, (key, state) => key === "mode" ? "main" : key === "navigation" ? "paginated"
        : blocksIn(state).find((block) => block.id === key)?.text === "Home" ? "navigation" : "content");
    }
    assert.equal(body.model, "test/translator");
    assert.ok(body.response_format);
    return chatCompletion(body.model, JSON.stringify(output));
  };
}

test("OpenAI plans the page's scope, and translation goes to the translation model", async () => {
  const requests: string[] = [];
  const fetch = mockFetch({ translations: [{ id: 0, text: "你好，世界" }], terms: [] }, requests);
  const plan = await Effect.runPromise(decideTranslationPlan({ title: "Article", sample: "Text", hasArticle: true, pagination: ["Next"] }).pipe(Effect.provide(modelsFor(settings)), Effect.provideService(FetchHttpClient.Fetch, fetch)));
  assert.deepEqual(plan, { mode: "main", navigation: "paginated", fallback: false });
  const result = await Effect.runPromise(translateBatch([{ text: "Hello world", tag: "p" }]).pipe(Effect.provide(modelsFor(settings)), Effect.provideService(FetchHttpClient.Fetch, fetch)));
  assert.deepEqual(result, { status: "ok", translations: ["你好，世界"], terms: [] });
  assert.equal(requests.filter((url) => url.startsWith("https://ai-gateway.vercel.sh/")).length, 1);
});

test("duplicate or missing translation IDs fail instead of displaying mismatched text", async () => {
  const result = await Effect.runPromise(translateBatch([{ text: "Hello", tag: "p" }, { text: "World", tag: "p" }]).pipe(Effect.provide(modelsFor(settings)), Effect.provideService(FetchHttpClient.Fetch, mockFetch({ translations: [{ id: 0, text: "你好" }, { id: 0, text: "世界" }], terms: [] }, []))));
  assert.equal(result.status, "failed");
  assert.ok(result.status === "failed" && result.error, "the failure carries its cause for the debug log");
  assert.match(result.error, /TranslationOutputError: expected 2 translations, got 2; missing ids \[1\]; duplicate ids \[0\]/);
});

test("missing translation configuration makes no provider request", async () => {
  const missing = structuredClone(settings);
  missing.translation.models.VercelAIGateway = "";
  const result = await Effect.runPromise(translateBatch([{ text: "Hello", tag: "p" }]).pipe(Effect.provide(modelsFor(missing))));
  assert.deepEqual(result, { status: "not-configured", purpose: "translation" });
});

test("site context rides along in the translation prompt and terms come back", async () => {
  const bodies: ChatRequest[] = [];
  const fetch = mockFetch({ translations: [{ id: 0, text: "Effect 运行时" }], terms: [{ source: "Effect", target: "Effect" }] }, [], bodies);
  const context = { pages: ["Effect docs"], glossary: [{ source: "runtime", target: "运行时" }], recent: [{ source: "Fibers", target: "纤程" }] };
  const result = await Effect.runPromise(translateBatch([{ text: "Effect runtime", tag: "p" }], { context }).pipe(Effect.provide(modelsFor(settings)), Effect.provideService(FetchHttpClient.Fetch, fetch)));
  assert.deepEqual(result, { status: "ok", translations: ["Effect 运行时"], terms: [{ source: "Effect", target: "Effect" }] });
  const chat = bodies.find((body) => !isDecisionRequest(body))!;
  assert.deepEqual(translationInput(chat), { context, blocks: [{ id: 0, text: "Effect runtime" }] });
});

test("a batch traces translation as its own step, down to the model calls", async () => {
  const { createLocalTracer, traced } = await import("../src/modules/shared/debug-log/trace");
  const spans: import("../src/modules/shared/debug-log/trace").OtlpSpan[] = [];
  const tracer = createLocalTracer((span) => spans.push(span));
  const fetch = mockFetch({ translations: [{ id: 0, text: "你好" }], terms: [] }, []);
  await Effect.runPromise(traced(translateBatch([{ text: "Hello world", tag: "p" }]).pipe(Effect.provide(modelsFor(settings))), tracer).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)));
  const byName = (name: string) => spans.find((span) => span.name === name)!;
  const translation = byName("translation");
  assert.ok(spans.some((span) => span.name.startsWith("LanguageModel.") && span.parentSpanId === translation.spanId));
  assert.deepEqual(translation.attributes.find((a) => a.key === "gen_ai.request.model")?.value, { stringValue: "test/translator" });
  assert.deepEqual(translation.status, { code: 1 });

  spans.length = 0;
  const broken = mockFetch({ translations: [{ id: 0, text: "你好" }, { id: 0, text: "重复" }], terms: [] }, []);
  await Effect.runPromise(traced(translateBatch([{ text: "Hello", tag: "p" }, { text: "World", tag: "p" }]).pipe(Effect.provide(modelsFor(settings))), tracer).pipe(Effect.provideService(FetchHttpClient.Fetch, broken)));
  assert.equal(byName("translation").status.code, 2, "the failing step is marked as an error");
});

/** A streamed Chat Completions response that writes `content` a few characters at a time. */
function streamingFetch(content: string, bodies: ChatRequest[] = []): typeof globalThis.fetch {
  return async (input, init) => {
    const body = chatRequest(init);
    bodies.push(body);
    if (isDecisionRequest(body)) return decisionResponse(body, () => "content");
    assert.equal(body.stream, true, "translation streams when the caller wants partial results");
    return chatCompletionStream(body.model, content);
  };
}

test("streaming translation reports each block's text as it grows, then the validated result", async () => {
  const output = { translations: [{ id: 0, text: "你好，世界" }, { id: 1, text: "第二段译文" }], terms: [{ source: "World", target: "世界" }] };
  const partials: [number, string][] = [];
  const blocks = [{ text: "Hello, world", tag: "p" }, { text: "Second paragraph", tag: "p" }];
  const result = await Effect.runPromise(translateBatch(blocks, { onPartial: (index, text) => partials.push([index, text]) })
    .pipe(Effect.provide(modelsFor(settings)), Effect.provideService(FetchHttpClient.Fetch, streamingFetch(JSON.stringify(output)))));
  assert.deepEqual(result, { status: "ok", translations: ["你好，世界", "第二段译文"], terms: output.terms });
  const first = partials.filter(([index]) => index === 0).map(([, text]) => text);
  assert.ok(first.length > 1, "the first block arrives in several steps");
  assert.ok(first.every((text, step) => step === 0 || text.startsWith(first[step - 1]!)), "each step extends the previous text");
  assert.equal(first.at(-1), "你好，世界");
  assert.equal(partials.filter(([index]) => index === 1).at(-1)?.[1], "第二段译文");
});

test("a streamed response that isn't the promised JSON fails the batch with the reason", async () => {
  const blocks = [{ text: "Hello", tag: "p" }];
  const garbled = await Effect.runPromise(translateBatch(blocks, { onPartial: () => {} })
    .pipe(Effect.provide(modelsFor(settings)), Effect.provideService(FetchHttpClient.Fetch, streamingFetch('{"translations":[{"id":0,"text":"你'))));
  assert.equal(garbled.status, "failed");
  assert.match(garbled.status === "failed" ? garbled.error ?? "" : "", /TranslationOutputError: .*JSON/);
  const missing = await Effect.runPromise(translateBatch([...blocks, { text: "World", tag: "p" }], { onPartial: () => {} })
    .pipe(Effect.provide(modelsFor(settings)), Effect.provideService(FetchHttpClient.Fetch, streamingFetch(JSON.stringify({ translations: [{ id: 0, text: "你好" }], terms: [] })))));
  assert.match(missing.status === "failed" ? missing.error ?? "" : "", /missing ids \[1\]/);
});
