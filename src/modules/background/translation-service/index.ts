import { Effect } from "effect";
import { modelConfig, modelIdentity } from "../ai/models";
import type { Cache } from "../cache-store";
import { describeError } from "../../shared/debug-log/model";
import type { Block, OnBlock, TranslationBatchResult } from "../../shared/protocol";
import { Settings } from "../../shared/settings/service";
import { targetLanguageOf } from "../../shared/settings/model";
import { translateBatch, type PromptInput } from "./translate-batch";

export interface TranslateRequest {
  /** The page's site (`siteOf`); without one nothing is read from or written to the cache. */
  readonly site?: string;
  /** Sent with the blocks the model translates. */
  readonly context?: PromptInput;
  /** Receives a block's text by index in the batch: cached ones at once and final, the rest as they stream. */
  readonly onBlock?: OnBlock;
}

type Ok = Extract<TranslationBatchResult, { status: "ok" }>;
/** A batch's outcome; an ok one also says which blocks the cache served. */
export type ServiceResult = Exclude<TranslationBatchResult, Ok> | (Ok & { readonly cached: readonly boolean[] });

/**
 * Translation with a read-through cache in front of the model (ADR-0002). Cached blocks go to
 * `onBlock` at once; they stay valid even if the batch then fails, since only the other blocks
 * failed. The rest go to the model, and a successful result is cached. The cache key's model is
 * the one the request's settings pick, the same settings the model is built from.
 */
export function createTranslationService(cache: Cache) {
  return {
    translate: (blocks: readonly Block[], request: TranslateRequest = {}) => Effect.gen(function* () {
      const settings = yield* Settings.use((service) => service.get);
      const config = modelConfig(settings, "translation");
      const scope = request.site ? { origin: request.site, parts: [targetLanguageOf(settings).name, ...modelIdentity(config)] } : undefined;
      const texts = blocks.map(({ text }) => text);
      const hits = scope ? yield* Effect.tryPromise(() => cache.get(scope, texts)) : texts.map(() => undefined);
      hits.forEach((translation, index) => { if (translation !== undefined) request.onBlock?.(index, translation, true); });
      const cached = hits.map((translation) => translation !== undefined);
      const misses = cached.flatMap((hit, index) => hit ? [] : [index]);
      const cacheHits = blocks.length - misses.length;
      yield* Effect.annotateCurrentSpan({ "obt.cache.hits": cacheHits });
      if (!misses.length) return { status: "ok", translations: hits.filter((text) => text !== undefined), terms: [], cacheHits, cached } satisfies ServiceResult;

      const missed = misses.map((index) => blocks[index]!);
      const result = yield* translateBatch(missed, {
        context: request.context,
        onPartial: request.onBlock && ((index, text) => request.onBlock!(misses[index]!, text, false)),
      });
      if (result.status !== "ok") return result;
      if (scope) yield* Effect.tryPromise(() => cache.put(scope, missed.map(({ text }, position) => ({ item: text, value: result.translations[position]! }))));
      // Misses are in batch order, so each uncached block takes the next fresh translation.
      let next = 0;
      const translations = hits.map((text) => text ?? result.translations[next++]!);
      return { ...result, translations, cacheHits, cached } satisfies ServiceResult;
    }).pipe(
      Effect.catch((error) => Effect.succeed<ServiceResult>({ status: "failed", error: describeError(error) })),
    ),
  };
}
export type TranslationService = ReturnType<typeof createTranslationService>;
