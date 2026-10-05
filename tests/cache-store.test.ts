import { strict as assert } from "node:assert";
import { test } from "node:test";
import { CACHE_TTL, createCache, createMemoryCacheStore, type CacheScope } from "../src/modules/background/cache-store";

const scope: CacheScope = { origin: "https://example.com", parts: ["简体中文", "VercelAIGateway", "openai/gpt-6-luna"] };

test("the site and every part of the scope are in the key", async () => {
  const cache = createCache(createMemoryCacheStore());
  await cache.put(scope, [{ item: "Hello", value: "你好" }]);
  assert.deepEqual(await cache.get(scope, ["Hello"]), ["你好"]);
  const others: CacheScope[] = [
    { ...scope, origin: "https://other.com" },
    { ...scope, parts: ["日本語", "VercelAIGateway", "openai/gpt-6-luna"] },
    { ...scope, parts: ["简体中文", "OpenAIApi", "openai/gpt-6-luna"] },
    { ...scope, parts: ["简体中文", "VercelAIGateway", "vendor/other"] },
  ];
  for (const other of others) assert.deepEqual(await cache.get(other, ["Hello"]), [undefined], JSON.stringify(other));
});

test("entries expire after seven days, and the least recently used go first when full", async () => {
  let now = 1_000_000;
  const store = createMemoryCacheStore();
  const cache = createCache(store, { now: () => now, maxEntries: 3 });
  for (const [item, value] of [["a", "甲"], ["b", "乙"], ["c", "丙"]] as const) {
    await cache.put(scope, [{ item, value }]);
    now += 100;
  }
  now += 1000;
  await cache.get(scope, ["a"]);
  now += 1000;
  await cache.put(scope, [{ item: "d", value: "丁" }]);
  assert.deepEqual(await cache.get(scope, ["a", "b", "c", "d"]), ["甲", undefined, "丙", "丁"], "b was used least recently");
  assert.equal(await cache.count(), 3);

  now += CACHE_TTL + 1;
  assert.deepEqual(await cache.get(scope, ["a", "d"]), [undefined, undefined], "seven days later the entries are stale");
  assert.equal(CACHE_TTL, 7 * 24 * 60 * 60 * 1000);
});

test("the summary counts fresh entries by site, busiest first", async () => {
  let now = 1_000_000;
  const cache = createCache(createMemoryCacheStore(), { now: () => now });
  const other: CacheScope = { ...scope, origin: "https://other.com" };
  await cache.put(other, [{ item: "stale", value: "旧" }]);
  now += CACHE_TTL + 1;
  const saved = now;
  await cache.put(scope, [{ item: "a", value: "甲" }, { item: "b", value: "ab" }]);
  now += 10;
  await cache.put(other, [{ item: "c", value: "丙" }]);
  now += 10;
  await cache.get(scope, ["a"]);
  now += 1;
  assert.deepEqual(await cache.summary(), {
    count: 3,
    bytes: 3 + 2 + 3,
    oldest: saved,
    sites: [
      { origin: "https://example.com", count: 2, bytes: 5, usedAt: saved + 20 },
      { origin: "https://other.com", count: 1, bytes: 3, usedAt: saved + 10 },
    ],
  }, "the entry saved over seven days ago is left out");
});
