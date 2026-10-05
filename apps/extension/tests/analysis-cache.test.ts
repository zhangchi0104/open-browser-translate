import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { modelsFor } from "../src/modules/background/ai/models";
import { createCache, createMemoryCacheStore } from "../src/modules/background/cache-store";
import { analyzePageContent } from "../src/modules/background/content-analyzer/page-analysis";
import type { Mode } from "../src/modules/shared/protocol";
import { AiProviders, defaultSettings, findConnection } from "../src/modules/shared/settings/model";
import { blocksIn, chatRequest, decisionResponse } from "./decision-mock";

const settings = structuredClone(defaultSettings);
settings.analysis.connection = AiProviders.OpenAIApi;
findConnection(settings, AiProviders.OpenAIApi)!.apiKey = "test-openai";
const SITE = "https://docs.example.com";

/** An analysis model that calls "Home" navigation and anything else content, recording what it was asked. */
function analysisModel() {
  const asked: string[][] = [];
  let failing = false;
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const body = chatRequest(init);
    if (failing) return Response.json({ error: { message: "model down" } }, { status: 500 });
    let texts: string[] = [];
    const response = decisionResponse(body, (key, input) => {
      texts = blocksIn(input).map(({ text }) => text);
      return texts[Number(key)] === "Home" ? "navigation" : "content";
    });
    asked.push(texts);
    return response;
  };
  return { fetch, asked, fail: () => { failing = true; } };
}

const blocks = (...texts: string[]) => texts.map((text) => ({ text, tag: "p" }));

function analyze(model: ReturnType<typeof analysisModel>, cache: ReturnType<typeof createCache>, texts: string[], mode: Mode, site: string | undefined) {
  return Effect.runPromise(analyzePageContent(blocks(...texts), mode, { cache, site }).pipe(
    Effect.provide(modelsFor(settings)),
    Effect.provideService(FetchHttpClient.Fetch, model.fetch),
  ));
}

test("a site's blocks are classified once; the mode still decides what a cached role means", async () => {
  const model = analysisModel();
  const cache = createCache(createMemoryCacheStore());
  const first = await analyze(model, cache, ["Home", "Intro"], "all", SITE);
  assert.deepEqual(first, { status: "ok", blocks: [{ keep: true, priority: 2 }, { keep: true, priority: 0 }], fallbackCount: 0 });

  const second = await analyze(model, cache, ["Body", "Home", "Intro"], "main", SITE);
  assert.deepEqual(model.asked, [["Home", "Intro"], ["Body"]], "only the new block reaches the model");
  assert.deepEqual(second, {
    status: "ok",
    blocks: [{ keep: true, priority: 0 }, { keep: false, priority: 2 }, { keep: true, priority: 0 }],
    fallbackCount: 0,
  }, "cached navigation is dropped in main mode");

  await analyze(model, cache, ["Home"], "all", "https://other.example.com");
  assert.equal(model.asked.length, 3, "another site doesn't share the entries");
});

test("failed analyses aren't cached, and pages without a site keep nothing", async () => {
  const model = analysisModel();
  const store = createMemoryCacheStore();
  const cache = createCache(store);
  model.fail();
  const failed = await analyze(model, cache, ["Intro"], "all", SITE);
  assert.equal(failed.status === "ok" && failed.fallbackCount, 1);
  assert.equal(await store.count(), 0);

  const healthy = analysisModel();
  await analyze(healthy, cache, ["Intro"], "all", undefined);
  await analyze(healthy, cache, ["Intro"], "all", undefined);
  assert.equal(healthy.asked.length, 2);
  assert.equal(await store.count(), 0);
});
