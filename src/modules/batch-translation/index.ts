import { Effect } from "effect";
import { modelConfig } from "../ai/models";
import { describeError } from "../debug-log/model";
import type { Block, OnBlock, TranslationBatchResult } from "../protocol";
import { Settings } from "../settings/service";
import { siteOf } from "../translation-context";
import type { ContextCarryover } from "../translation-context/carryover";
import type { TranslationCache } from "../translation-cache";
import { TARGET_LANGUAGE, translateBatch } from "../translator/translate-batch";

/** Where a page's batches find earlier work: cached translations and the site's context. */
export interface BatchStores {
  readonly cache: TranslationCache;
  readonly contexts: ContextCarryover;
}

/**
 * Translates one batch of a page's blocks, in this order:
 *
 * 1. Blocks cached for the page's site go to `onBlock` at once, `final`. They stay valid even if
 *    the batch then fails: only the other blocks failed.
 * 2. The rest go to the translation model with the site's context, their text streaming to
 *    `onBlock` (by index in `blocks`) as it's written. A successful result is cached and folded
 *    into the site's context for later batches and pages.
 *
 * A page without a site (`siteOf`; private windows pass no URL) uses neither store. Never fails:
 * the outcome is in the result, with one translation per block in `blocks` order when it's ok.
 */
export function translatePageBatch(blocks: readonly Block[], pageUrl: string | undefined, stores: BatchStores, onBlock?: OnBlock) {
  return Effect.gen(function* () {
    const site = siteOf(pageUrl);
    const { provider, model } = modelConfig(yield* Settings.use((settings) => settings.get), "translation");
    const scope = site && { origin: site, target: TARGET_LANGUAGE, provider, model };
    const texts = blocks.map(({ text }) => text);
    const cached = scope ? yield* Effect.tryPromise(() => stores.cache.get(scope, texts)) : texts.map(() => undefined);
    cached.forEach((translation, index) => { if (translation !== undefined) onBlock?.(index, translation, true); });
    const misses = cached.flatMap((translation, index) => translation === undefined ? [index] : []);
    const cacheHits = blocks.length - misses.length;
    yield* Effect.annotateCurrentSpan({ "obt.cache.hits": cacheHits });
    if (!misses.length) return { status: "ok", translations: cached.filter((text) => text !== undefined), terms: [], cacheHits } satisfies TranslationBatchResult;

    const missed = misses.map((index) => blocks[index]!);
    const result = yield* translateBatch(missed, {
      context: yield* Effect.tryPromise(() => stores.contexts.contextFor(site, missed.map(({ text }) => text))),
      onPartial: onBlock && ((index, text) => onBlock(misses[index]!, text, false)),
    });
    if (result.status !== "ok") return result;
    yield* Effect.annotateCurrentSpan({ "obt.terms": result.terms.length });
    const segments = missed.map(({ text }, position) => ({ source: text, target: result.translations[position]! }));
    if (scope) yield* Effect.tryPromise(() => stores.cache.put(scope, segments.map(({ source, target }) => ({ text: source, translation: target }))));
    // Not awaited: the reader shouldn't wait on storage to see the translation.
    void stores.contexts.record(site, segments, result.terms);
    // Misses are in page order, so each uncached block takes the next fresh translation.
    let next = 0;
    const translations = cached.map((text) => text ?? result.translations[next++]!);
    return { ...result, translations, cacheHits };
  }).pipe(
    Effect.catch((error) => Effect.succeed<TranslationBatchResult>({ status: "failed", error: describeError(error) })),
  );
}
