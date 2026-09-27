import { Effect, Layer } from "effect";
import { Translator } from "./index";
import { ContentAnalyzer, type ContentBlock } from "../content-analyzer";
import { analysisLayerFromSettings, translationLayerFromSettings } from "../ai/configured";
import type { AISettings } from "../settings/model";

export type TranslationBatchResult =
  | { status: "ok"; translations: (string | null)[]; analysisFallbackCount: number }
  | { status: "not-configured"; purpose: "analysis" | "translation" }
  | { status: "failed" };

export function missingConfiguration(settings: AISettings): "analysis" | "translation" | undefined {
  for (const purpose of ["analysis", "translation"] as const) {
    const selected = settings[purpose];
    const model = (selected.models as Record<string, string>)[selected.provider];
    if (!settings.providers[selected.provider].apiKey.trim() || !model?.trim()) return purpose;
  }
}
export function translateBatch(blocks: readonly ContentBlock[], mode: "all" | "main", settings: AISettings) {
  const missing = missingConfiguration(settings);
  if (missing) return Effect.succeed<TranslationBatchResult>({ status: "not-configured", purpose: missing });
  return Effect.gen(function* () {
    const analyzed = yield* ContentAnalyzer.use((service) => service.analyze(blocks, { mode })).pipe(
      Effect.provide(ContentAnalyzer.Live.pipe(Layer.provide(analysisLayerFromSettings(settings)))),
    );
    const selected = analyzed.flatMap((item, index) => item.shouldTranslate ? [index] : []);
    const translated = yield* Translator.use((service) => service.translate(selected.map((index) => blocks[index]!.text), "简体中文")).pipe(
      Effect.provide(Translator.Live.pipe(Layer.provide(translationLayerFromSettings(settings)))),
    );
    const translations: (string | null)[] = blocks.map(() => null);
    selected.forEach((index, position) => { translations[index] = translated[position]!; });
    return { status: "ok", translations, analysisFallbackCount: analyzed.filter((item) => item.fallbackReason).length } as const;
  }).pipe(
    Effect.timeout("45 seconds"),
    Effect.catch(() => Effect.succeed<TranslationBatchResult>({ status: "failed" })),
  );
}
