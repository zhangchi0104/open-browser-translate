import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  CONTEXT_TTL_MS,
  siteOf,
  emptyContext,
  MAX_GLOSSARY,
  MAX_RECENT,
  notePage,
  promptContext,
  recordBatch,
  type PromptContext,
  type TranslationContext,
} from "../src/modules/translation-context";
import { createContextCarryover, MAX_SITES } from "../src/modules/translation-context/carryover";
import type { TranslationBatchResult } from "../src/modules/translator/translate-batch";

const ok = (translations: string[], terms: { source: string; target: string }[] = []): TranslationBatchResult =>
  ({ status: "ok", translations, terms });

function memoryStore(initial: unknown = undefined) {
  let value = initial;
  return { get: async () => value, set: async (next: Record<string, TranslationContext>) => { value = next; }, peek: () => value as Record<string, TranslationContext> };
}

test("context is keyed by site, so it follows navigation within an origin only", () => {
  assert.equal(siteOf("https://docs.example.com/a?x=1"), "https://docs.example.com");
  assert.equal(siteOf("https://docs.example.com/b#c"), "https://docs.example.com");
  assert.notEqual(siteOf("https://other.example.com/a"), siteOf("https://docs.example.com/a"));
  assert.equal(siteOf("chrome://extensions"), undefined);
  assert.equal(siteOf("not a url"), undefined);
  assert.equal(siteOf(undefined), undefined);
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

// Runs a batch through the carryover and returns the context the batch was sent with. By
// default the batch fails, so it leaves nothing behind.
async function batch(carryover: ReturnType<typeof createContextCarryover>, url: string, blocks: { text: string; tag: string }[], result: TranslationBatchResult = { status: "failed" }) {
  let sent: PromptContext | undefined;
  await carryover.translate(siteOf(url), blocks, async (context) => { sent = context; return result; });
  await carryover.flush();
  return sent;
}

test("context carries from one viewport batch to the next and across pages on the site", async () => {
  const store = memoryStore();
  const carryover = createContextCarryover(store, () => 1000);
  await carryover.notePage(siteOf("https://docs.example.com/intro"), "Intro to Fibers");
  assert.deepEqual(await batch(carryover, "https://docs.example.com/intro", [{ text: "A Fiber is a virtual thread", tag: "p" }],
    ok(["纤程是一种虚拟线程"], [{ source: "Fiber", target: "纤程" }])),
  { pages: ["Intro to Fibers"], glossary: [], recent: [] });

  // The first viewport batch taught the glossary; the next batch on the page sees it...
  const next = await batch(carryover, "https://docs.example.com/intro", [{ text: "Forking a fiber", tag: "p" }]);
  assert.deepEqual(next!.glossary, [{ source: "Fiber", target: "纤程" }]);
  assert.deepEqual(next!.recent, [{ source: "A Fiber is a virtual thread", target: "纤程是一种虚拟线程" }]);

  // ...and so does a later page on the same site, but not another site.
  await carryover.notePage(siteOf("https://docs.example.com/scheduling"), "Scheduling");
  const later = await batch(carryover, "https://docs.example.com/scheduling", [{ text: "Fiber scheduling", tag: "p" }]);
  assert.deepEqual(later!.pages, ["Intro to Fibers", "Scheduling"]);
  assert.deepEqual(later!.glossary, [{ source: "Fiber", target: "纤程" }]);
  assert.equal(await batch(carryover, "https://news.example.org/", [{ text: "Fiber scheduling", tag: "p" }]), undefined);

  // A fresh worker reads the same context back from storage.
  const restarted = createContextCarryover(store, () => 2000);
  assert.deepEqual((await batch(restarted, "https://docs.example.com/x", [{ text: "Fiber", tag: "p" }]))!.glossary, [{ source: "Fiber", target: "纤程" }]);
});

test("failed batches record nothing and concurrent updates are not lost", async () => {
  const store = memoryStore();
  const carryover = createContextCarryover(store, () => 1000);
  await batch(carryover, "https://a.example/", [{ text: "Hello", tag: "p" }], { status: "failed" });
  assert.equal(store.peek(), undefined);
  await Promise.all(Array.from({ length: 5 }, (_, index) => carryover.notePage(siteOf("https://a.example/"), `Page ${index}`)));
  assert.equal(store.peek()["https://a.example"]!.pages.length, 5);
});

test("stale, corrupt and excess site contexts are dropped", async () => {
  const fresh = { ...emptyContext(CONTEXT_TTL_MS), pages: ["Fresh"] };
  const stale = { ...emptyContext(0), pages: ["Stale"] };
  const now = CONTEXT_TTL_MS + 10;
  const block = [{ text: "x", tag: "p" }];
  assert.equal(await batch(createContextCarryover(memoryStore({ "https://a.example": stale }), () => now), "https://a.example/", block), undefined);
  assert.deepEqual((await batch(createContextCarryover(memoryStore({ "https://a.example": fresh }), () => now), "https://a.example/", block))!.pages, ["Fresh"]);
  assert.equal(await batch(createContextCarryover(memoryStore("garbage"), () => now), "https://a.example/", block), undefined);

  const store = memoryStore();
  let clock = 0;
  const carryover = createContextCarryover(store, () => ++clock);
  for (let index = 0; index <= MAX_SITES; index++) await carryover.notePage(siteOf(`https://site${index}.example/`), "Home");
  assert.equal(Object.keys(store.peek()).length, MAX_SITES);
  assert.equal(store.peek()["https://site0.example"], undefined);
});
