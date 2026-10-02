# Debug log

A bounded log of what the translation flow did, shown in the options page under
「调试日志」. It exists so failures that the page only reports as "翻译失败" can be
traced to a cause: the provider and model used, how long the request took, and
the error text (`Cause`/stack) that the Effect pipelines used to swallow.

The background is the only writer. Its own entries come from the message
handlers in `src/entrypoints/background.ts` and ChatGPT sign-in. Content scripts
send `{ type: "debug-log", entry }` and the background attaches the sender's
page; the options page clears the log with `{ type: "debug-log-clear" }`. Writes
go through one queue, so concurrent batches append in order without losing
entries.

The log lives in `local:debugLog` and keeps the newest 500 entries; each detail is
cut at 4000 characters. It records counts, models, timings and errors, not page
text or API keys; a provider's error message can still quote model output.
Pages are stored as origin plus path, without the query string, and
private-window tabs record no page.
