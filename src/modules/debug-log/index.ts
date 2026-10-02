import { storage } from "wxt/utils/storage";
import { createDebugLog, type LogEntry } from "./model";

export * from "./model";
export const debugLogEntries = storage.defineItem<LogEntry[]>("local:debugLog", { fallback: [] });

/**
 * The background's log. Only the background writes it; pages send entries in a
 * `debug-log` message and the options page clears it with `debug-log-clear`.
 */
export const debugLog = createDebugLog({
  get: () => debugLogEntries.getValue(),
  set: (value) => debugLogEntries.setValue(value),
});
