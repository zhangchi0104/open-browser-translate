import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Effect, Layer, Redacted, Schema } from "effect";
import { AiError, Decision, DecisionModel } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import { AI, openAIDecisionLayer } from "../src/modules/background/ai";
import { toProviderAnswer } from "../src/modules/background/ai/structured-decisions";
import { fromAnswer } from "../src/modules/background/ai/openai-decisions";
import { blocksIn, decisionsRequest, decisionsResponse } from "./decision-mock";
import { ContentAnalyzer } from "../src/modules/background/content-analyzer";
import { TRANSLATION_PRIORITY, type ContentRole } from "../src/modules/shared/protocol";
import type { TranslatableContent } from "../src/modules/page/block-collector";

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

test("OpenAI decision adapter asks the Decisions API one choice question per block", async () => {
  let calls = 0;
  const fetchMock: typeof globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    assert.equal(String(input), "https://api.openai.com/v1/decisions");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-placeholder");
    const request = decisionsRequest(init);
    assert.equal(request.model, "gpt-6-luna");
    assert.deepEqual(request.questions.map(({ type, name }) => [type, name]), [["choice", "0"]]);
    assert.ok(request.questions[0]!.choices!.every(({ description }) => description), "each role is described");
    return decisionsResponse(init, (key, input, options) => {
      assert.equal(key, "0");
      assert.equal(blocksIn(input)[0]!.text, "Article body");
      assert.deepEqual(options, labels);
      return "content";
    });
  };
  const layer = ContentAnalyzer.Live.pipe(Layer.provide(openAIDecisionLayer({ apiKey: Redacted.make("test-placeholder"), model: "gpt-6-luna" })));
  const result = await Effect.runPromise(ContentAnalyzer.use((service) => service.analyze([content("Article body")])).pipe(Effect.provide(layer), Effect.provideService(FetchHttpClient.Fetch, fetchMock)));
  assert.equal(calls, 1);
  assert.equal(result[0]?.role, "content");
  assert.equal(result[0]?.confidence, 1);
  assert.equal(result[0]?.fallbackReason, undefined);
});

test("Decisions API answers become DecisionModel answers; refusals and mismatched types fail", () => {
  const classify = Decision.classify({ instructions: "Pick", criteria: { a: "A", b: "B" } });
  assert.deepEqual(fromAnswer("x", classify, { type: "choice", name: "x", choice: "a", confidence: 0.9, probabilities: [{ value: "a", probability: 0.7 }, { value: "b", probability: 0.2999 }] }),
    { _tag: "Classify", label: "a", probabilities: { a: 0.7 / 0.9999, b: 0.2999 / 0.9999 }, confidence: 0.9 });
  const rate = Decision.rate({ instructions: "Rate", criteria: ["low", "mid", "high"] });
  assert.deepEqual(fromAnswer("x", rate, { type: "score", name: "x", score: 1.1, confidence: 0.55, probabilities: [
    { value: 0, label: "low", probability: 0.1 }, { value: 1, label: "mid", probability: 0.7 }, { value: 2, label: "high", probability: 0.2 },
  ] }), { _tag: "Rate", rating: 1.1, probabilities: { low: 0.1, mid: 0.7, high: 0.2 }, confidence: 0.55 });
  const probability = Decision.probability({ instructions: "Is it?", criteria: { false: "No", true: "Yes" } });
  assert.deepEqual(fromAnswer("x", probability, { type: "predicate", name: "x", probability: 0.92 }), { _tag: "Probability", probability: 0.92 });

  const refused = fromAnswer("x", classify, { type: "refusal", name: "x" });
  assert.ok(AiError.isAiError(refused) && refused.reason._tag === "ContentPolicyError");
  assert.ok(AiError.isAiError(fromAnswer("x", classify, { type: "predicate", name: "x", probability: 1 })));
  assert.ok(AiError.isAiError(fromAnswer("x", classify, undefined)));
});

test("Decisions API errors stay typed: a bad key, a rate limit, a malformed body", async () => {
  const definition = Decision.make({ input: Schema.String, decisions: { relevant: Decision.probability({ instructions: "Is it?", criteria: { false: "No", true: "Yes" } }) } });
  const decide = (response: Response) => Effect.runPromise(DecisionModel.decide(definition, { input: "Hello" }).pipe(
    Effect.provide(openAIDecisionLayer({ apiKey: Redacted.make("test-placeholder"), model: "gpt-6-luna" })),
    Effect.provideService(FetchHttpClient.Fetch, async () => response.clone()),
    Effect.flip,
  ));
  const unauthorized = await decide(Response.json({ error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } }, { status: 401 }));
  assert.equal(unauthorized.reason._tag, "AuthenticationError");
  assert.match(unauthorized.message, /Incorrect API key provided/);
  assert.equal((await decide(Response.json({ error: { message: "Slow down" } }, { status: 429 }))).reason._tag, "RateLimitError");
  assert.equal((await decide(Response.json({ answers: "nope" }))).reason._tag, "InvalidOutputError");
});

test("model-reported weights are normalized into valid decision answers", () => {
  const classify = Decision.classify({ instructions: "Pick", criteria: { a: "A", b: "B", c: "C" } });
  assert.deepEqual(toProviderAnswer("x", classify, { a: 3, b: 1, c: -2 }), { _tag: "Classify", label: "a", probabilities: { a: 0.75, b: 0.25, c: 0 }, confidence: 0.75 });
  const rate = Decision.rate({ instructions: "Rate", criteria: ["low", "mid", "high"] });
  assert.deepEqual(toProviderAnswer("x", rate, { low: 0, mid: 0.5, high: 0.5 }), { _tag: "Rate", rating: 1.5, probabilities: { low: 0, mid: 0.5, high: 0.5 }, confidence: 0.5 });
  const probability = Decision.probability({ instructions: "Is it?", criteria: { false: "No", true: "Yes" } });
  assert.deepEqual(toProviderAnswer("x", probability, { false: 0.2, true: 0.8 }), { _tag: "Probability", probability: 0.8 });
  assert.ok(AiError.isAiError(toProviderAnswer("x", classify, { a: 0, b: 0, c: 0 })));
});

test("each block gets a translation priority from its role: content first, ads last, unsure treated as unknown", async () => {
  const layer = mockLayer(() => Effect.succeed({ answers: {
    "0": answer("navigation"), "1": answer("content"), "2": answer("advertisement", 0.3), "3": answer("content", 0.5), "4": answer("auxiliary"),
  }, usage: { inputTokens: undefined, outputTokens: undefined } }));
  const result = await Effect.runPromise(ContentAnalyzer.use((service) => service.analyze(["a", "b", "c", "d", "e"].map(content))).pipe(Effect.provide(layer)));
  assert.deepEqual(result.map((item) => item.priority), [2, 0, 1, 1, 3]);
  assert.equal(TRANSLATION_PRIORITY.content < TRANSLATION_PRIORITY.navigation && TRANSLATION_PRIORITY.navigation < TRANSLATION_PRIORITY.advertisement, true);

  const failed = mockLayer(() => Effect.fail(AiError.make({ module: "Test", method: "decide", reason: new AiError.UnknownError({}) })));
  const fallback = await Effect.runPromise(ContentAnalyzer.use((service) => service.analyze([content("x")])).pipe(Effect.provide(failed)));
  assert.equal(fallback[0]!.priority, TRANSLATION_PRIORITY.unknown, "a block analysis couldn't classify isn't pushed back");
});
