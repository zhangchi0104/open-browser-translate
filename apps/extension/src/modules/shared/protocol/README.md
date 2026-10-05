# Protocol

Everything the page, the options page and the background say to each other
lives in `index.ts`:

- **Requests** (`Requests`): one schema per message `type`, with the size
  limits built in (`MAX_BATCH_BLOCKS`, `MAX_BATCH_CHARS`,
  `PAGE_CONTEXT_LIMITS`). The page trims what it sends to the same limits.
- **Replies** (`Replies`): a schema per request type, which the page decodes,
  along with the shared results (`TranslationPlan`, `PageAnalysisResult`,
  `TranslationBatchResult`) the background's modules return. Any request that
  doesn't decode is answered `{ status: "failed" }`, and a reply the page can't
  decode counts as failed too.
- **Translation stream** (`STREAM_PORT`): the page sends `{ blocks }`, then
  gets `{ type: "block", index, text, final }` events (`final` for cached
  blocks) and one `{ type: "result", result }`.

`createClient(runtime)` is the page side: `request(message)` with the reply
decoded by `message.type`, and `translate(blocks, onBlock)`, which resolves once
and turns a lost background into a failed result. Pages use the instance in
`src/lib/background.ts`. `createDispatcher({ trusted, handlers, translate })`
is the background side: it ignores untrusted senders and unknown types, decodes
each request before its handler sees it, and serves the stream port. Both take
the browser's runtime as an adapter, so `tests/protocol.test.ts` connects them
over fake ports.
