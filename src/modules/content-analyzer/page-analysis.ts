import { Effect, Layer } from "effect";
import { ContentAnalyzer, type ContentBlock } from "./index";
import { AnalysisModel } from "../ai/models";
import { describeError } from "../debug-log/model";

export type PageAnalysisResult =
  | { status: "ok"; blocks: { keep: boolean; priority: number }[]; fallbackCount: number }
  | { status: "not-configured" }
  | { status: "failed"; error?: string };

export function analyzePageContent(blocks: readonly ContentBlock[], mode: "all" | "main" = "main") {
  return ContentAnalyzer.use((analyzer) => analyzer.analyze(blocks, { mode })).pipe(
    Effect.provide(ContentAnalyzer.Live.pipe(Layer.provide(AnalysisModel))),
    Effect.timeout("15 seconds"),
    Effect.map((items): PageAnalysisResult => ({
      status: "ok",
      blocks: items.map((item) => ({ keep: item.shouldTranslate, priority: item.priority })),
      fallbackCount: items.filter((item) => item.fallbackReason !== undefined).length,
    })),
    Effect.catchTag("ModelNotConfigured", () => Effect.succeed<PageAnalysisResult>({ status: "not-configured" })),
    Effect.catch((error) => Effect.succeed<PageAnalysisResult>({ status: "failed", error: describeError(error) })),
  );
}
