# Translation dispatcher

`translatePageBatch(blocks, pageUrl, stores, onBlock)` is everything the
background does with one batch the page sends over the `translate-stream` port:

1. The page's site is `siteOf(pageUrl)` (`../site-context`): its origin,
   for http and https pages only. Cached translations and site context are kept
   per site. Private windows pass no URL, and browser or extension pages have no
   site, so they use neither store.
2. Blocks cached for the site (`../cache-store`) go to `onBlock` at once,
   marked final. They stay valid even if the rest of the batch fails, so the
   page keeps them and counts only the other blocks as failed.
3. The rest go to `translateBatch` (`../translation-service`) with the site's context
   (`../site-context/carryover.ts`). Their text streams to `onBlock` by
   index in the page's batch, not among the misses. A successful result is
   cached and folded into the site's context.

The result has one translation per block in the page's order when it's ok. It
reads the translation model from `Settings` for the cache key, so the
background's per-request settings snapshot keeps the key and the model in step.
The request's span gets `obt.blocks`, `obt.cache.hits` and `obt.terms`.

`bun test tests/translation-dispatcher.test.ts` runs it with in-memory stores and a
mocked model.
