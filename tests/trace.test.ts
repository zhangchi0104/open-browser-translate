import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Effect, ManagedRuntime } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { createLocalTracer, createTraceStore, groupTraces, markFailed, toOtlpExport, traced, tracingLayer, type OtlpSpan } from "../src/modules/shared/debug-log/trace";

const value = (span: OtlpSpan, key: string) => span.attributes.find((attribute) => attribute.key === key)?.value;

test("spans are recorded locally in OTLP form with parents, typed attributes and error status", async () => {
  const spans: OtlpSpan[] = [];
  const tracer = createLocalTracer((span) => spans.push(span));
  const program = Effect.gen(function* () {
    yield* Effect.succeed(1).pipe(Effect.withSpan("child-ok", { attributes: { "obt.blocks": 8, "obt.mode": "all", "obt.cached": true } }));
    yield* Effect.fail(new Error("provider said no")).pipe(Effect.withSpan("child-failed"));
  }).pipe(Effect.withSpan("root"));
  await Effect.runPromiseExit(traced(program, tracer));

  assert.deepEqual(spans.map((span) => span.name), ["child-ok", "child-failed", "root"]);
  const [ok, failed, root] = spans as [OtlpSpan, OtlpSpan, OtlpSpan];
  assert.equal(root.parentSpanId, undefined);
  assert.equal(ok.parentSpanId, root.spanId);
  assert.equal(ok.traceId, root.traceId);
  assert.match(root.traceId, /^[0-9a-f]{32}$/);
  assert.match(ok.spanId, /^[0-9a-f]{16}$/);
  assert.ok(BigInt(root.endTimeUnixNano) >= BigInt(root.startTimeUnixNano));
  assert.deepEqual(value(ok, "obt.blocks"), { intValue: "8" });
  assert.deepEqual(value(ok, "obt.mode"), { stringValue: "all" });
  assert.deepEqual(value(ok, "obt.cached"), { boolValue: true });
  assert.deepEqual(ok.status, { code: 1 });
  assert.equal(failed.status.code, 2);
  assert.match(failed.status.message!, /provider said no/);
  const exception = failed.events.find((event) => event.name === "exception")!;
  assert.match(exception.attributes.find((a) => a.key === "exception.message")!.value.stringValue!, /provider said no/);
});

test("handled failures mark their span as an error through otel.status_code", async () => {
  const spans: OtlpSpan[] = [];
  const program = Effect.useSpan("handled", (span) => Effect.sync(() => {
    span.attribute("otel.status_code", "ERROR");
    span.attribute("otel.status_description", "batch failed");
  }));
  await Effect.runPromise(traced(program, createLocalTracer((span) => spans.push(span))));
  assert.deepEqual(spans[0]!.status, { code: 2, message: "batch failed" });
  assert.equal(value(spans[0]!, "otel.status_code"), undefined);
});

test("outgoing requests carry no trace headers and their spans record no headers", async () => {
  const spans: OtlpSpan[] = [];
  let sent: Headers | undefined;
  const fetchMock: typeof fetch = async (_input, init) => {
    sent = new Headers(init?.headers);
    return Response.json({ ok: true });
  };
  const request = HttpClient.get("https://api.example.com/v1/models", { headers: { Authorization: "Bearer secret-key" } }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, fetchMock),
  );
  await Effect.runPromise(traced(request, createLocalTracer((span) => spans.push(span))));
  assert.equal(sent!.get("traceparent"), null);
  assert.equal(sent!.get("b3"), null);
  const http = spans.find((span) => span.kind === 3)!;
  assert.deepEqual(value(http, "url.full"), { stringValue: "https://api.example.com/v1/models" });
  assert.equal(http.attributes.some((attribute) => attribute.key.startsWith("http.request.header.")), false);
  assert.equal(JSON.stringify(spans).includes("secret-key"), false);
});

test("the store keeps the newest traces, groups them and exports OTLP JSON", async () => {
  let saved: OtlpSpan[] | null = null;
  const store = createTraceStore({ get: async () => saved, set: async (spans) => { saved = spans; } }, 2);
  const span = (traceId: string, spanId: string, parentSpanId?: string, start = 1n): OtlpSpan => ({
    traceId, spanId, ...(parentSpanId && { parentSpanId }), name: spanId, kind: 1,
    startTimeUnixNano: String(start), endTimeUnixNano: String(start + 5n), attributes: [], events: [], status: { code: 1 },
  });
  void store.record(span("t1", "a", undefined, 1n));
  void store.record(span("t2", "b-child", "b", 2n));
  void store.record(span("t2", "b", undefined, 2n));
  await store.record(span("t3", "c", undefined, 3n));
  assert.deepEqual(saved!.map((s) => s.spanId), ["b-child", "b", "c"]);

  const traces = groupTraces(saved!);
  assert.deepEqual(traces.map((trace) => trace.root.spanId), ["c", "b"]);
  assert.deepEqual(traces[1]!.spans.map(({ span, depth }) => [span.spanId, depth]), [["b", 0], ["b-child", 1]]);

  const exported = toOtlpExport(saved!);
  assert.equal(exported.resourceSpans[0]!.resource.attributes[0]!.key, "service.name");
  assert.equal(exported.resourceSpans[0]!.scopeSpans[0]!.spans.length, 3);
  await store.clear();
  assert.deepEqual(saved, []);
});

test("a request run on a runtime with the tracing layer records its steps as children, and a handled failure", async () => {
  const spans: OtlpSpan[] = [];
  const tracer = createLocalTracer((span) => spans.push(span));
  const runtime = ManagedRuntime.make(tracingLayer(tracer));
  const result = await runtime.runPromise(Effect.gen(function* () {
    const span = yield* Effect.orDie(Effect.currentSpan);
    yield* Effect.succeed(1).pipe(Effect.withSpan("content-analysis"));
    yield* Effect.fail(new Error("bad ids")).pipe(Effect.withSpan("translation"), Effect.orElseSucceed(() => 0));
    markFailed(span, "翻译批次失败", new Error("bad ids"));
    return "done";
  }).pipe(Effect.withSpan("translate-content", { kind: "server", attributes: { "obt.blocks": 2 } })));
  assert.equal(result, "done");
  const root = spans.find((span) => span.name === "translate-content")!;
  for (const name of ["content-analysis", "translation"]) {
    const child = spans.find((span) => span.name === name)!;
    assert.equal(child.parentSpanId, root.spanId, `${name} is a child of the request`);
    assert.equal(child.traceId, root.traceId);
  }
  assert.equal(root.kind, 2);
  assert.deepEqual(root.status, { code: 2, message: "翻译批次失败" });
  assert.match(root.events[0]!.attributes.find((a) => a.key === "exception.message")!.value.stringValue!, /bad ids/);
  assert.equal(groupTraces(spans).length, 1);
});
