import { Effect, Layer } from "effect";
import { describeError } from "../debug-log/model";
import { Translator } from "./index";
import { ContentAnalyzer, type ContentBlock } from "../content-analyzer";
import { analysisLayerFromSettings, translationLayerFromSettings } from "../ai/configured";
import type { ChatGPTCredentials } from "../ai/chatgpt";
import { AiProviders } from "../ai/providers";
import type { AISettings } from "../settings/model";
import type { PromptContext, TermPair } from "../translation-context";

/** Milliseconds spent on content analysis and on translation in one batch. */
export interface BatchTimings { analysisMs: number; translationMs?: number }
export type TranslationBatchResult =
  | { status: "ok"; translations: (string | null)[]; terms: readonly TermPair[]; analysisFallbackCount: number; analysisError?: string; timings: BatchTimings }
  | { status: "not-configured"; purpose: "analysis" | "translation" }
  | { status: "failed"; error?: string; timings?: Partial<BatchTimings> };

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
  // Each step's duration, filled in as it finishes; a step cut short by a failure gets its elapsed time.
  const timings: Partial<BatchTimings> = {};
  let running: { step: keyof BatchTimings; start: number } | undefined;
  const begin = (step: keyof BatchTimings) => { running = { step, start: Date.now() }; };
  const end = () => {
    if (running) timings[running.step] = Date.now() - running.start;
    running = undefined;
  };
  return Effect.gen(function* () {
    begin("analysisMs");
    const analyzed = yield* ContentAnalyzer.use((service) => service.analyze(blocks, { mode })).pipe(
      Effect.provide(ContentAnalyzer.Live.pipe(Layer.provide(analysisLayerFromSettings(settings, chatgpt)))),
    );
    end();
    const selected = analyzed.flatMap((item, index) => item.shouldTranslate ? [index] : []);
    begin("translationMs");
    const translated = yield* Translator.use((service) => service.translate(selected.map((index) => blocks[index]!.text), "简体中文", context)).pipe(
      Effect.provide(Translator.Live.pipe(Layer.provide(translationLayerFromSettings(settings, chatgpt)))),
    );
    end();
    const translations: (string | null)[] = blocks.map(() => null);
    selected.forEach((index, position) => { translations[index] = translated.translations[position]!; });
    const analysisError = analyzed.find((item) => item.fallbackDetail)?.fallbackDetail;
    return {
      status: "ok", translations, terms: translated.terms, analysisFallbackCount: analyzed.filter((item) => item.fallbackReason).length,
      timings: timings as BatchTimings,
      ...(analysisError && { analysisError }),
    } as const;
  }).pipe(
    Effect.timeout("45 seconds"),
    Effect.catch((error) => Effect.sync((): TranslationBatchResult => {
      end();
      return { status: "failed", error: describeError(error), timings };
    })),
  );
}
