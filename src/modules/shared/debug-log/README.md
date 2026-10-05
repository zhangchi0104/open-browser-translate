# Debug log

What the extension did, shown in the options page under 「调试日志」, so failures
the page only reports as "翻译失败" can be traced to a cause. Everything stays in
extension storage; nothing is uploaded.

## Request traces (OpenTelemetry)

Translation requests (`prepare-translation`, `translate-content`,
`analyze-content`) are recorded as OpenTelemetry traces (`trace.ts`). The
background runs each request as a root span on its `ManagedRuntime`, whose
`tracingLayer` records spans locally; the request's steps are child spans. `translateBatch` adds
`content-analysis` and `translation` spans, and Effect's own AI and HTTP modules
add `DecisionModel.decide`, `LanguageModel.*` (with `gen_ai.*` model and token
attributes) and `http.client` spans below them.

`createLocalTracer` replaces an exporter: each finished span is converted to the
OTLP JSON span shape and stored in `local:traces`, keeping the newest 100 traces.
`traced` also turns off trace-context propagation, so requests to providers
carry no `traceparent`/`b3` headers, and stops HTTP spans from recording
headers. A handler that turns a failure into a result marks its span with
`markFailed` (the `otel.status_code` convention). The 「请求追踪」 view groups
spans into traces, draws a waterfall per request and exports OTLP JSON that
OpenTelemetry tools can open.

## Plain log

Everything else (ChatGPT sign-in, model lists, page-side failures) goes to a
bounded log (`model.ts`) in `local:debugLog`, newest 500 entries, each detail cut
at 4000 characters. Content scripts send `{ type: "debug-log", entry }` and the
background attaches the sender's page.

The background is the only writer of both stores. Each is a stored value
(`../stored-value`): read once, kept in memory, and written through ordered,
batched updates, so concurrent requests land in order. The options page clears them with
`debug-log-clear` and `traces-clear`.

Neither store records API keys. The log records no page text, but each
translation span carries what was sent and returned as events: the system
prompt (`obt.prompt.system`), the context (`obt.prompt.context`), and the batch's
source and translated text (`obt.source`, `obt.translation`, numbered `#id`),
each kept up to 20,000 characters. A provider's error message can also quote
model output. Pages are stored as origin plus path, without the query
string, and private-window tabs record no page.
