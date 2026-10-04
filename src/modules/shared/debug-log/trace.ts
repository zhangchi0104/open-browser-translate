import { Cause, Effect, Exit, Layer, Option, Tracer } from "effect";
import { HttpClient } from "effect/unstable/http";
import { describeError, truncate } from "./model";
import { createStoredValue, type ValueStore } from "../stored-value";

// Spans in the OTLP JSON shape (https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding),
// so an export opens in any OpenTelemetry viewer. Nothing is sent anywhere: spans are
// recorded by a local tracer and kept in extension storage.

export interface OtlpValue {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values: OtlpValue[] };
}
export interface OtlpAttribute { key: string; value: OtlpValue }
export interface OtlpEvent { timeUnixNano: string; name: string; attributes: OtlpAttribute[] }
/** `kind`: 1 internal, 2 server, 3 client, 4 producer, 5 consumer. `status.code`: 0 unset, 1 ok, 2 error. */
export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: 1 | 2 | 3 | 4 | 5;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  events: OtlpEvent[];
  status: { code: 0 | 1 | 2; message?: string };
}

const KINDS: Record<Tracer.SpanKind, OtlpSpan["kind"]> = { internal: 1, server: 2, client: 3, producer: 4, consumer: 5 };
// Headers can carry keys, so they are never kept even if a filter lets them through.
const DROPPED = /^http\.(request|response)\.header\./;
// Some tracers mark a span's status through these attributes; spans whose failure the code
// handles (and so ends successfully) set them to show up as errors.
const STATUS_CODE = "otel.status_code";
const STATUS_DESCRIPTION = "otel.status_description";

function toValue(value: unknown): OtlpValue | undefined {
  if (value === undefined || value === null) return;
  if (typeof value === "string") return { stringValue: truncate(value, 2000) };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "bigint") return { intValue: String(value) };
  if (typeof value === "number") return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.flatMap((item) => toValue(item) ?? []) } };
  try { return { stringValue: truncate(JSON.stringify(value), 2000) }; } catch { return { stringValue: String(value) }; }
}
function toAttributes(entries: Iterable<[string, unknown]>): OtlpAttribute[] {
  return [...entries].flatMap(([key, raw]) => {
    if (DROPPED.test(key) || key === STATUS_CODE || key === STATUS_DESCRIPTION) return [];
    const value = toValue(raw);
    return value ? [{ key, value }] : [];
  });
}

function statusOf(attributes: ReadonlyMap<string, unknown>, exit: Exit.Exit<unknown, unknown>): OtlpSpan["status"] {
  if (attributes.get(STATUS_CODE) === "ERROR") {
    const message = attributes.get(STATUS_DESCRIPTION);
    return typeof message === "string" ? { code: 2, message: truncate(message, 500) } : { code: 2 };
  }
  if (!Exit.isFailure(exit)) return { code: 1 };
  if (Cause.hasInterruptsOnly(exit.cause)) return { code: 2, message: "interrupted" };
  const error = Cause.squash(exit.cause);
  return { code: 2, message: truncate(error instanceof Error ? `${error.name}: ${error.message}` : describeError(error), 500) };
}

class RecordingSpan extends Tracer.NativeSpan {
  constructor(options: ConstructorParameters<typeof Tracer.NativeSpan>[0], private readonly onEnd: (span: OtlpSpan) => void) {
    super(options);
  }
  override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    super.end(endTime, exit);
    const events: OtlpEvent[] = this.events.map(([name, time, attributes]) => ({
      timeUnixNano: String(time), name, attributes: toAttributes(Object.entries(attributes)),
    }));
    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
      const error = Cause.squash(exit.cause);
      events.push({
        timeUnixNano: String(endTime),
        name: "exception",
        attributes: toAttributes([
          ["exception.type", error instanceof Error ? error.name : typeof error],
          ["exception.message", error instanceof Error ? error.message : describeError(error)],
          ["exception.stacktrace", describeError(exit.cause)],
        ]),
      });
    }
    const parent = Option.getOrUndefined(this.parent);
    this.onEnd({
      traceId: this.traceId,
      spanId: this.spanId,
      ...(parent && { parentSpanId: parent.spanId }),
      name: this.name,
      kind: KINDS[this.kind],
      startTimeUnixNano: String(this.startTime),
      endTimeUnixNano: String(endTime),
      attributes: toAttributes(this.attributes),
      events,
      status: statusOf(this.attributes, exit),
    });
  }
}

/** A tracer that hands each finished span to `onEnd` in OTLP form instead of exporting it. */
export function createLocalTracer(onEnd: (span: OtlpSpan) => void): Tracer.Tracer {
  return Tracer.make({ span: (options) => new RecordingSpan(options, onEnd) });
}

/**
 * Effects run with this layer record spans with `tracer`. They send no trace headers, which would
 * tell providers about local spans, and keep no headers in spans, since headers can carry keys.
 */
export function tracingLayer(tracer: Tracer.Tracer) {
  return Layer.mergeAll(
    Layer.succeed(Tracer.Tracer, tracer),
    Layer.succeed(HttpClient.TracerPropagationEnabled, false),
    Layer.succeed(HttpClient.TracerHeaderFilter, () => false),
  );
}

/** Runs `effect` under `tracer`, as `tracingLayer` does. */
export function traced<A, E, R>(effect: Effect.Effect<A, E, R>, tracer: Tracer.Tracer): Effect.Effect<A, E, R> {
  return effect.pipe(Effect.provide(tracingLayer(tracer)));
}

/** Marks a span as failed when the handler turned the failure into a result instead of failing. */
export function markFailed(span: Tracer.Span, description: string, error?: unknown) {
  span.attribute(STATUS_CODE, "ERROR");
  span.attribute(STATUS_DESCRIPTION, description);
  if (error === undefined) return;
  span.event("exception", BigInt(Date.now()) * 1_000_000n, {
    "exception.type": error instanceof Error ? error.name : typeof error,
    "exception.message": error instanceof Error ? error.message : String(error),
    "exception.stacktrace": describeError(error),
  });
}

/** Where spans live; extension storage in the background, an array in tests. */
export type TraceStore = ValueStore<OtlpSpan[]>;

export const MAX_TRACES = 100;

/** Keeps the spans of the newest traces. */
export function createTraceStore(store: TraceStore, maxTraces = MAX_TRACES) {
  const spans = createStoredValue(store, {
    parse: (stored) => stored ?? [],
    onError: (error) => console.error("Trace write failed:", error),
  });
  // Spans ending together (a request and its steps) are trimmed once, in the write that saves them.
  let ended: OtlpSpan[] = [];
  const trim = (current: OtlpSpan[]) => {
    if (!ended.length) return current;
    const all = current.concat(ended);
    ended = [];
    // A trace's recency is where its latest span landed.
    const order: string[] = [];
    for (const { traceId } of all) {
      const index = order.indexOf(traceId);
      if (index >= 0) order.splice(index, 1);
      order.push(traceId);
    }
    const kept = new Set(order.slice(-maxTraces));
    return all.filter(({ traceId }) => kept.has(traceId));
  };
  return {
    record: (span: OtlpSpan) => {
      ended.push(span);
      return spans.update(trim);
    },
    clear: () => spans.update(() => []),
    flush: spans.flush,
  };
}

export interface TraceView {
  traceId: string;
  root: OtlpSpan;
  /** Depth-first, children after their parent in start order. */
  spans: { span: OtlpSpan; depth: number }[];
  start: bigint;
  end: bigint;
  error: boolean;
}

/** Groups spans into traces, newest first. Spans whose parent wasn't recorded count as roots. */
export function groupTraces(spans: readonly OtlpSpan[]): TraceView[] {
  const byTrace = new Map<string, OtlpSpan[]>();
  for (const span of spans) byTrace.set(span.traceId, [...(byTrace.get(span.traceId) ?? []), span]);
  const traces: TraceView[] = [];
  for (const [traceId, members] of byTrace) {
    const ids = new Set(members.map(({ spanId }) => spanId));
    const children = new Map<string | undefined, OtlpSpan[]>();
    for (const span of members) {
      const parent = span.parentSpanId && ids.has(span.parentSpanId) ? span.parentSpanId : undefined;
      children.set(parent, [...(children.get(parent) ?? []), span]);
    }
    const ordered: TraceView["spans"] = [];
    const visit = (parent: string | undefined, depth: number) => {
      const next = (children.get(parent) ?? []).sort((a, b) => Number(BigInt(a.startTimeUnixNano) - BigInt(b.startTimeUnixNano)));
      for (const span of next) {
        ordered.push({ span, depth });
        visit(span.spanId, depth + 1);
      }
    };
    visit(undefined, 0);
    const start = members.reduce((min, span) => BigInt(span.startTimeUnixNano) < min ? BigInt(span.startTimeUnixNano) : min, BigInt(members[0]!.startTimeUnixNano));
    const end = members.reduce((max, span) => BigInt(span.endTimeUnixNano) > max ? BigInt(span.endTimeUnixNano) : max, 0n);
    traces.push({ traceId, root: ordered[0]!.span, spans: ordered, start, end, error: members.some((span) => span.status.code === 2) });
  }
  return traces.sort((a, b) => Number(b.start - a.start));
}

/** Wraps spans in an OTLP JSON export, the body a collector's /v1/traces would take. */
export function toOtlpExport(spans: readonly OtlpSpan[], version = "0.0.0") {
  return {
    resourceSpans: [{
      resource: { attributes: toAttributes([["service.name", "open-browser-translate"], ["service.version", version]]) },
      scopeSpans: [{ scope: { name: "open-browser-translate" }, spans: [...spans] }],
    }],
  };
}
