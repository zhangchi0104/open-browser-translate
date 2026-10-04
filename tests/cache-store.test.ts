import { strict as assert } from "node:assert";
import { test } from "node:test";
import { CACHE_TTL, createMemoryCacheStore, createTranslationCache, type CacheScope } from "../src/modules/background/cache-store";

const scope: CacheScope = { origin: "https://example.com", target: "简体中文", provider: "VercelAIGateway", model: "openai/gpt-6-luna" };

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
