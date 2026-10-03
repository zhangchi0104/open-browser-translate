# Translation cache

Translated blocks are cached in the background's IndexedDB (`indexeddb.ts`), so
revisiting a page, or text that repeats across a site's pages, shows its
translation without a model call. IndexedDB in the background belongs to the
extension's origin: pages can't read it and clearing a site's data leaves it.

Each block is one entry, keyed by a SHA-256 of the site's origin, target
language, translation provider, model, mode and the exact source text, so the
store keeps no source text. A block that analysis decided not to translate is
cached as `null`. Reasoning effort and Fast mode aren't in the key: they change
speed, not which model wrote the translation.

Changed text is a new key, so an entry only goes stale with time: it's kept for
seven days from when it was translated (`CACHE_TTL`), whatever the page's ETag
says, and the least recently used entries are dropped past 20,000
(`MAX_CACHE_ENTRIES`).

`translateWithCache` serves a batch: cached blocks go to the page at once (as
`{ type: "cached" }` on the stream port, shown as final), the rest go to the
model and the site context, and only a successful result is cached. Private
windows have no page URL in the background, so they bypass the cache. The
options page shows the entry count and clears the cache through `cache-stats`
and `cache-clear` messages; traces record `obt.cache.hits`.
