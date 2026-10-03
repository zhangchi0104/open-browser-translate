import { Schema } from "effect";
import {
  emptyContext,
  isFresh,
  notePage,
  promptContext,
  recordBatch,
  TranslationContext,
  type PromptContext,
  type TermPair,
} from "./index";
import { createStoredValue, type ValueStore } from "../stored-value";

type Contexts = Record<string, TranslationContext>;

/** Where contexts live; extension storage in the background, a variable in tests. */
export type ContextStore = ValueStore<Contexts>;

// Keeps storage bounded: the most recently translated sites survive.
export const MAX_SITES = 50;

const Stored = Schema.Record(Schema.String, TranslationContext);

/**
 * Carries translation context across viewport batches and page navigations on the same site.
 * Stale contexts are dropped, and at most `MAX_SITES` sites are kept, the most recent first.
 */
export function createContextCarryover(store: ContextStore, now: () => number = Date.now) {
  const contexts = createStoredValue(store, {
    parse: (stored) => ({ ...Schema.decodeUnknownSync(Stored)(stored ?? {}) }),
    onError: (error) => console.error("Translation context write failed:", error),
  });
  const freshIn = (all: Contexts, site: string) => {
    const context = all[site];
    return context && isFresh(context, now()) ? context : undefined;
  };
  const update = (site: string, change: (context: TranslationContext) => TranslationContext) => contexts.update((all) => {
    const next = { ...all, [site]: change(freshIn(all, site) ?? emptyContext(now())) };
    return Object.fromEntries(Object.entries(next)
      .filter(([, context]) => isFresh(context, now()))
      .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_SITES));
  });

  return {
    /** Remembers the page title when translation starts on a page of `site` (see `siteOf`). */
    notePage: async (site: string | undefined, title: string) => {
      if (site) await update(site, (context) => notePage(context, title, now()));
    },

    /** The part of `site`'s context worth sending with a batch of these texts. */
    contextFor: async (site: string | undefined, texts: readonly string[]): Promise<PromptContext | undefined> => {
      const context = site ? freshIn(await contexts.get(), site) : undefined;
      return context && promptContext(context, texts);
    },

    /** Folds a translated batch into `site`'s context, so the next batch or page on the site sees it. */
    record: async (site: string | undefined, segments: readonly TermPair[], terms: readonly TermPair[]) => {
      if (site && segments.length) await update(site, (current) => recordBatch(current, segments, terms, now()));
    },

    /** Resolves once every pending write has reached the store. */
    flush: contexts.flush,
  };
}
export type ContextCarryover = ReturnType<typeof createContextCarryover>;
