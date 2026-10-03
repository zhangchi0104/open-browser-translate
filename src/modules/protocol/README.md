# Protocol

Everything the page, the options page and the background say to each other
lives in `index.ts`:

- **Requests** (`Requests`): one schema per message `type`, with the size
  limits built in (`MAX_BATCH_BLOCKS`, `MAX_BATCH_CHARS`,
  `PAGE_CONTEXT_LIMITS`). The page trims what it sends to the same limits.
- **Replies** (`Responses`): the type each request is answered with. Any
  request that doesn't decode is answered `{ status: "failed" }`.
- **Translation stream** (`STREAM_PORT`): the page sends `{ blocks }`, then
  gets `{ type: "block", index, text, final }` events (`final` for cached
  blocks) and one `{ type: "result", result }`.

`createClient(runtime)` is the page side: `request(message)` with the reply
typed by `message.type`, and `translate(blocks, onBlock)`, which resolves once
and turns a lost background into a failed result. Pages use the instance in
`src/lib/background.ts`. `createDispatcher({ trusted, handlers, translate })`
is the background side: it ignores untrusted senders and unknown types, decodes
each request before its handler sees it, and serves the stream port. Both take
the browser's runtime as an adapter, so `tests/protocol.test.ts` connects them
over fake ports.
