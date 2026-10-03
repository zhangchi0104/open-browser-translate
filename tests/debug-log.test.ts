import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Cause } from "effect";
import { AiError } from "effect/unstable/ai";
import { createDebugLog, describeError, formatEntries, MAX_ENTRIES, pageOf, type LogEntry } from "../src/modules/debug-log/model";

function memoryStore() {
  let saved: LogEntry[] | null = null;
  let writes = 0;
  return {
    get: async () => saved,
    set: async (value: LogEntry[]) => { saved = value; writes++; },
    entries: () => saved ?? [],
    writes: () => writes,
  };
}

test("entries logged together land in order and share writes", async () => {
  const store = memoryStore();
  const log = createDebugLog(store, () => 1);
  void log.info("one");
  void log.warn("two", { detail: "why", page: "https://example.com/a" });
  await log.error("three", { source: "page" });
  await log.flush();
  assert.deepEqual(store.entries(), [
    { at: 1, level: "info", source: "background", event: "one" },
    { at: 1, level: "warn", source: "background", event: "two", detail: "why", page: "https://example.com/a" },
    { at: 1, level: "error", source: "page", event: "three" },
  ]);
  assert.ok(store.writes() <= 2);
});

test("the log keeps only the newest entries and can be cleared", async () => {
  const store = memoryStore();
  const log = createDebugLog(store);
  for (let i = 0; i < MAX_ENTRIES + 5; i++) await log.info(`event ${i}`);
  assert.equal(store.entries().length, MAX_ENTRIES);
  assert.equal(store.entries()[0]!.event, "event 5");
  await log.clear();
  assert.deepEqual(store.entries(), []);
});

test("errors, causes and pages are described without leaking query strings", () => {
  assert.match(describeError(new Error("boom")), /Error: boom/);
  assert.match(describeError(Cause.fail(new Error("from effect"))), /from effect/);
  assert.equal(describeError({ status: 429 }), '{"status":429}');
  assert.ok(describeError("x".repeat(10_000)).length < 4100);
  assert.equal(pageOf("https://example.com/search?q=secret#top"), "https://example.com/search");
  assert.equal(pageOf("not a url"), undefined);
  assert.equal(
    formatEntries([{ at: 0, level: "error", source: "page", event: "失败", page: "https://a.com/", detail: "line 1\nline 2" }]),
    "1970-01-01T00:00:00.000Z ERROR [page] 失败\n  page: https://a.com/\n  line 1\n  line 2",
  );
});

test("AI errors show their module, method and reason, not just the class name", () => {
  const error = AiError.make({ module: "OpenAiLanguageModel", method: "generateText", reason: new AiError.InvalidOutputError({ description: "missing translation for id 3" }) });
  const described = describeError(error);
  assert.match(described, /OpenAiLanguageModel\.generateText: Invalid output: missing translation for id 3/);
  assert.match(describeError(Cause.fail(error)), /missing translation for id 3/);
  assert.match(describeError(Cause.die(error)), /missing translation for id 3/);
});
