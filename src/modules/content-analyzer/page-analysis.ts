import { Effect, Layer } from "effect";
import { ContentAnalyzer } from "./index";
import type { Block, Mode } from "../protocol";
import { AnalysisModel, type Purpose } from "../ai/models";
import { describeError } from "../debug-log/model";

export type PageAnalysisResult =
  | { status: "ok"; blocks: { keep: boolean; priority: number }[]; fallbackCount: number }
  | { status: "not-configured"; purpose: Purpose }
  | { status: "failed"; error?: string };

export function analyzePageContent(blocks: readonly Block[], mode: Mode = "main") {
  return ContentAnalyzer.use((analyzer) => analyzer.analyze(blocks, { mode })).pipe(
    Effect.provide(ContentAnalyzer.Live.pipe(Layer.provide(AnalysisModel))),
    Effect.timeout("15 seconds"),
    Effect.map((items): PageAnalysisResult => ({
      status: "ok",
      blocks: items.map((item) => ({ keep: item.shouldTranslate, priority: item.priority })),
      fallbackCount: items.filter((item) => item.fallbackReason !== undefined).length,
    })),
    Effect.catchTag("ModelNotConfigured", ({ purpose }) => Effect.succeed<PageAnalysisResult>({ status: "not-configured", purpose })),
    Effect.catch((error) => Effect.succeed<PageAnalysisResult>({ status: "failed", error: describeError(error) })),
  );
}
