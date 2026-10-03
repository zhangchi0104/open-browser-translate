import { Effect, Layer } from "effect";
import { describeError } from "../debug-log/model";
import { Translator } from "./index";
import { ContentAnalyzer, type ContentBlock } from "../content-analyzer";
import { AnalysisModel, configuredSettings, modelConfig, TranslationModel, type Purpose } from "../ai/models";
import { AiProviders } from "../ai/providers";
import type { AISettings } from "../settings/model";
import type { PromptContext, TermPair } from "../translation-context";

/** The language pages are translated into. */
export const TARGET_LANGUAGE = "简体中文";

export type TranslationBatchResult =
  | { status: "ok"; translations: (string | null)[]; terms: readonly TermPair[]; analysisFallbackCount: number; analysisError?: string }
  | { status: "not-configured"; purpose: Purpose }
  | { status: "failed"; error?: string };

/** Provider and model of a purpose, as recorded on its span. */
export function modelAttributes(settings: AISettings, purpose: Purpose) {
  const { provider, model, reasoningEffort, fast } = modelConfig(settings, purpose);
  return {
    "obt.provider": provider,
    "gen_ai.request.model": model,
    ...(reasoningEffort && { "obt.reasoning_effort": reasoningEffort }),
    ...(fast && provider === AiProviders.OpenAISubscription && { "obt.fast": true }),
  };
}

export interface TranslateBatchOptions {
  /** Site context from earlier batches, sent with the prompt. */
  context?: PromptContext;
  /** Receives a block's translation (by its index in `blocks`) as it streams; omit to translate without streaming. */
  onPartial?: (index: number, text: string) => void;
  /** The page already ran analysis and sends only blocks to translate. */
  analyzed?: boolean;
}

/** Analyzes and translates one batch on the configured models. Never fails: the outcome is in the result. */
export function translateBatch(blocks: readonly ContentBlock[], mode: "all" | "main", options: TranslateBatchOptions = {}) {
  const { context, onPartial } = options;
  // Each step is a span, so a trace shows how long analysis and translation took and which failed.
  return Effect.gen(function* () {
    const settings = yield* configuredSettings();
    const analyzed = options.analyzed ? blocks.map((block) => ({ content: block, shouldTranslate: true, fallbackReason: undefined, fallbackDetail: undefined })) : yield* ContentAnalyzer.use((service) => service.analyze(blocks, { mode })).pipe(
      Effect.provide(ContentAnalyzer.Live.pipe(Layer.provide(AnalysisModel))),
      Effect.tap((items) => Effect.annotateCurrentSpan({
        "obt.blocks.kept": items.filter((item) => item.shouldTranslate).length,
        "obt.blocks.fallback": items.filter((item) => item.fallbackReason).length,
      })),
      Effect.withSpan("content-analysis", { attributes: { ...modelAttributes(settings, "analysis"), "obt.blocks": blocks.length, "obt.mode": mode } }),
    );
    const selected = analyzed.flatMap((item, index) => item.shouldTranslate ? [index] : []);
    const translated = yield* Translator.use((service) => service.translate(
      selected.map((index) => blocks[index]!.text), TARGET_LANGUAGE, context,
      onPartial && ((id, text) => onPartial(selected[id]!, text)),
    )).pipe(
      Effect.provide(Translator.Live.pipe(Layer.provide(TranslationModel))),
      Effect.tap((result) => Effect.annotateCurrentSpan({ "obt.terms": result.terms.length })),
      Effect.withSpan("translation", { attributes: { ...modelAttributes(settings, "translation"), "obt.blocks": selected.length } }),
    );
    const translations: (string | null)[] = blocks.map(() => null);
    selected.forEach((index, position) => { translations[index] = translated.translations[position]!; });
    const analysisError = analyzed.find((item) => item.fallbackDetail)?.fallbackDetail;
    return {
      status: "ok", translations, terms: translated.terms, analysisFallbackCount: analyzed.filter((item) => item.fallbackReason).length,
      ...(analysisError && { analysisError }),
    } as const;
  }).pipe(
    Effect.timeout("45 seconds"),
    Effect.catchTag("ModelNotConfigured", ({ purpose }) => Effect.succeed<TranslationBatchResult>({ status: "not-configured", purpose })),
    Effect.catch((error) => Effect.succeed<TranslationBatchResult>({ status: "failed", error: describeError(error) })),
  );
}
