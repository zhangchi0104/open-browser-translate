import { Effect } from "effect";
import type { ContentBlock } from "../content-analyzer";
import { modelConfig } from "../ai/models";
import { describeError } from "../debug-log/model";
import { Settings } from "../settings/service";
import { siteOf } from "../translation-context";
import type { ContextCarryover } from "../translation-context/carryover";
import { translateWithCache, type TranslationCache } from "../translation-cache";
import { TARGET_LANGUAGE, translateBatch, type TranslationBatchResult } from "../translator/translate-batch";

/** Where a page's batches find earlier work: cached translations and the site's context. */
export interface BatchStores {
  readonly cache: TranslationCache;
  readonly contexts: ContextCarryover;
}

export type BatchResult = TranslationBatchResult & { cacheHits?: number };

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
export function translatePageBatch(
  blocks: readonly ContentBlock[],
  pageUrl: string | undefined,
  stores: BatchStores,
  onBlock?: (index: number, text: string, final: boolean) => void,
) {
  return Effect.gen(function* () {
    const site = siteOf(pageUrl);
    const { provider, model } = modelConfig(yield* Settings.use((settings) => settings.get), "translation");
    // The stores call back from promises; effects started there still belong to this request.
    const runPromise = Effect.runPromiseWith(yield* Effect.context<Effect.Services<ReturnType<typeof translateBatch>>>());
    const result: BatchResult = yield* Effect.tryPromise(() => translateWithCache({
      cache: site ? stores.cache : undefined,
      scope: site ? { origin: site, target: TARGET_LANGUAGE, provider, model } : undefined,
      blocks,
      onCached: onBlock && ((index, text) => onBlock(index, text, true)),
      translate: (misses, indexes) => stores.contexts.translate(site, misses, (context) => runPromise(translateBatch(misses, {
        context,
        onPartial: onBlock && ((index, text) => onBlock(indexes[index]!, text, false)),
      }))),
    })).pipe(Effect.catch((error) => Effect.succeed<BatchResult>({ status: "failed", error: describeError(error) })));
    yield* Effect.annotateCurrentSpan({
      "obt.blocks": blocks.length,
      "obt.cache.hits": result.cacheHits ?? 0,
      ...(result.status === "ok" && { "obt.terms": result.terms.length }),
    });
    return result;
  });
}
