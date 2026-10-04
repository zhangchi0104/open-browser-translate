# Batch scheduler

One click on the launcher starts a session: `createTranslationSession(items,
mode, page, onProgress)` translates the page's content near the viewport until
`stop()` or until a model turns out not to be configured, which `run()`
resolves with.

It owns the scheduling rules; the launcher (`src/components`) only supplies the
page (`SessionPage`: where an item is, whether it's still attached, how to
analyze, translate and show it) and renders `SessionProgress`.

- Analysis takes the unanalyzed items nearest the viewport, up to three batches
  of eight at once. Items it doesn't keep are dropped. With no usable answer,
  every item in the batch is kept at the priority of an unsure block.
- Translation takes kept items by priority (`TRANSLATION_PRIORITY`), distance
  breaking ties, but waits while anything on screen is still unanalyzed, so
  visible navigation never goes before visible content.
- Items further than the read-ahead window (`viewport.ts`) wait until a
  scroll or resize (`nudge()`) brings them near; content added later joins
  with `add()`.
- A failed batch discards its streamed text but keeps the blocks the cache
  served; only the others count as failed.
- Each translation batch carries the source just before its first block in
  document order (`precedingText`, up to 600 characters, skipping blocks
  analysis dropped). Blocks within a batch stay in priority order, so content
  streams before navigation. The launcher adds the page brief (`pageBrief` in
  `../block-collector`).

`bun test tests/batch-scheduler.test.ts` drives it with fake items and a
fake page.
