import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { modelsFor } from "../src/modules/ai/models";
import { translatePageBatch, type BatchStores } from "../src/modules/batch-translation";
import { createLocalTracer, traced, type OtlpSpan } from "../src/modules/debug-log/trace";
import { defaultSettings } from "../src/modules/settings/model";
import { createMemoryCacheStore, createTranslationCache } from "../src/modules/translation-cache";
import type { TranslationContext } from "../src/modules/translation-context";
import { createContextCarryover } from "../src/modules/translation-context/carryover";
import { chatCompletion, chatCompletionStream } from "./decision-mock";

const settings = structuredClone(defaultSettings);
settings.providers.VercelAIGateway.apiKey = "test-gateway";
settings.translation.models.VercelAIGateway = "test/translator";

const PAGE = "https://docs.example.com/guide?q=1";

/** A translation model that renders each block as `译：<text>` and reports "Fiber" as a term. */
function translationModel() {
  const requests: { texts: string[]; context?: unknown }[] = [];
  let failing = false;
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    const input = JSON.parse(body.messages.at(-1).content);
    requests.push({ texts: input.blocks.map((block: { text: string }) => block.text), context: input.context });
    if (failing) return Response.json({ error: { message: "model down" } }, { status: 500 });
    const output = JSON.stringify({
      translations: input.blocks.map(({ id, text }: { id: number; text: string }) => ({ id, text: `译：${text}` })),
      terms: input.blocks.some(({ text }: { text: string }) => text.includes("Fiber")) ? [{ source: "Fiber", target: "纤程" }] : [],
    });
    return body.stream ? chatCompletionStream(body.model, output) : chatCompletion(body.model, output);
  };
  return { fetch, requests, fail: () => { failing = true; } };
}

function memoryStores() {
  let contexts: Record<string, TranslationContext> | undefined;
  const cacheStore = createMemoryCacheStore();
  const stores: BatchStores = {
    cache: createTranslationCache(cacheStore),
    contexts: createContextCarryover({ get: async () => contexts, set: async (value) => { contexts = value; } }),
  };
  return { stores, cacheStore, savedContexts: () => contexts };
}

const blocks = (...texts: string[]) => texts.map((text) => ({ text, tag: "p" }));

function translate(model: ReturnType<typeof translationModel>, stores: BatchStores, texts: string[], ...page: [pageUrl?: string]) {
  const pageUrl = page.length ? page[0] : PAGE;
  const shown: [number, string, boolean][] = [];
  return Effect.runPromise(translatePageBatch(blocks(...texts), pageUrl, stores, (index, text, final) => shown.push([index, text, final])).pipe(
    Effect.provide(modelsFor(settings)),
    Effect.provideService(FetchHttpClient.Fetch, model.fetch),
  )).then((result) => ({ result, shown }));
}

test("cached blocks show at once and final; only the rest reach the model, and every block lands at its own index", async () => {
  const model = translationModel();
  const { stores } = memoryStores();
  await translate(model, stores, ["Alpha", "Beta"]);

  const { result, shown } = await translate(model, stores, ["Gamma", "Alpha", "Beta"]);
  assert.deepEqual(model.requests.map(({ texts }) => texts), [["Alpha", "Beta"], ["Gamma"]], "only the uncached block is sent");
  assert.deepEqual(result, { status: "ok", translations: ["译：Gamma", "译：Alpha", "译：Beta"], terms: [], cacheHits: 2 });
  assert.deepEqual(shown.filter(([, , final]) => final), [[1, "译：Alpha", true], [2, "译：Beta", true]]);
  const streamed = shown.filter(([, , final]) => !final);
  assert.ok(streamed.length > 0 && streamed.every(([index]) => index === 0), "the streamed block is reported at its index in the batch, not among the misses");
  assert.equal(streamed.at(-1)![1], "译：Gamma");

  const cachedOnly = await translate(model, stores, ["Beta"]);
  assert.equal(model.requests.length, 2, "a fully cached batch makes no request");
  assert.deepEqual(cachedOnly.result, { status: "ok", translations: ["译：Beta"], terms: [], cacheHits: 1 });
});

test("the site's context from earlier batches rides along with later ones on any of its pages", async () => {
  const model = translationModel();
  const { stores } = memoryStores();
  await translate(model, stores, ["A Fiber is a virtual thread"]);
  await stores.contexts.flush();
  await translate(model, stores, ["Forking a Fiber"], "https://docs.example.com/other");
  const sent = model.requests[1]!.context as { glossary: unknown[]; recent: unknown[] };
  assert.deepEqual(sent.glossary, [{ source: "Fiber", target: "纤程" }]);
  assert.deepEqual(sent.recent, [{ source: "A Fiber is a virtual thread", target: "译：A Fiber is a virtual thread" }]);
});

test("a page without a site (private windows, browser pages) keeps no cache entries and no context", async () => {
  for (const pageUrl of [undefined, "chrome://extensions"]) {
    const model = translationModel();
    const { stores, cacheStore, savedContexts } = memoryStores();
    await translate(model, stores, ["A Fiber"], pageUrl);
    await translate(model, stores, ["A Fiber"], pageUrl);
    await stores.contexts.flush();
    assert.equal(model.requests.length, 2, `${pageUrl}: nothing was served from a cache`);
    assert.equal(model.requests[1]!.context, undefined, `${pageUrl}: no context was sent`);
    assert.equal(await cacheStore.count(), 0);
    assert.equal(savedContexts(), undefined);
  }
});

test("when the model fails, the cached blocks were already delivered final and nothing new is kept", async () => {
  const model = translationModel();
  const { stores, cacheStore } = memoryStores();
  await translate(model, stores, ["Alpha"]);
  model.fail();
  const { result, shown } = await translate(model, stores, ["Alpha", "Beta"]);
  assert.equal(result.status, "failed");
  assert.deepEqual(shown, [[0, "译：Alpha", true]]);
  assert.equal(await cacheStore.count(), 1);
});

test("the model call is traced inside the request that asked for it", async () => {
  const model = translationModel();
  const { stores } = memoryStores();
  const spans: OtlpSpan[] = [];
  await Effect.runPromise(traced(translatePageBatch(blocks("Alpha"), PAGE, stores).pipe(
    Effect.withSpan("translate-content"),
    Effect.provide(modelsFor(settings)),
  ), createLocalTracer((span) => spans.push(span))).pipe(Effect.provideService(FetchHttpClient.Fetch, model.fetch)));
  const request = spans.find((span) => span.name === "translate-content")!;
  assert.equal(spans.find((span) => span.name === "translation")!.parentSpanId, request.spanId);
  assert.deepEqual(request.attributes.find((a) => a.key === "obt.cache.hits")?.value, { intValue: "0" });
});
