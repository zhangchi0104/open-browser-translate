import { Effect, Layer } from "effect";
import { Translator } from "./index";
import { ContentAnalyzer, type ContentBlock } from "../content-analyzer";
import { analysisLayerFromSettings, translationLayerFromSettings } from "../ai/configured";
import type { ChatGPTCredentials } from "../ai/chatgpt";
import { AiProviders } from "../ai/providers";
import type { AISettings } from "../settings/model";
import type { PromptContext, TermPair } from "../translation-context";

export type TranslationBatchResult =
  | { status: "ok"; translations: (string | null)[]; terms: readonly TermPair[]; analysisFallbackCount: number }
  | { status: "not-configured"; purpose: "analysis" | "translation" }
  | { status: "failed" };

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
) {
  const missing = missingConfiguration(settings, chatgpt);
  if (missing) return Effect.succeed<TranslationBatchResult>({ status: "not-configured", purpose: missing });
  return Effect.gen(function* () {
    const analyzed = yield* ContentAnalyzer.use((service) => service.analyze(blocks, { mode })).pipe(
      Effect.provide(ContentAnalyzer.Live.pipe(Layer.provide(analysisLayerFromSettings(settings, chatgpt)))),
    );
    const selected = analyzed.flatMap((item, index) => item.shouldTranslate ? [index] : []);
    const translated = yield* Translator.use((service) => service.translate(selected.map((index) => blocks[index]!.text), "简体中文", context)).pipe(
      Effect.provide(Translator.Live.pipe(Layer.provide(translationLayerFromSettings(settings, chatgpt)))),
    );
    const translations: (string | null)[] = blocks.map(() => null);
    selected.forEach((index, position) => { translations[index] = translated.translations[position]!; });
    return { status: "ok", translations, terms: translated.terms, analysisFallbackCount: analyzed.filter((item) => item.fallbackReason).length } as const;
  }).pipe(
    Effect.timeout("45 seconds"),
    Effect.catch(() => Effect.succeed<TranslationBatchResult>({ status: "failed" })),
  );
}
