import { Schema } from "effect";
import {
  emptyContext,
  isFresh,
  promptContext,
  recordBatch,
  TranslationContext,
  type ContextScope,
  type PromptContext,
} from "./index";
import type { TermPair } from "../../shared/protocol";
import { createStoredValue, type ValueStore } from "../../shared/stored-value";

type Contexts = Record<string, TranslationContext>;

/** Where contexts live; extension storage in the background, a variable in tests. Read as `unknown`: it's validated. */
export type ContextStore = ValueStore<Contexts, unknown>;

// Keeps storage bounded: the most recently translated sites (and works) survive.
export const MAX_CONTEXTS = 50;

const Stored = Schema.Record(Schema.String, TranslationContext);

/**
 * Carries translation context across viewport batches and page navigations, under each batch's
 * `ContextScope`. Stale contexts are dropped, and at most `MAX_CONTEXTS` are kept, the most recent
 * first.
 */
export function createContextCarryover(store: ContextStore, now: () => number = Date.now) {
  const contexts = createStoredValue(store, {
    parse: (stored) => ({ ...Schema.decodeUnknownSync(Stored)(stored ?? {}) }),
    onError: (error) => console.error("Translation context write failed:", error),
  });
  const freshIn = (all: Contexts, key: string) => {
    const context = all[key];
    return context && isFresh(context, now()) ? context : undefined;
  };
  const update = (key: string, change: (context: TranslationContext) => TranslationContext) => contexts.update((all) => {
    const next = { ...all, [key]: change(freshIn(all, key) ?? emptyContext(now())) };
    return Object.fromEntries(Object.entries(next)
      .filter(([, context]) => isFresh(context, now()))
      .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_CONTEXTS));
  });

  return {
    /** The part of the scope's context worth sending with a batch of these texts. */
    contextFor: async (scope: ContextScope | undefined, texts: readonly string[]): Promise<PromptContext | undefined> => {
      const context = scope ? freshIn(await contexts.get(), scope.key) : undefined;
      return context && promptContext(context, scope!.passages, texts);
    },

    /** Folds a translated batch into the scope's context, so later batches and pages under it see it. */
    record: async (scope: ContextScope | undefined, segments: readonly TermPair[], terms: readonly TermPair[]) => {
      if (scope && segments.length) await update(scope.key, (current) => recordBatch(current, scope.passages, segments, terms, now()));
    },

    /** Resolves once every pending write has reached the store. */
    flush: contexts.flush,
  };
}
export type ContextCarryover = ReturnType<typeof createContextCarryover>;
