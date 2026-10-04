import { describeError, type LogLevel } from "../../shared/debug-log/model";
import { MAX_BATCH_BLOCKS, TRANSLATION_PRIORITY, type Block, type Mode, type PageAnalysisResult, type Purpose, type TranslationBatchResult } from "../../shared/protocol";
import { createBatchQueue, MAX_CONCURRENT_BATCHES, pickByPriority, pickNearViewport, viewportDistance, type Span } from "./viewport";

/** What a session needs from the page it runs on. */
export interface SessionPage<T extends Block> {
  /** Where the item is on screen, or null when it isn't rendered. */
  spanOf(item: T): Span | null;
  /** Whether the item is still in the page; items that aren't are dropped. */
  attached(item: T): boolean;
  viewportHeight(): number;
  /** Analyzes a batch; a rejection counts as a failed analysis. */
  analyze(blocks: readonly T[], mode: Mode): Promise<PageAnalysisResult>;
  /** Translates a batch, reporting each block's text by index as it arrives (`final` for cached blocks). */
  translate(blocks: readonly T[], onBlock: (index: number, text: string, final: boolean) => void): Promise<TranslationBatchResult>;
  /** Shows a loading placeholder for each item. */
  loading(items: readonly T[]): void;
  /** Shows an item's translation; `final` false while it's still being written. */
  show(item: T, text: string, final: boolean): void;
  /** Removes what was shown for these items, leaving their source as it was. */
  discard(items: readonly T[]): void;
  log(level: LogLevel, event: string, detail?: string): void;
}

export interface SessionProgress {
  /** Blocks being analyzed and translated right now. */
  analyzing: number;
  translating: number;
  /** Blocks whose translation is on the page. */
  shown: number;
  failed: number;
  /** Blocks analysis kept only because it had no confident answer. */
  fallbacks: number;
  /** Blocks not yet translated or skipped; scrolling near them continues the session. */
  pending: number;
}

/**
 * Translates a page's content near the viewport, in the order the plan's mode and analysis give
 * it. Two queues run up to `MAX_CONCURRENT_BATCHES` batches each:
 *
 * - Analysis takes the unanalyzed items nearest the viewport. Items it doesn't keep are dropped;
 *   when it has no usable answer every item is kept at the priority of an unsure block.
 * - Translation takes kept items by priority, distance breaking ties, but waits while anything on
 *   screen is unanalyzed, so visible navigation never goes before visible content.
 *
 * Blocks served from the cache stay shown even when the rest of their batch fails. A model that
 * isn't configured stops both queues.
 */
export function createTranslationSession<T extends Block>(
  items: readonly T[],
  mode: Mode,
  page: SessionPage<T>,
  onProgress: (progress: SessionProgress) => void,
) {
  let pending = items.slice();
  const analysis = new Map<T, { keep: boolean; priority: number }>();
  const analyzing = new Set<T>();
  const counts = { translating: 0, shown: 0, failed: 0, fallbacks: 0 };
  let stopped = false;
  let notConfigured: Purpose | undefined;
  const report = () => onProgress({ ...counts, analyzing: analyzing.size, pending: pending.length });
  const dropDetached = () => { pending = pending.filter((item) => page.attached(item)); };
  const stopAll = (purpose: Purpose) => {
    notConfigured = purpose;
    for (const queue of queues) queue.stop();
  };

  const analysisQueue = createBatchQueue<T[]>({
    limit: MAX_CONCURRENT_BATCHES,
    next: () => {
      dropDetached();
      const unanalyzed = pending.filter((item) => !analysis.has(item) && !analyzing.has(item));
      const batch = pickNearViewport(unanalyzed, page.spanOf, page.viewportHeight(), MAX_BATCH_BLOCKS);
      if (batch.length === 0) return undefined;
      for (const item of batch) analyzing.add(item);
      return batch;
    },
    run: async (batch) => {
      try {
        const result = await page.analyze(batch, mode).catch((error): PageAnalysisResult => {
          page.log("error", "内容分析：发送请求失败", describeError(error));
          return { status: "failed" };
        });
        if (stopped) return false;
        if (result.status === "not-configured") {
          stopAll(result.purpose);
          return false;
        }
        const answer = result.status === "ok" && result.blocks.length === batch.length ? result : undefined;
        if (answer) counts.fallbacks += answer.fallbackCount;
        batch.forEach((item, index) => analysis.set(item, answer?.blocks[index] ?? { keep: true, priority: TRANSLATION_PRIORITY.unknown }));
        const skipped = new Set(batch.filter((item) => !analysis.get(item)!.keep));
        if (skipped.size) pending = pending.filter((item) => !skipped.has(item));
        translationQueue.nudge();
        return true;
      } finally {
        for (const item of batch) analyzing.delete(item);
      }
    },
    onChange: report,
  });

  const translationQueue = createBatchQueue<T[]>({
    limit: MAX_CONCURRENT_BATCHES,
    next: () => {
      dropDetached();
      const height = page.viewportHeight();
      const onScreen = (item: T) => {
        const span = page.spanOf(item);
        return span !== null && viewportDistance(span, height) === 0;
      };
      if (pending.some((item) => !analysis.has(item) && onScreen(item))) return undefined;
      const ready = pending.filter((item) => analysis.get(item)?.keep);
      const batch = pickByPriority(ready, page.spanOf, (item) => analysis.get(item)!.priority, height, MAX_BATCH_BLOCKS);
      if (batch.length === 0) return undefined;
      const picked = new Set(batch);
      pending = pending.filter((item) => !picked.has(item));
      return batch;
    },
    run: async (batch) => {
      counts.translating += batch.length;
      try {
        page.loading(batch);
        const final = new Set<T>();
        const result = await page.translate(batch, (index, text, isFinal) => {
          const item = batch[index];
          if (stopped || !item) return;
          page.show(item, text, isFinal);
          if (isFinal) final.add(item);
        });
        if (stopped) return false;
        if (result.status === "ok") {
          batch.forEach((item, index) => page.show(item, result.translations[index]!, true));
          counts.shown += batch.length;
          return true;
        }
        // Streamed text that didn't pass validation goes; blocks the cache served stay.
        const unfinished = batch.filter((item) => !final.has(item));
        page.discard(unfinished);
        counts.shown += final.size;
        if (result.status === "not-configured") {
          stopAll(result.purpose);
          return false;
        }
        if (result.error) page.log("error", "翻译批次失败", result.error);
        counts.failed += unfinished.length;
        return true;
      } finally {
        counts.translating -= batch.length;
      }
    },
    onChange: report,
  });
  const queues = [analysisQueue, translationQueue];

  return {
    /** Adds content that appeared after the session started (infinite scroll, load more). */
    add(added: readonly T[]) {
      if (!added.length) return;
      pending = pending.concat(added);
      this.nudge();
    },
    /** Looks for the next batches, e.g. after scrolling or resizing. */
    nudge() {
      for (const queue of queues) queue.nudge();
    },
    /** Ends the session; batches in flight finish but their results are ignored. */
    stop() {
      stopped = true;
      for (const queue of queues) queue.stop();
    },
    /**
     * Runs until `stop`, or until a model turns out not to be configured, which it resolves with.
     * Batches in flight when it resolves are left to finish.
     */
    async run(): Promise<{ notConfigured?: Purpose }> {
      await Promise.all(queues.map((queue) => queue.drain()));
      return notConfigured ? { notConfigured } : {};
    },
  };
}
export type TranslationSession = ReturnType<typeof createTranslationSession>;
