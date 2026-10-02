import { Effect, Layer } from "effect";
import { ContentAnalyzer, type ContentBlock } from "./index";
import { analysisLayerFromSettings } from "../ai/configured";
import { describeError } from "../debug-log/model";
import type { ChatGPTCredentials } from "../ai/chatgpt";
import { missingConfiguration } from "../translator/translate-batch";
import type { AISettings } from "../settings/model";

export type PageAnalysisResult =
  | { status: "ok"; keep: boolean[]; fallbackCount: number }
  | { status: "not-configured" }
  | { status: "failed"; error?: string };

export function analyzePageContent(blocks: readonly ContentBlock[], settings: AISettings, chatgpt?: ChatGPTCredentials) {
  if (missingConfiguration(settings, chatgpt, ["analysis"])) {
    return Effect.succeed<PageAnalysisResult>({ status: "not-configured" });
  }
  return ContentAnalyzer.use((analyzer) => analyzer.analyze(blocks, { mode: "main" })).pipe(
    Effect.provide(ContentAnalyzer.Live.pipe(Layer.provide(analysisLayerFromSettings(settings, chatgpt)))),
    Effect.timeout("15 seconds"),
    Effect.match({
      onFailure: (error): PageAnalysisResult => ({ status: "failed", error: describeError(error) }),
      onSuccess: (items): PageAnalysisResult => ({
        status: "ok",
        keep: items.map((item) => item.shouldTranslate),
        fallbackCount: items.filter((item) => item.fallbackReason !== undefined).length,
      }),
    }),
  );
}
