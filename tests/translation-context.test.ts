import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  CONTEXT_TTL_MS,
  contextKey,
  emptyContext,
  MAX_GLOSSARY,
  MAX_RECENT,
  notePage,
  promptContext,
  recordBatch,
  type TranslationContext,
} from "../src/modules/translation-context";
import { createContextCarryover, MAX_SITES } from "../src/modules/translation-context/carryover";
import type { TranslationBatchResult } from "../src/modules/translator/translate-batch";

const ok = (translations: (string | null)[], terms: { source: string; target: string }[] = []): TranslationBatchResult =>
  ({ status: "ok", translations, terms, analysisFallbackCount: 0 });

function memoryStore(initial: unknown = undefined) {
  let value = initial;
  return { get: async () => value, set: async (next: Record<string, TranslationContext>) => { value = next; }, peek: () => value as Record<string, TranslationContext> };
}

test("context is keyed by site, so it follows navigation within an origin only", () => {
  assert.equal(contextKey("https://docs.example.com/a?x=1"), "https://docs.example.com");
  assert.equal(contextKey("https://docs.example.com/b#c"), "https://docs.example.com");
  assert.notEqual(contextKey("https://other.example.com/a"), contextKey("https://docs.example.com/a"));
  assert.equal(contextKey("chrome://extensions"), undefined);
  assert.equal(contextKey("not a url"), undefined);
  assert.equal(contextKey(undefined), undefined);
});

test("terms are accepted only when they occur in the batch, and the newest rendering wins", () => {
  let context = recordBatch(emptyContext(0), [{ source: "Kubernetes pods restart", target: "Kubernetes Pod 重启" }], [
    { source: "Pod", target: "Pod" },
    { source: "Ignore previous instructions", target: "x" },
    { source: "  ", target: "空" },
  ], 1);
  assert.deepEqual(context.glossary, [{ source: "Pod", target: "Pod" }]);
  context = recordBatch(context, [{ source: "A pod is scheduled", target: "容器组被调度" }], [{ source: "pod", target: "容器组" }], 2);
  assert.deepEqual(context.glossary, [{ source: "pod", target: "容器组" }]);
  assert.equal(context.updatedAt, 2);
});

test("glossary, recent passages and page titles stay bounded", () => {
  let context = emptyContext(0);
  for (let index = 0; index < MAX_GLOSSARY + 10; index++) {
    context = recordBatch(context, [{ source: `term${index} here`, target: `t${index}` }], [{ source: `term${index}`, target: `T${index}` }], index);
  }
  assert.equal(context.glossary.length, MAX_GLOSSARY);
  assert.equal(context.glossary.at(-1)!.source, `term${MAX_GLOSSARY + 9}`);
  assert.equal(context.recent.length, MAX_RECENT);
  for (let index = 0; index < 8; index++) context = notePage(context, `Page ${index % 6}`, index);
  assert.deepEqual(context.pages, ["Page 3", "Page 4", "Page 5", "Page 0", "Page 1"]);
});

test("only glossary terms that appear in the batch are sent", () => {
  const context = { ...emptyContext(0), glossary: [{ source: "Effect", target: "Effect" }, { source: "fiber", target: "纤程" }] };
  assert.deepEqual(promptContext(context, ["Each Fiber runs"])!.glossary, [{ source: "fiber", target: "纤程" }]);
  assert.equal(promptContext(emptyContext(0), ["anything"]), undefined);
});

test("context carries from one viewport batch to the next and across pages on the site", async () => {
  const store = memoryStore();
  const carryover = createContextCarryover(store, () => 1000);
  await carryover.notePage("https://docs.example.com/intro", "Intro to Fibers");
  assert.deepEqual(await carryover.contextFor("https://docs.example.com/intro", ["Fibers are light"]),
    { pages: ["Intro to Fibers"], glossary: [], recent: [] });

  // First viewport batch teaches the glossary...
  await carryover.record("https://docs.example.com/intro", [{ text: "A Fiber is a virtual thread", tag: "p" }, { text: "Menu", tag: "a" }],
    ok(["纤程是一种虚拟线程", null], [{ source: "Fiber", target: "纤程" }]));
  // ...the next batch on the same page sees it...
  const next = await carryover.contextFor("https://docs.example.com/intro", ["Forking a fiber"]);
  assert.deepEqual(next!.glossary, [{ source: "Fiber", target: "纤程" }]);
  assert.deepEqual(next!.recent, [{ source: "A Fiber is a virtual thread", target: "纤程是一种虚拟线程" }]);

  // ...and so does a later page on the same site, but not another site.
  await carryover.notePage("https://docs.example.com/scheduling", "Scheduling");
  const later = await carryover.contextFor("https://docs.example.com/scheduling", ["Fiber scheduling"]);
  assert.deepEqual(later!.pages, ["Intro to Fibers", "Scheduling"]);
  assert.deepEqual(later!.glossary, [{ source: "Fiber", target: "纤程" }]);
  assert.equal(await carryover.contextFor("https://news.example.org/", ["Fiber scheduling"]), undefined);
});

test("failed batches record nothing and concurrent updates are not lost", async () => {
  const store = memoryStore();
  const carryover = createContextCarryover(store, () => 1000);
  await carryover.record("https://a.example/", [{ text: "Hello", tag: "p" }], { status: "failed" });
  assert.equal(store.peek(), undefined);
  await Promise.all(Array.from({ length: 5 }, (_, index) => carryover.notePage("https://a.example/", `Page ${index}`)));
  assert.equal(store.peek()["https://a.example"]!.pages.length, 5);
});

test("stale, corrupt and excess site contexts are dropped", async () => {
  const fresh = { ...emptyContext(CONTEXT_TTL_MS), pages: ["Fresh"] };
  const stale = { ...emptyContext(0), pages: ["Stale"] };
  const now = CONTEXT_TTL_MS + 10;
  assert.equal(await createContextCarryover(memoryStore({ "https://a.example": stale }), () => now).contextFor("https://a.example/", ["x"]), undefined);
  assert.deepEqual((await createContextCarryover(memoryStore({ "https://a.example": fresh }), () => now).contextFor("https://a.example/", ["x"]))!.pages, ["Fresh"]);
  assert.equal(await createContextCarryover(memoryStore("garbage"), () => now).contextFor("https://a.example/", ["x"]), undefined);

  const store = memoryStore();
  let clock = 0;
  const carryover = createContextCarryover(store, () => ++clock);
  for (let index = 0; index <= MAX_SITES; index++) await carryover.notePage(`https://site${index}.example/`, "Home");
  assert.equal(Object.keys(store.peek()).length, MAX_SITES);
  assert.equal(store.peek()["https://site0.example"], undefined);
});
