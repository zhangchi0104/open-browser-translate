// Runs the translation cache on real IndexedDB; open in a browser and read the page text.
import { createTranslationCache, type CacheScope } from "../src/modules/translation-cache";
import { createIndexedDbCacheStore } from "../src/modules/translation-cache/indexeddb";

function assert(value: boolean, message: string) {
  if (!value) throw new Error(message);
}
const scope: CacheScope = { origin: "https://example.com", target: "简体中文", provider: "VercelAIGateway", model: "m" };

try {
  const name = `translation-cache-test-${Date.now()}`;
  let now = 1_000;
  const cache = createTranslationCache(createIndexedDbCacheStore(name), { now: () => now, maxEntries: 2 });
  await cache.put(scope, [{ text: "Hello", translation: "你好" }]);
  now += 10;
  await cache.put(scope, [{ text: "Home", translation: "主页" }]);
  assert(JSON.stringify(await cache.get(scope, ["Hello", "Home", "Missing"])) === JSON.stringify(["你好", "主页", undefined]), "entries round-trip");
  now += 10;
  await cache.get(scope, ["Home"]);
  now += 10;
  await cache.put(scope, [{ text: "New", translation: "新" }]);
  assert(await cache.count() === 2, "the store is trimmed to its limit");
  assert((await cache.get(scope, ["Hello"]))[0] === undefined, "the least recently used entry went first");

  const reopened = createTranslationCache(createIndexedDbCacheStore(name), { now: () => now });
  assert((await reopened.get(scope, ["New"]))[0] === "新", "entries survive reopening the database");
  await reopened.clear();
  assert(await reopened.count() === 0, "clear empties the store");
  indexedDB.deleteDatabase(name);
  document.body.textContent = "PASS: IndexedDB round-trip, trimming by last use, reopen, clear";
} catch (error) {
  document.body.textContent = `FAIL: ${String(error)}`;
}
