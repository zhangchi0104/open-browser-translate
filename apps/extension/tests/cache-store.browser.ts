// Runs the cache on real IndexedDB; open in a browser and read the page text.
import { createCache, type CacheScope } from "../src/modules/background/cache-store";
import { createIndexedDbCacheStore } from "../src/modules/background/cache-store/indexeddb";

function assert(value: boolean, message: string) {
  if (!value) throw new Error(message);
}
const scope: CacheScope = { origin: "https://example.com", parts: ["简体中文", "VercelAIGateway", "m"] };

try {
  const name = `translation-cache-test-${Date.now()}`;
  let now = 1_000;
  const cache = createCache(createIndexedDbCacheStore(name), { now: () => now, maxEntries: 2 });
  await cache.put(scope, [{ item: "Hello", value: "你好" }]);
  now += 10;
  await cache.put(scope, [{ item: "Home", value: "主页" }]);
  assert(JSON.stringify(await cache.get(scope, ["Hello", "Home", "Missing"])) === JSON.stringify(["你好", "主页", undefined]), "entries round-trip");
  now += 10;
  await cache.get(scope, ["Home"]);
  now += 10;
  await cache.put(scope, [{ item: "New", value: "新" }]);
  assert(await cache.count() === 2, "the store is trimmed to its limit");
  assert((await cache.get(scope, ["Hello"]))[0] === undefined, "the least recently used entry went first");

  const reopened = createCache(createIndexedDbCacheStore(name), { now: () => now });
  assert((await reopened.get(scope, ["New"]))[0] === "新", "entries survive reopening the database");
  await reopened.clear();
  assert(await reopened.count() === 0, "clear empties the store");
  indexedDB.deleteDatabase(name);

  // A version 1 database (entries with `translation`, not `value`) is emptied on upgrade.
  const legacy = `${name}-v1`;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(legacy, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("entries", { keyPath: "key" });
      store.createIndex("usedAt", "usedAt");
      store.createIndex("origin", "origin");
      store.put({ key: "old", origin: "https://example.com", translation: "旧", savedAt: now, usedAt: now });
    };
    request.onsuccess = () => { request.result.close(); resolve(); };
    request.onerror = () => reject(request.error);
  });
  const upgraded = createCache(createIndexedDbCacheStore(legacy), { now: () => now });
  assert(await upgraded.count() === 0, "version 1 entries are dropped on upgrade");
  await upgraded.put(scope, [{ item: "Hello", value: "你好" }]);
  assert((await upgraded.get(scope, ["Hello"]))[0] === "你好", "the upgraded store works");
  indexedDB.deleteDatabase(legacy);
  document.body.textContent = "PASS: IndexedDB round-trip, trimming by last use, reopen, clear, upgrade from version 1";
} catch (error) {
  document.body.textContent = `FAIL: ${String(error)}`;
}
