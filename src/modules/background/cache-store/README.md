# Cache store

Translated blocks are cached in the background's IndexedDB (`indexeddb.ts`), so
revisiting a page, or text that repeats across a site's pages, shows its
translation without a model call. IndexedDB in the background belongs to the
extension's origin: pages can't read it and clearing a site's data leaves it.

Each block is one entry, keyed by a SHA-256 of the site's origin, target
language, translation provider, model and the exact source text, so the store
keeps no source text. Only blocks the page chose to translate reach the cache,
so the page's mode (which decides that) isn't part of the key. Reasoning effort and Fast mode aren't in the key: they change
speed, not which model wrote the translation.

Changed text is a new key, so an entry only goes stale with time: it's kept for
seven days from when it was translated (`CACHE_TTL`), whatever the page's ETag
says, and the least recently used entries are dropped past 20,000
(`MAX_CACHE_ENTRIES`).

`../translation-dispatcher` serves a batch through `get` and `put`: cached blocks go
to the page at once (shown as final), the rest go to the model and the site
context, and only a successful result is cached. Pages without a site,
including private windows, bypass the cache. The options
page shows the entry count and clears the cache through `cache-stats` and
`cache-clear` messages; traces record `obt.cache.hits`.
