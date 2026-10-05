# Translation dispatcher

`translatePageBatch(blocks, pageUrl, { translation, contexts }, onBlock, surroundings)`
is everything the background does with one batch the page sends over the
`translate-stream` port. It keeps no queue (ADR-0001) and never touches the
cache (ADR-0002):

1. The page's site is `siteOf(pageUrl)` (`../site-context`): its origin, for
   http and https pages only. Private windows pass no URL, and browser or
   extension pages have no site, so they keep no context and no cache.
2. It takes a snapshot of the site's context for these blocks
   (`../site-context/carryover.ts`) and adds the batch's surroundings from the
   page: the page brief and the preceding text.
3. `TranslationService.translate` (`../translation-service`) serves cached
   blocks at once and streams the rest from the model, by index in the page's
   batch.
4. What the model newly translated, and the terms it reported, are folded into
   the site's context for later batches and pages. Cached blocks aren't
   recorded again.

Batches running together each see the context as it was when they started. The
result has one translation per block in the page's order when it's ok. The
request's span gets `obt.blocks`, `obt.cache.hits` and `obt.terms`.

`bun test tests/translation-dispatcher.test.ts` runs it with in-memory stores
and a mocked model.
