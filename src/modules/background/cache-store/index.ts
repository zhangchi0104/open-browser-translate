// Model answers are cached per item (a block's text) so revisiting a page, or text repeated
// across a site's pages, needs no model call. A scope holds everything else that changes the
// answer: the site, then whatever the caller adds (target language, provider, model). Changed
// text is a new key, so an entry only goes stale with time: it's kept for seven days from when
// it was saved.

export const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
export const MAX_CACHE_ENTRIES = 20_000;

export interface CacheScope {
  readonly origin: string;
  readonly parts: readonly string[];
}
export interface CacheEntry {
  key: string;
  origin: string;
  value: string;
  savedAt: number;
  usedAt: number;
}
/** Where entries live: IndexedDB in the background, a Map in tests. */
export interface CacheStore {
  get(keys: readonly string[]): Promise<(CacheEntry | undefined)[]>;
  put(entries: readonly CacheEntry[]): Promise<void>;
  delete(keys: readonly string[]): Promise<void>;
  count(): Promise<number>;
  /** Keys of the `limit` entries used longest ago. */
  leastRecentlyUsed(limit: number): Promise<string[]>;
  clear(): Promise<void>;
}

/** A hash of the scope and item, so the store keeps no source text. */
async function keyOf(scope: CacheScope, item: string) {
  const data = new TextEncoder().encode(JSON.stringify([scope.origin, ...scope.parts, item]));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createCache(store: CacheStore, options: { now?: () => number; maxEntries?: number } = {}) {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? MAX_CACHE_ENTRIES;
  return {
    /** Each item's cached value, or undefined when it isn't cached. */
    async get(scope: CacheScope, items: readonly string[]): Promise<(string | undefined)[]> {
      const keys = await Promise.all(items.map((item) => keyOf(scope, item)));
      const entries = await store.get(keys);
      const time = now();
      const stale = entries.flatMap((entry) => entry && time - entry.savedAt > CACHE_TTL ? [entry.key] : []);
      const fresh = entries.map((entry) => entry && time - entry.savedAt <= CACHE_TTL ? entry : undefined);
      if (stale.length) await store.delete(stale);
      const used = fresh.flatMap((entry) => entry ? [{ ...entry, usedAt: time }] : []);
      if (used.length) await store.put(used);
      return fresh.map((entry) => entry?.value);
    },
    async put(scope: CacheScope, entries: readonly { item: string; value: string }[]) {
      if (!entries.length) return;
      const time = now();
      await store.put(await Promise.all(entries.map(async ({ item, value }) => ({
        key: await keyOf(scope, item), origin: scope.origin, value, savedAt: time, usedAt: time,
      }))));
      const over = await store.count() - maxEntries;
      if (over > 0) await store.delete(await store.leastRecentlyUsed(over));
    },
    count: () => store.count(),
    clear: () => store.clear(),
  };
}
export type Cache = ReturnType<typeof createCache>;

/** An in-memory store, for tests. */
export function createMemoryCacheStore(): CacheStore {
  const entries = new Map<string, CacheEntry>();
  return {
    get: async (keys) => keys.map((key) => entries.get(key)),
    put: async (items) => { for (const item of items) entries.set(item.key, item); },
    delete: async (keys) => { for (const key of keys) entries.delete(key); },
    count: async () => entries.size,
    leastRecentlyUsed: async (limit) => [...entries.values()].sort((a, b) => a.usedAt - b.usedAt).slice(0, limit).map(({ key }) => key),
    clear: async () => entries.clear(),
  };
}
