# Cache store

A cache of model answers in the background's IndexedDB (`indexeddb.ts`), one
database per cache: `translation-cache` for translated blocks and
`analysis-cache` for block roles. IndexedDB in the background belongs to the
extension's origin: pages can't read it and clearing a site's data leaves it.

`createCache(store)` keys each item (a block's text) by a SHA-256 of a scope and
the item, so the store keeps no source text. The scope is the site's origin plus
whatever the caller adds:

- `../translation-service`: target language, translation provider and model.
  Reasoning effort and Fast mode aren't in the key: they change speed, not which
  model wrote the translation. Only blocks the page chose to translate reach the
  cache, so the page's mode isn't part of the key either.
- `../content-analyzer`: analysis provider and model; the item is the block's
  tag and text. The mode isn't in the key, since it only decides what a role
  means.

Changed text is a new key, so an entry only goes stale with time: it's kept for
seven days from when it was saved (`CACHE_TTL`), whatever the page's ETag says,
and the least recently used entries are dropped past 20,000 per database
(`MAX_CACHE_ENTRIES`). Database version 2 renamed entries' `translation` to
`value`; opening a version 1 database empties it.

The caches wrap their models (ADR-0002); the dispatcher never touches them.
Pages without a site, including private windows, bypass both. The options page
shows the translation entry count through `cache-stats`, and `cache-clear`
empties both caches; traces record `obt.cache.hits`.

`bun test tests/cache-store.test.ts` runs it on a Map; `tests/cache-store.browser.ts`
runs it on real IndexedDB, including the version 1 upgrade.
