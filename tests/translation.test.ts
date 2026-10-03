import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { defaultSettings } from "../src/modules/settings/model";
import { AiProviders } from "../src/modules/ai/providers";
import { decideTranslationPlan } from "../src/modules/content-analyzer/page-plan";
import { translateBatch } from "../src/modules/translator/translate-batch";
import { decisionResponse, isDecisionRequest } from "./decision-mock";

const settings = structuredClone(defaultSettings);
settings.analysis.provider = AiProviders.OpenAIApi;
settings.providers.VercelAIGateway.apiKey = "test-placeholder";
settings.providers.OpenAIApi.apiKey = "test-openai";
settings.translation.models.VercelAIGateway = "test/translator";
function mockFetch(output: unknown, requests: string[], bodies: any[] = []): typeof globalThis.fetch {
  return async (input, init) => {
    requests.push(String(input));
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if (isDecisionRequest(body)) {
      assert.equal(String(input), "https://api.openai.com/v1/chat/completions");
      assert.equal(body.model, "gpt-6-luna");
      return decisionResponse(body, (key, state) => key === "mode" ? "main" : key === "navigation" ? "paginated"
        : state.blocks.find((block: { id: string }) => block.id === key).text === "Home" ? "navigation" : "content");
    }
    assert.equal(body.model, "test/translator");
    assert.ok(body.response_format);
    return Response.json({ id: "test", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(output) }, finish_reason: "stop" }] });
  };
}

test("OpenAI plans scope and translation maps only retained blocks back in order", async () => {
  const requests: string[] = [];
  const fetch = mockFetch({ translations: [{ id: 0, text: "你好，世界" }], terms: [] }, requests);
  const plan = await Effect.runPromise(decideTranslationPlan({ title: "Article", sample: "Text", hasArticle: true, pagination: ["Next"] }, settings).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)));
  assert.deepEqual(plan, { mode: "main", navigation: "paginated", fallback: false });
  const result = await Effect.runPromise(translateBatch([{ text: "Home", tag: "a" }, { text: "Hello world", tag: "p" }], plan.mode, settings).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)));
  assert.deepEqual(result, { status: "ok", translations: [null, "你好，世界"], terms: [], analysisFallbackCount: 0 });
  assert.equal(requests.filter((url) => url.startsWith("https://ai-gateway.vercel.sh/")).length, 1);
});

test("duplicate or missing translation IDs fail instead of displaying mismatched text", async () => {
  const result = await Effect.runPromise(translateBatch([{ text: "Hello", tag: "p" }, { text: "World", tag: "p" }], "all", settings).pipe(Effect.provideService(FetchHttpClient.Fetch, mockFetch({ translations: [{ id: 0, text: "你好" }, { id: 0, text: "世界" }], terms: [] }, []))));
  assert.equal(result.status, "failed");
  assert.ok(result.status === "failed" && result.error, "the failure carries its cause for the debug log");
  assert.match(result.error, /TranslationOutputError: expected 2 translations, got 2; missing ids \[1\]; duplicate ids \[0\]/);
});

test("missing translation configuration makes no provider request", async () => {
  const missing = structuredClone(settings);
  missing.translation.models.VercelAIGateway = "";
  const result = await Effect.runPromise(translateBatch([{ text: "Hello", tag: "p" }], "all", missing));
  assert.deepEqual(result, { status: "not-configured", purpose: "translation" });
});

test("site context rides along in the translation prompt and terms come back", async () => {
  const bodies: any[] = [];
  const fetch = mockFetch({ translations: [{ id: 0, text: "Effect 运行时" }], terms: [{ source: "Effect", target: "Effect" }] }, [], bodies);
  const context = { pages: ["Effect docs"], glossary: [{ source: "runtime", target: "运行时" }], recent: [{ source: "Fibers", target: "纤程" }] };
  const result = await Effect.runPromise(translateBatch([{ text: "Effect runtime", tag: "p" }], "all", settings, undefined, context).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)));
  assert.deepEqual(result, { status: "ok", translations: ["Effect 运行时"], terms: [{ source: "Effect", target: "Effect" }], analysisFallbackCount: 0 });
  const chat = bodies.find((body) => Array.isArray(body.messages) && !isDecisionRequest(body));
  assert.deepEqual(JSON.parse(chat.messages.at(-1).content), { context, blocks: [{ id: 0, text: "Effect runtime" }] });
});

test("a batch traces analysis and translation as separate steps, down to the model calls", async () => {
  const { createLocalTracer, traced } = await import("../src/modules/debug-log/trace");
  const spans: import("../src/modules/debug-log/trace").OtlpSpan[] = [];
  const tracer = createLocalTracer((span) => spans.push(span));
  const fetch = mockFetch({ translations: [{ id: 0, text: "你好" }], terms: [] }, []);
  await Effect.runPromise(traced(translateBatch([{ text: "Hello world", tag: "p" }], "all", settings), tracer).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)));
  const byName = (name: string) => spans.find((span) => span.name === name)!;
  const analysis = byName("content-analysis");
  const translation = byName("translation");
  assert.equal(byName("DecisionModel.decide").parentSpanId, analysis.spanId);
  assert.ok(spans.some((span) => span.name.startsWith("LanguageModel.") && span.parentSpanId === translation.spanId));
  assert.deepEqual(translation.attributes.find((a) => a.key === "gen_ai.request.model")?.value, { stringValue: "test/translator" });
  assert.deepEqual(analysis.status, { code: 1 });

  spans.length = 0;
  const broken = mockFetch({ translations: [{ id: 0, text: "你好" }, { id: 0, text: "重复" }], terms: [] }, []);
  await Effect.runPromise(traced(translateBatch([{ text: "Hello", tag: "p" }, { text: "World", tag: "p" }], "all", settings), tracer).pipe(Effect.provideService(FetchHttpClient.Fetch, broken)));
  assert.equal(byName("translation").status.code, 2, "the failing step is marked as an error");
  assert.equal(byName("content-analysis").status.code, 1);
});

/** A streamed Chat Completions response that writes `content` a few characters at a time. */
function streamingFetch(content: string, bodies: any[] = []): typeof globalThis.fetch {
  return async (input, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if (isDecisionRequest(body)) return decisionResponse(body, () => "content");
    assert.equal(body.stream, true, "translation streams when the caller wants partial results");
    const chunk = (delta: object, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const pieces = content.match(/[\s\S]{1,7}/g) ?? [];
    const sse = chunk({ role: "assistant", content: "" }) + pieces.map((piece) => chunk({ content: piece })).join("") + chunk({}, "stop") + "data: [DONE]\n\n";
    return new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
  };
}

test("streaming translation reports each block's text as it grows, then the validated result", async () => {
  const output = { translations: [{ id: 0, text: "你好，世界" }, { id: 1, text: "第二段译文" }], terms: [{ source: "World", target: "世界" }] };
  const partials: [number, string][] = [];
  const blocks = [{ text: "Hello, world", tag: "p" }, { text: "Second paragraph", tag: "p" }];
  const result = await Effect.runPromise(translateBatch(blocks, "all", settings, undefined, undefined, (index, text) => partials.push([index, text]))
    .pipe(Effect.provideService(FetchHttpClient.Fetch, streamingFetch(JSON.stringify(output)))));
  assert.deepEqual(result, { status: "ok", translations: ["你好，世界", "第二段译文"], terms: output.terms, analysisFallbackCount: 0 });
  const first = partials.filter(([index]) => index === 0).map(([, text]) => text);
  assert.ok(first.length > 1, "the first block arrives in several steps");
  assert.ok(first.every((text, step) => step === 0 || text.startsWith(first[step - 1]!)), "each step extends the previous text");
  assert.equal(first.at(-1), "你好，世界");
  assert.equal(partials.filter(([index]) => index === 1).at(-1)?.[1], "第二段译文");
});

test("a streamed response that isn't the promised JSON fails the batch with the reason", async () => {
  const blocks = [{ text: "Hello", tag: "p" }];
  const garbled = await Effect.runPromise(translateBatch(blocks, "all", settings, undefined, undefined, () => {})
    .pipe(Effect.provideService(FetchHttpClient.Fetch, streamingFetch('{"translations":[{"id":0,"text":"你'))));
  assert.equal(garbled.status, "failed");
  assert.match(garbled.status === "failed" ? garbled.error ?? "" : "", /TranslationOutputError: .*JSON/);
  const missing = await Effect.runPromise(translateBatch([...blocks, { text: "World", tag: "p" }], "all", settings, undefined, undefined, () => {})
    .pipe(Effect.provideService(FetchHttpClient.Fetch, streamingFetch(JSON.stringify({ translations: [{ id: 0, text: "你好" }], terms: [] })))));
  assert.match(missing.status === "failed" ? missing.error ?? "" : "", /missing ids \[1\]/);
});
