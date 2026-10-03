import { Effect, Layer } from "effect";
import { describeError } from "../debug-log/model";
import { Translator } from "./index";
import { ContentAnalyzer, type ContentBlock } from "../content-analyzer";
import { analysisLayerFromSettings, translationLayerFromSettings } from "../ai/configured";
import type { ChatGPTCredentials } from "../ai/chatgpt";
import { AiProviders } from "../ai/providers";
import type { AISettings } from "../settings/model";
import type { PromptContext, TermPair } from "../translation-context";

/** The language pages are translated into. */
export const TARGET_LANGUAGE = "简体中文";

export type TranslationBatchResult =
  | { status: "ok"; translations: (string | null)[]; terms: readonly TermPair[]; analysisFallbackCount: number; analysisError?: string }
  | { status: "not-configured"; purpose: "analysis" | "translation" }
  | { status: "failed"; error?: string };

/** Provider and model of a purpose, as recorded on its span. */
export function modelAttributes(settings: AISettings, purpose: Purpose) {
  const { provider, models, reasoningEffort, fast } = settings[purpose];
  return {
    "obt.provider": provider,
    "gen_ai.request.model": (models as Record<string, string | undefined>)[provider] ?? "",
    ...(reasoningEffort && { "obt.reasoning_effort": reasoningEffort }),
    ...(fast && provider === AiProviders.OpenAISubscription && { "obt.fast": true }),
  };
}

type Purpose = "analysis" | "translation";
export function missingConfiguration(settings: AISettings, chatgpt?: ChatGPTCredentials, purposes: readonly Purpose[] = ["analysis", "translation"]): Purpose | undefined {
  for (const purpose of purposes) {
    const selected = settings[purpose];
    const model = (selected.models as Record<string, string | undefined>)[selected.provider];
    const connected = selected.provider === AiProviders.OpenAISubscription ? !!chatgpt : !!settings.providers[selected.provider].apiKey.trim();
    if (!connected || !model?.trim()) return purpose;
  }
}
export function translateBatch(
  blocks: readonly ContentBlock[],
  mode: "all" | "main",
  settings: AISettings,
  chatgpt?: ChatGPTCredentials,
  context?: PromptContext,
  /** Receives a block's translation (by its index in `blocks`) as it streams; omit to translate without streaming. */
  onPartial?: (index: number, text: string) => void,
) {
  const missing = missingConfiguration(settings, chatgpt);
  if (missing) return Effect.succeed<TranslationBatchResult>({ status: "not-configured", purpose: missing });
  // Each step is a span, so a trace shows how long analysis and translation took and which failed.
  return Effect.gen(function* () {
    const analyzed = yield* ContentAnalyzer.use((service) => service.analyze(blocks, { mode })).pipe(
      Effect.provide(ContentAnalyzer.Live.pipe(Layer.provide(analysisLayerFromSettings(settings, chatgpt)))),
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
      Effect.provide(Translator.Live.pipe(Layer.provide(translationLayerFromSettings(settings, chatgpt)))),
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
    Effect.catch((error) => Effect.succeed<TranslationBatchResult>({ status: "failed", error: describeError(error) })),
  );
}
