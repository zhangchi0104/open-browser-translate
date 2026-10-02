import { Schema } from "effect";
import type { ContentBlock } from "../content-analyzer";
import type { TranslationBatchResult } from "../translator/translate-batch";
import {
  CONTEXT_TTL_MS,
  contextKey,
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
 * the same site. All reads and writes go through one queue, so batches from
 * several tabs never overwrite each other's updates.
 */
export function createContextCarryover(store: ContextStore, now: () => number = Date.now) {
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <A>(task: () => Promise<A>): Promise<A> => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };

  const load = async (): Promise<Record<string, TranslationContext>> => {
    try {
      const decoded = Schema.decodeUnknownSync(Stored)((await store.get()) ?? {});
      return Object.fromEntries(Object.entries(decoded).filter(([, context]) => isFresh(context, now())));
    } catch {
      return {};
    }
  };
  const save = (all: Record<string, TranslationContext>) => store.set(Object.fromEntries(
    Object.entries(all)
      .filter(([, context]) => now() - context.updatedAt < CONTEXT_TTL_MS)
      .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_SITES),
  ));
  const update = (key: string, change: (context: TranslationContext) => TranslationContext) => exclusive(async () => {
    const all = await load();
    all[key] = change(all[key] ?? emptyContext(now()));
    await save(all);
  });

  return {
    /** Remembers the page title when translation starts on a page. */
    notePage: async (url: string | undefined, title: string) => {
      const key = contextKey(url);
      if (key) await update(key, (context) => notePage(context, title, now())).catch(() => {});
    },

    /** The context to send with a batch, or undefined when the site has none. */
    contextFor: async (url: string | undefined, texts: readonly string[]): Promise<PromptContext | undefined> => {
      const key = contextKey(url);
      if (!key) return undefined;
      const context = await exclusive(load).then((all) => all[key], () => undefined);
      return context && promptContext(context, texts);
    },

    /** Folds a translated batch back into the site's context. */
    record: async (url: string | undefined, blocks: readonly ContentBlock[], result: TranslationBatchResult) => {
      const key = contextKey(url);
      if (!key || result.status !== "ok") return;
      const segments = blocks.flatMap(({ text }, index) => {
        const target = result.translations[index];
        return target == null ? [] : [{ source: text, target }];
      });
      if (segments.length === 0) return;
      await update(key, (context) => recordBatch(context, segments, result.terms, now())).catch(() => {});
    },
  };
}
