import { Cause } from "effect";
import { createStoredValue, type ValueStore } from "../stored-value";

export type LogLevel = "info" | "warn" | "error";
export type LogSource = "background" | "page";
export interface LogEntry {
  at: number;
  level: LogLevel;
  source: LogSource;
  event: string;
  detail?: string;
  /** Origin and path of the tab the entry came from; never the query string. */
  page?: string;
}

/** Where entries live; extension storage in the background, an array in tests. */
export type LogStore = ValueStore<LogEntry[]>;

// Keeps storage bounded: the newest entries survive.
export const MAX_ENTRIES = 500;
const MAX_DETAIL = 4000;

export const truncate = (text: string, max = MAX_DETAIL) => text.length > max ? `${text.slice(0, max)}…（已截断）` : text;

/** Renders anything thrown or failed — an Effect cause, an Error, or a value — as readable text. */
export function describeError(error: unknown): string {
  if (Cause.isCause(error)) {
    const errors = Cause.prettyErrors(error);
    return truncate(errors.length ? errors.map((each) => describeErrorObject(each)).join("\n\n") : "空的失败原因");
  }
  if (error instanceof Error) return truncate(describeErrorObject(error));
  if (typeof error === "string") return truncate(error);
  try { return truncate(JSON.stringify(error)); } catch { return truncate(String(error)); }
}

// The header comes from `message` rather than the stack's first line: errors like Effect's
// `AiError` compute their message from fields set after the stack was captured.
function describeErrorObject(error: Error, depth = 0): string {
  const frames = (error.stack ?? "").split("\n").filter((line) => /^\s+at /.test(line)).slice(0, 6);
  const cause = error.cause instanceof Error && error.cause !== error && depth < 3
    ? `\nCaused by: ${describeErrorObject(error.cause, depth + 1)}`
    : "";
  return [`${error.name}: ${error.message}`, ...frames].join("\n") + cause;
}

/** Origin and path only, so query strings with tokens or search terms stay out of the log. */
export function pageOf(url: string | undefined): string | undefined {
  if (!url) return;
  try {
    const { origin, pathname } = new URL(url);
    return origin === "null" ? undefined : origin + pathname;
  } catch { return; }
}

export function formatEntries(entries: readonly LogEntry[]): string {
  return entries.map((entry) => [
    `${new Date(entry.at).toISOString()} ${entry.level.toUpperCase()} [${entry.source}] ${entry.event}`,
    entry.page && `  page: ${entry.page}`,
    entry.detail && entry.detail.replace(/^/gm, "  "),
  ].filter(Boolean).join("\n")).join("\n");
}

/** Appends entries to a bounded log; entries from concurrent requests land in order. */
export function createDebugLog(store: LogStore, now: () => number = Date.now) {
  const entries = createStoredValue(store, {
    parse: (stored) => Array.isArray(stored) ? stored as LogEntry[] : [],
    onError: (error) => console.error("Debug log write failed:", error),
  });
  const write = (level: LogLevel, event: string, options: { detail?: string; page?: string; source?: LogSource } = {}) => {
    const entry: LogEntry = { at: now(), level, source: options.source ?? "background", event };
    if (options.detail) entry.detail = truncate(options.detail);
    if (options.page) entry.page = options.page;
    console[level === "info" ? "info" : level](`[debug-log] ${event}`, options.detail ?? "");
    return entries.update((current) => current.concat(entry).slice(-MAX_ENTRIES));
  };
  return {
    info: (event: string, options?: Parameters<typeof write>[2]) => write("info", event, options),
    warn: (event: string, options?: Parameters<typeof write>[2]) => write("warn", event, options),
    error: (event: string, options?: Parameters<typeof write>[2]) => write("error", event, options),
    write,
    clear: () => entries.update(() => []),
    /** Resolves once every pending write has reached the store. */
    flush: entries.flush,
  };
}
export type DebugLog = ReturnType<typeof createDebugLog>;
