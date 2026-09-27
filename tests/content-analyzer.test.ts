import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Effect, Layer, Redacted } from "effect";
import { DecisionModel } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import { AI, jevLayer } from "../src/modules/ai";
import { ContentAnalyzer, type ContentRole } from "../src/modules/content-analyzer";
import type { TranslatableContent } from "../src/modules/dom-parser";

const content = (text: string): TranslatableContent => ({
  element: { tagName: "P" } as Element,
  text,
  tag: "p",
  segments: [],
});
const labels: ContentRole[] = ["content", "navigation", "control", "auxiliary", "advertisement", "unknown"];
function answer(label: ContentRole, confidence = 1): DecisionModel.ProviderClassifyAnswer {
  return { _tag: "Classify", label, confidence, probabilities: Object.fromEntries(labels.map((key) => [key, key === label ? 1 : 0])) };
}
function mockLayer(decide: Parameters<typeof DecisionModel.make>[0]["decide"]) {
  return ContentAnalyzer.Live.pipe(Layer.provide(Layer.effect(AI, DecisionModel.make({ decide }))));
}

test("classifies with full source mapping and keeps uncertain decisions", async () => {
  const items = labels.map(content);
  const layer = mockLayer(({ decisions, state }) => {
    assert.equal(JSON.stringify(state).includes("segments"), false);
    assert.ok(decisions["0"]?.instructions.includes("block id 0"));
    return Effect.succeed({ answers: Object.fromEntries(labels.map((label, index) => [String(index), answer(label, label === "advertisement" ? 0.2 : 1)])), usage: { inputTokens: 10, outputTokens: 10 } });
  });
  const result = await Effect.runPromise(ContentAnalyzer.use((service) => service.analyze(items, { mode: "main" })).pipe(Effect.provide(layer)));
  assert.deepEqual(result.map((item) => item.shouldTranslate), [true, false, false, false, true, true]);
  result.forEach((item, index) => assert.equal(item.content, items[index]));
});

test("all mode keeps navigation and controls", async () => {
  const layer = mockLayer(() => Effect.succeed({ answers: { "0": answer("navigation"), "1": answer("control") }, usage: { inputTokens: undefined, outputTokens: undefined } }));
  const result = await Effect.runPromise(ContentAnalyzer.use((service) => service.analyze([content("Home"), content("Search")])).pipe(Effect.provide(layer)));
  assert.deepEqual(result.map((item) => item.shouldTranslate), [true, true]);
});

test("invalid provider output falls back without discarding content", async () => {
  const layer = mockLayer(() => Effect.succeed({ answers: {}, usage: { inputTokens: undefined, outputTokens: undefined } }));
  const result = await Effect.runPromise(ContentAnalyzer.use((service) => service.analyze([content("Hello")])).pipe(Effect.provide(layer)));
  assert.equal(result[0]?.fallbackReason, "request-failed");
  assert.equal(result[0]?.shouldTranslate, true);
});

test("empty and oversized input do not call AI; batches preserve order", async () => {
  let calls = 0;
  const layer = mockLayer(({ decisions }) => {
    calls++;
    assert.ok(Object.keys(decisions).length <= 8);
    return Effect.succeed({ answers: Object.fromEntries(Object.keys(decisions).map((key) => [key, answer("content")])), usage: { inputTokens: undefined, outputTokens: undefined } });
  });
  const items = Array.from({ length: 17 }, (_, index) => content(`Block ${index}`));
  await Effect.runPromise(Effect.gen(function* () {
    const service = yield* ContentAnalyzer;
    assert.deepEqual(yield* service.analyze([]), []);
    assert.equal((yield* service.analyze([content("x".repeat(2001))]))[0]?.fallbackReason, "input-too-large");
    assert.equal(calls, 0);
    const result = yield* service.analyze(items);
    assert.deepEqual(result.map((item) => item.content), items);
    assert.equal(calls, 3);
  }).pipe(Effect.provide(layer)));
});

test("official Jev adapter sends System One questions and decodes answers", async () => {
  let calls = 0;
  const fetchMock: typeof globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    assert.equal(String(input), "https://api.typesafe.ai/v1/systemone");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-placeholder");
    const request = JSON.parse(String(init?.body));
    assert.equal(request.model, "jev-latest");
    assert.equal(request.questions["0"].type, "choice");
    assert.equal(request.state.blocks[0].text, "Article body");
    return new Response(JSON.stringify({ model: "jev-latest", answers: { "0": { type: "choice", choice: "content", confidence: 1, probabilities: answer("content").probabilities } } }), { headers: { "Content-Type": "application/json" } });
  };
  const layer = ContentAnalyzer.Live.pipe(Layer.provide(jevLayer({ apiKey: Redacted.make("test-placeholder") })));
  const result = await Effect.runPromise(ContentAnalyzer.use((service) => service.analyze([content("Article body")])).pipe(Effect.provide(layer), Effect.provideService(FetchHttpClient.Fetch, fetchMock)));
  assert.equal(calls, 1);
  assert.equal(result[0]?.role, "content");
  assert.equal(result[0]?.fallbackReason, undefined);
});
