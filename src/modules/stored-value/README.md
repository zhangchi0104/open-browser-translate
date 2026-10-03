# Stored value

`createStoredValue(store, { parse, onError })` is a value in extension storage
that only the background writes: the debug log, request traces and site
contexts each keep one, and supply only their own trimming rule.

- It's read once (`parse` turns what's stored, or nothing, into a value) and
  kept in memory after that, so it must be the store's only writer.
- `update(change)` is an ordered read-modify-write. Updates made while a write
  is in flight share the next write, in the order they were made, so
  concurrent requests never overwrite each other.
- A failed write goes to `onError` and leaves the value as it was; later
  updates still go through.

`bun test tests/stored-value.test.ts` covers ordering, batching and failures.
