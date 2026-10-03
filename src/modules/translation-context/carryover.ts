import { Schema } from "effect";
import type { ContentBlock } from "../content-analyzer";
import type { TranslationBatchResult } from "../translator/translate-batch";
import {
  emptyContext,
  isFresh,
  notePage,
  promptContext,
  recordBatch,
  TranslationContext,
  type PromptContext,
} from "./index";

/** Where contexts live; extension storage in the background, a Map in tests. */
export interface ContextStore {
  get(): Promise<unknown>;
  set(value: Record<string, TranslationContext>): Promise<void>;
}

// Keeps storage bounded: the most recently translated sites survive.
export const MAX_SITES = 50;

const Stored = Schema.Record(Schema.String, TranslationContext);

/**
 * Carries translation context across viewport batches and page navigations on
 * the same site. Contexts are read from the store once and kept in memory;
 * writes go through one queue so they land in order.
 */
export function createContextCarryover(store: ContextStore, now: () => number = Date.now) {
  let cache: Promise<Record<string, TranslationContext>> | undefined;
  const load = () => cache ??= store.get()
    .then((value): Record<string, TranslationContext> => ({ ...Schema.decodeUnknownSync(Stored)(value ?? {}) }))
    .catch((): Record<string, TranslationContext> => ({}));
  const fresh = async (key: string) => {
    const context = (await load())[key];
    return context && isFresh(context, now()) ? context : undefined;
  };

  let writes: Promise<void> = Promise.resolve();
  const update = (key: string, change: (context: TranslationContext) => TranslationContext) => {
    writes = writes.then(async () => {
      const all = await load();
      all[key] = change((await fresh(key)) ?? emptyContext(now()));
      const kept = Object.entries(all)
        .filter(([, context]) => isFresh(context, now()))
        .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_SITES);
      cache = Promise.resolve(Object.fromEntries(kept));
      await store.set(Object.fromEntries(kept));
    }).catch(() => {});
    return writes;
  };

  return {
    /** Remembers the page title when translation starts on a page of `site` (see `siteOf`). */
    notePage: async (site: string | undefined, title: string) => {
      if (site) await update(site, (context) => notePage(context, title, now()));
    },

    /**
     * Runs one batch with the site's context and folds the result back in, so
     * the next batch or page on the site sees it.
     */
    translate: async (
      site: string | undefined,
      blocks: readonly ContentBlock[],
      run: (context: PromptContext | undefined) => Promise<TranslationBatchResult>,
    ): Promise<TranslationBatchResult> => {
      const context = site ? await fresh(site) : undefined;
      const result = await run(context && promptContext(context, blocks.map(({ text }) => text)));
      if (!site || result.status !== "ok") return result;
      const segments = blocks.map(({ text }, index) => ({ source: text, target: result.translations[index]! }));
      // Not awaited: the reader shouldn't wait on storage to see the translation.
      if (segments.length) void update(site, (current) => recordBatch(current, segments, result.terms, now()));
      return result;
    },

    /** Resolves once every pending write has reached the store. */
    flush: () => writes,
  };
}
export type ContextCarryover = ReturnType<typeof createContextCarryover>;
