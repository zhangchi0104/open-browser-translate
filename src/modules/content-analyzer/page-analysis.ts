import { Effect, Layer } from "effect";
import { ContentAnalyzer, type ContentBlock } from "./index";
import { analysisLayerFromSettings } from "../ai/configured";
import type { AISettings } from "../settings/model";

export type PageAnalysisResult =
  | { status: "ok"; keep: boolean[]; fallbackCount: number }
  | { status: "not-configured" | "failed" };

export function analyzePageContent(blocks: readonly ContentBlock[], settings: AISettings) {
  const { provider, models } = settings.analysis;
  if (!settings.providers[provider].apiKey.trim() || !models[provider].trim()) {
    return Effect.succeed<PageAnalysisResult>({ status: "not-configured" });
  }
  return ContentAnalyzer.use((analyzer) => analyzer.analyze(blocks, { mode: "main" })).pipe(
    Effect.provide(ContentAnalyzer.Live.pipe(Layer.provide(analysisLayerFromSettings(settings)))),
    Effect.timeout("15 seconds"),
    Effect.match({
      onFailure: (): PageAnalysisResult => ({ status: "failed" }),
      onSuccess: (items): PageAnalysisResult => ({
        status: "ok",
        keep: items.map((item) => item.shouldTranslate),
        fallbackCount: items.filter((item) => item.fallbackReason !== undefined).length,
      }),
    }),
  );
}
