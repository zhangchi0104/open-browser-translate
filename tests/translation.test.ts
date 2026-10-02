import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { defaultSettings } from "../src/modules/settings/model";
import { decideTranslationPlan } from "../src/modules/content-analyzer/page-plan";
import { translateBatch } from "../src/modules/translator/translate-batch";

const settings = structuredClone(defaultSettings);
settings.providers.VercelAIGateway.apiKey = "test-placeholder";
settings.translation.models.VercelAIGateway = "test/translator";
function choice(label: string, labels: string[]) {
  return { type: "choice", choice: label, confidence: 1, probabilities: Object.fromEntries(labels.map((key) => [key, key === label ? 1 : 0])) };
}
function mockFetch(output: unknown, requests: string[], bodies: any[] = []): typeof globalThis.fetch {
  return async (input, init) => {
    requests.push(String(input));
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if (String(input).endsWith("systemone")) {
      const answers = body.questions.mode ? {
        mode: choice("main", ["all", "main"]), navigation: choice("paginated", ["single", "paginated", "dynamic"]),
      } : Object.fromEntries(body.state.blocks.map((block: {id:string;text:string}) => [block.id, choice(block.text === "Home" ? "navigation" : "content", ["content", "navigation", "control", "auxiliary", "advertisement", "unknown"])]));
      return Response.json({ model: body.model, answers });
    }
    assert.equal(body.model, "test/translator");
    assert.ok(body.response_format);
    return Response.json({ id: "test", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(output) }, finish_reason: "stop" }] });
  };
}

test("Jev plans scope and translation maps only retained blocks back in order", async () => {
  const requests: string[] = [];
  const fetch = mockFetch({ translations: [{ id: 0, text: "你好，世界" }], terms: [] }, requests);
  const plan = await Effect.runPromise(decideTranslationPlan({ title: "Article", sample: "Text", hasArticle: true, pagination: ["Next"] }, settings).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)));
  assert.deepEqual(plan, { mode: "main", navigation: "paginated", fallback: false });
  const result = await Effect.runPromise(translateBatch([{ text: "Home", tag: "a" }, { text: "Hello world", tag: "p" }], plan.mode, settings).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)));
  assert.deepEqual(result, { status: "ok", translations: [null, "你好，世界"], terms: [], analysisFallbackCount: 0 });
  assert.equal(requests.filter((url) => url.endsWith("chat/completions")).length, 1);
});

test("duplicate or missing translation IDs fail instead of displaying mismatched text", async () => {
  const result = await Effect.runPromise(translateBatch([{ text: "Hello", tag: "p" }, { text: "World", tag: "p" }], "all", settings).pipe(Effect.provideService(FetchHttpClient.Fetch, mockFetch({ translations: [{ id: 0, text: "你好" }, { id: 0, text: "世界" }], terms: [] }, []))));
  assert.deepEqual(result, { status: "failed" });
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
  const chat = bodies.find((body) => Array.isArray(body.messages));
  assert.deepEqual(JSON.parse(chat.messages.at(-1).content), { context, blocks: [{ id: 0, text: "Effect runtime" }] });
});
