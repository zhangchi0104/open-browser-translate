import { storage } from "wxt/utils/storage";
import { createDebugLog, type LogEntry } from "./model";
import { createLocalTracer, createTraceStore, type OtlpSpan } from "./trace";

export * from "./model";
export * from "./trace";
export const debugLogEntries = storage.defineItem<LogEntry[]>("local:debugLog", { fallback: [] });

/**
 * The background's log. Only the background writes it; pages send entries in a
 * `debug-log` message and the options page clears it with `debug-log-clear`.
 */
export const debugLog = createDebugLog({
  get: () => debugLogEntries.getValue(),
  set: (value) => debugLogEntries.setValue(value),
});

/** Spans of recent translation requests, in OTLP JSON form. Cleared with `traces-clear`. */
export const traceSpans = storage.defineItem<OtlpSpan[]>("local:traces", { fallback: [] });
export const traceStore = createTraceStore({
  get: () => traceSpans.getValue(),
  set: (value) => traceSpans.setValue(value),
});
/** The background's tracer: finished spans go to `traceStore`, never over the network. */
export const localTracer = createLocalTracer((span) => { void traceStore.record(span); });
