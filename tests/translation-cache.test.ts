import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  CACHE_TTL, createMemoryCacheStore, createTranslationCache, translateWithCache, type CacheScope,
} from "../src/modules/translation-cache";
import type { TranslationBatchResult } from "../src/modules/translator/translate-batch";

const scope: CacheScope = { origin: "https://example.com", target: "简体中文", provider: "VercelAIGateway", model: "openai/gpt-6-luna" };
const block = (text: string) => ({ text, tag: "p" });
const ok = (translations: string[]): TranslationBatchResult => ({ status: "ok", translations, terms: [] });

test("a cached block is served without the model; only the misses are translated", async () => {
  const cache = createTranslationCache(createMemoryCacheStore());
  const asked: string[][] = [];
  const translate = async (blocks: readonly { text: string }[]) => {
    asked.push(blocks.map(({ text }) => text));
    return ok(blocks.map(({ text }) => `译：${text}`));
  };
  const first = await translateWithCache({ cache, scope, blocks: [block("Hello"), block("Home")], translate });
  assert.deepEqual(first, { ...ok(["译：Hello", "译：Home"]), cacheHits: 0 });

  const shown: [number, string][] = [];
  const second = await translateWithCache({ cache, scope, blocks: [block("New"), block("Hello"), block("Home")], translate, onCached: (index, text) => shown.push([index, text]) });
  assert.deepEqual(asked, [["Hello", "Home"], ["New"]], "only the uncached block goes to the model");
  assert.deepEqual(second, { ...ok(["译：New", "译：Hello", "译：Home"]), cacheHits: 2 });
  assert.deepEqual(shown, [[1, "译：Hello"], [2, "译：Home"]], "cached translations show right away");

  const allCached = await translateWithCache({ cache, scope, blocks: [block("Hello")], translate });
  assert.equal(asked.length, 2, "a fully cached batch makes no request");
  assert.deepEqual(allCached, { ...ok(["译：Hello"]), cacheHits: 1 });
});

test("the model, site and target language are part of the key", async () => {
  const cache = createTranslationCache(createMemoryCacheStore());
  await cache.put(scope, [{ text: "Hello", translation: "你好" }]);
  assert.deepEqual(await cache.get(scope, ["Hello"]), ["你好"]);
  for (const other of [{ model: "vendor/other" }, { origin: "https://other.com" }, { target: "日本語" }, { provider: "OpenAIApi" }]) {
    assert.deepEqual(await cache.get({ ...scope, ...other }, ["Hello"]), [undefined], JSON.stringify(other));
  }
});

test("entries expire after seven days, and the least recently used go first when full", async () => {
  let now = 1_000_000;
  const store = createMemoryCacheStore();
  const cache = createTranslationCache(store, { now: () => now, maxEntries: 3 });
  for (const [text, translation] of [["a", "甲"], ["b", "乙"], ["c", "丙"]] as const) {
    await cache.put(scope, [{ text, translation }]);
    now += 100;
  }
  now += 1000;
  await cache.get(scope, ["a"]);
  now += 1000;
  await cache.put(scope, [{ text: "d", translation: "丁" }]);
  assert.deepEqual(await cache.get(scope, ["a", "b", "c", "d"]), ["甲", undefined, "丙", "丁"], "b was used least recently");
  assert.equal(await cache.count(), 3);

  now += CACHE_TTL + 1;
  assert.deepEqual(await cache.get(scope, ["a", "d"]), [undefined, undefined], "seven days later the entries are stale");
  assert.equal(CACHE_TTL, 7 * 24 * 60 * 60 * 1000);
});

test("without a cache (private windows) every block goes to the model and nothing is kept", async () => {
  let calls = 0;
  const result = await translateWithCache({ cache: undefined, scope, blocks: [block("Hello")], translate: async (blocks) => { calls++; return ok(blocks.map(() => "你好")); } });
  assert.equal(calls, 1);
  assert.deepEqual(result, { ...ok(["你好"]), cacheHits: 0 });
});

test("a failed or unconfigured batch isn't cached", async () => {
  const cache = createTranslationCache(createMemoryCacheStore());
  const failed = await translateWithCache({ cache, scope, blocks: [block("Hello")], translate: async () => ({ status: "failed", error: "boom" }) });
  assert.deepEqual(failed, { status: "failed", error: "boom" });
  assert.equal(await cache.count(), 0);
});
