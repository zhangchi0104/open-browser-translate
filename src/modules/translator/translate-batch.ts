import { Effect, Layer } from "effect";
import { describeError } from "../debug-log/model";
import { Translator } from "./index";
import type { Block } from "../protocol";
import { configuredSettings, modelAttributes, TranslationModel, type Purpose } from "../ai/models";
import type { PromptContext, TermPair } from "../translation-context";

/** The language pages are translated into. */
export const TARGET_LANGUAGE = "简体中文";

export type TranslationBatchResult =
  /** `cacheHits`: how many blocks the page's batch found in the cache. */
  | { status: "ok"; translations: string[]; terms: readonly TermPair[]; cacheHits?: number }
  | { status: "not-configured"; purpose: Purpose }
  | { status: "failed"; error?: string };

export interface TranslateBatchOptions {
  /** Site context from earlier batches, sent with the prompt. */
  context?: PromptContext;
  /** Receives a block's translation (by its index in `blocks`) as it streams; omit to translate without streaming. */
  onPartial?: (index: number, text: string) => void;
}

/**
 * Translates one batch of blocks the page already chose to translate, on the configured model.
 * Never fails: the outcome is in the result, with one translation per block when it's ok.
 */
export function translateBatch(blocks: readonly Block[], options: TranslateBatchOptions = {}) {
  return Effect.gen(function* () {
    const settings = yield* configuredSettings();
    const translated = yield* Translator.use((service) => service.translate(
      blocks.map(({ text }) => text), TARGET_LANGUAGE, options.context, options.onPartial,
    )).pipe(
      Effect.provide(Translator.Live.pipe(Layer.provide(TranslationModel))),
      Effect.tap((result) => Effect.annotateCurrentSpan({ "obt.terms": result.terms.length })),
      // A span, so a trace shows how long translation took and whether it failed.
      Effect.withSpan("translation", { attributes: { ...modelAttributes(settings, "translation"), "obt.blocks": blocks.length } }),
    );
    return { status: "ok", translations: translated.translations, terms: translated.terms } as const;
  }).pipe(
    Effect.timeout("45 seconds"),
    Effect.catchTag("ModelNotConfigured", ({ purpose }) => Effect.succeed<TranslationBatchResult>({ status: "not-configured", purpose })),
    Effect.catch((error) => Effect.succeed<TranslationBatchResult>({ status: "failed", error: describeError(error) })),
  );
}
