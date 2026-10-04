import { Effect } from "effect";
import { describeError } from "../../shared/debug-log/model";
import type { Block, OnBlock, Surroundings, TranslationBatchResult } from "../../shared/protocol";
import { siteOf } from "../site-context";
import type { ContextCarryover } from "../site-context/carryover";
import type { TranslationService } from "../translation-service";

/** What a page's batches are translated with: the service (cache and model) and the site contexts. */
export interface BatchStores {
  readonly translation: TranslationService;
  readonly contexts: ContextCarryover;
}

/**
 * Translates one batch of a page's blocks: takes a snapshot of the site's context, sends it with
 * the batch's surroundings to the translation service, and folds what the model newly translated
 * back into the context for later batches and pages. The cache is the service's business
 * (ADR-0002); the dispatcher keeps no queue (ADR-0001), so concurrent batches each see the
 * context as it was when they started.
 *
 * A page without a site (`siteOf`; private windows pass no URL) keeps no context and no cache.
 * Never fails: the outcome is in the result, with one translation per block in `blocks` order
 * when it's ok.
 */
export function translatePageBatch(
  blocks: readonly Block[],
  pageUrl: string | undefined,
  stores: BatchStores,
  onBlock?: OnBlock,
  surroundings: Surroundings = {},
) {
  return Effect.gen(function* () {
    const site = siteOf(pageUrl);
    const texts = blocks.map(({ text }) => text);
    const siteContext = yield* Effect.tryPromise(() => stores.contexts.contextFor(site, texts));
    const context = siteContext || surroundings.brief || surroundings.preceding ? { ...siteContext, ...surroundings } : undefined;
    const result = yield* stores.translation.translate(blocks, { site, context, onBlock });
    if (result.status !== "ok") return result;
    const { cached, ...reply } = result;
    yield* Effect.annotateCurrentSpan({ "obt.terms": reply.terms.length });
    const fresh = blocks.flatMap(({ text }, index) => cached[index] ? [] : [{ source: text, target: reply.translations[index]! }]);
    // Not awaited: the reader shouldn't wait on storage to see the translation.
    void stores.contexts.record(site, fresh, reply.terms);
    return reply satisfies TranslationBatchResult;
  }).pipe(
    Effect.catch((error) => Effect.succeed<TranslationBatchResult>({ status: "failed", error: describeError(error) })),
  );
}
