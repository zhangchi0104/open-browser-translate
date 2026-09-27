# Content analyzer

`AI` re-exports Effect 4's `DecisionModel` service. `jevLayer({ apiKey })`
provides it through the official `@effect/ai-typesafe` adapter, pinned to the
same RC version as Effect. The API key is supplied as `Redacted<string>` at
runtime. The default model is `jev-latest`.

```ts
const analyzerLayer = ContentAnalyzer.Live.pipe(
  Layer.provide(jevLayer({ apiKey })),
);
const program = Effect.gen(function* () {
  const parser = yield* DomParser;
  const content = yield* parser.parseTranslatableContent();
  const analyzer = yield* ContentAnalyzer;
  return yield* analyzer.analyze(content, { mode: "main" });
}).pipe(Effect.provide(analyzerLayer), Effect.provide(DomParser.Live));

const result = await Effect.runPromise(program);
```

`analyze` returns one result per input in the original order. Each result keeps
the original `content` object and its DOM references. `role` classifies the group;
`shouldTranslate` annotates whether to retain it. Only text, a request-local ID,
and the enclosing tag are sent to the model. No HTML, attributes, or DOM references
are serialized. Page text is treated as data in the classification instructions.

The default `all` mode excludes confident auxiliary-text and advertisement
classifications. `main` also excludes navigation and controls. Missing confidence,
confidence below 0.8, and unknown roles retain the item. The threshold is an
initial policy, not a measured accuracy guarantee.

Requests contain up to eight blocks, run sequentially, time out after ten seconds
each, and do not retry. Blocks over 2,000 UTF-16 code units are retained without
sending or truncating them, with `fallbackReason: "input-too-large"`. Typed
request failures, invalid responses, and timeouts retain affected blocks with
`fallbackReason: "request-failed"`. Interruption still cancels the operation.
Batches have no cross-batch context.

The launcher now uses the translation workflow described in
`../translator/README.md`: Jev chooses a page-level scope, and each completed
batch is translated and appended to the source page. The analyzer still returns
classifications without changing the DOM. Background messages contain only
serializable text/tag blocks; DOM references stay in the content script.

Run `bun test tests/content-analyzer.test.ts` to validate classification policy,
mapping, batching, fallback, and the official adapter's HTTP contract. Tests use
fake responses and do not establish live model quality or API availability.
