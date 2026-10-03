import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { PageAnalysisResult } from "../src/modules/content-analyzer/page-analysis";
import type { TranslationBatchResult } from "../src/modules/translator/translate-batch";
import { createTranslationSession, type SessionPage, type SessionProgress } from "../src/modules/translation-session";

interface Item { text: string; tag: string; top: number }
const VIEWPORT = 1000;
const item = (text: string, top: number, tag = "p"): Item => ({ text, tag, top });
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

/** Roles the fake analysis gives by tag. */
const ROLE: Record<string, { keep: boolean; priority: number }> = {
  p: { keep: true, priority: 0 },
  a: { keep: true, priority: 2 },
  ad: { keep: false, priority: 3 },
};

function fakePage(overrides: Partial<SessionPage<Item>> = {}) {
  const translated: string[][] = [];
  const shown = new Map<string, { text: string; final: boolean }>();
  const discarded: string[] = [];
  const page: SessionPage<Item> = {
    spanOf: ({ top }) => ({ top, bottom: top + 20 }),
    attached: () => true,
    viewportHeight: () => VIEWPORT,
    analyze: async (blocks): Promise<PageAnalysisResult> => ({ status: "ok", blocks: blocks.map(({ tag }) => ROLE[tag]!), fallbackCount: 0 }),
    translate: async (blocks): Promise<TranslationBatchResult> => {
      translated.push(blocks.map(({ text }) => text));
      return { status: "ok", translations: blocks.map(({ text }) => `译：${text}`), terms: [] };
    },
    loading: () => {},
    show: ({ text }, translation, final) => { shown.set(text, { text: translation, final }); },
    discard: (items) => { for (const { text } of items) { discarded.push(text); shown.delete(text); } },
    log: () => {},
    ...overrides,
  };
  return { page, translated, shown, discarded };
}

function start(items: Item[], page: SessionPage<Item>) {
  let progress: SessionProgress | undefined;
  const session = createTranslationSession(items, "all", page, (next) => { progress = next; });
  const done = session.run();
  return { session, done, progress: () => progress! };
}

test("translation waits until everything on screen is analyzed, then takes content before navigation", async () => {
  // Eight links fill the first analysis batch; the story, also on screen, lands in a second one.
  const links = Array.from({ length: 8 }, (_, index) => item(`Link ${index}`, index * 10, "a"));
  const releases: (() => void)[] = [];
  const fake = fakePage();
  const analyze = fake.page.analyze;
  fake.page.analyze = async (blocks, mode) => {
    await new Promise<void>((resolve) => releases.push(resolve));
    return analyze(blocks, mode);
  };
  const { session, done } = start([...links, item("Story", 500)], fake.page);
  await settle();
  assert.equal(releases.length, 2, "both analysis batches run at once");
  releases[0]!();
  await settle();
  assert.deepEqual(fake.translated, [], "the analyzed links wait for the story on screen");
  releases[1]!();
  await settle();
  assert.deepEqual(fake.translated[0], ["Story", ...links.slice(0, 7).map(({ text }) => text)]);
  assert.deepEqual(fake.translated[1], ["Link 7"]);
  session.stop();
  assert.deepEqual(await done, {});
});

test("blocks analysis drops are never translated; with no answer every block is kept", async () => {
  const fake = fakePage();
  const { session, done } = start([item("Story", 0), item("Buy now", 50, "ad")], fake.page);
  await settle();
  assert.deepEqual(fake.translated, [["Story"]]);

  const failing = fakePage({ analyze: async () => { throw new Error("background gone"); } });
  const second = start([item("Story", 0), item("Buy now", 50, "ad")], failing.page);
  await settle();
  assert.deepEqual(failing.translated, [["Story", "Buy now"]], "unsure blocks are kept, in page order");
  session.stop();
  second.session.stop();
  await Promise.all([done, second.done]);
});

test("only content near the viewport goes; content added later or scrolled to joins", async () => {
  let height = VIEWPORT;
  const fake = fakePage({ viewportHeight: () => height });
  const { session, done, progress } = start([item("Near", 0), item("Far", 10_000)], fake.page);
  await settle();
  assert.deepEqual(fake.translated, [["Near"]]);
  assert.equal(progress().pending, 1, "the far block waits");

  session.add([item("Loaded", 200)]);
  await settle();
  assert.deepEqual(fake.translated.at(-1), ["Loaded"]);

  height = 20_000;
  session.nudge();
  await settle();
  assert.deepEqual(fake.translated.at(-1), ["Far"]);
  assert.deepEqual(progress(), { analyzing: 0, translating: 0, shown: 3, failed: 0, fallbacks: 0, pending: 0 });
  session.stop();
  await done;
});

test("a failed batch keeps the blocks the cache served and counts only the rest as failed", async () => {
  const fake = fakePage({
    translate: async (_blocks, onBlock) => {
      onBlock(0, "缓存译文", true);
      onBlock(1, "写了一半", false);
      return { status: "failed", error: "model down" };
    },
  });
  const { session, done, progress } = start([item("Cached", 0), item("Fresh", 50)], fake.page);
  await settle();
  assert.deepEqual(fake.shown.get("Cached"), { text: "缓存译文", final: true });
  assert.deepEqual(fake.discarded, ["Fresh"]);
  assert.equal(progress().shown, 1);
  assert.equal(progress().failed, 1);
  session.stop();
  await done;
});

test("a model that isn't configured ends the session and says which", async () => {
  const fake = fakePage({ translate: async () => ({ status: "not-configured", purpose: "translation" }) });
  const { done } = start([item("Story", 0), item("More", 50)], fake.page);
  assert.deepEqual(await done, { notConfigured: "translation" });

  const unanalyzed = fakePage({ analyze: async () => ({ status: "not-configured", purpose: "analysis" }) });
  assert.deepEqual(await start([item("Story", 0)], unanalyzed.page).done, { notConfigured: "analysis" });
  assert.deepEqual(unanalyzed.translated, []);
});

test("results that arrive after the session stops are ignored", async () => {
  let finish!: () => void;
  const fake = fakePage({
    translate: (_blocks, onBlock) => new Promise((resolve) => {
      finish = () => { onBlock(0, "迟到", false); resolve({ status: "ok", translations: ["迟到"], terms: [] }); };
    }),
  });
  const { session, done } = start([item("Story", 0)], fake.page);
  await settle();
  session.stop();
  await done;
  finish();
  await settle();
  assert.equal(fake.shown.size, 0);
});
