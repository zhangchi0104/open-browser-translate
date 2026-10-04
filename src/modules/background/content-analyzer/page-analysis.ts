import { Effect, Layer, Option, Schema } from "effect";
import { ContentAnalyzer, judge, type AnalyzedContent } from "./index";
import { CONTENT_ROLES, type Block, type Mode, type PageAnalysisResult } from "../../shared/protocol";
import { AnalysisModel, modelConfig } from "../ai/models";
import type { Cache } from "../cache-store";
import { describeError } from "../../shared/debug-log/model";
import { Settings } from "../../shared/settings/service";

/** A block's role as the model answered it; whether it's translated follows from the mode. */
const CachedRole = Schema.fromJsonString(Schema.Struct({ role: Schema.Literals(CONTENT_ROLES), confidence: Schema.optional(Schema.Number) }));
const decodeCachedRole = Schema.decodeUnknownOption(CachedRole);
const encodeCachedRole = Schema.encodeSync(CachedRole);

export interface AnalysisCacheOptions {
  readonly cache?: Cache;
  /** The page's site (`siteOf`); without one nothing is read from or written to the cache. */
  readonly site?: string;
}

/**
 * Analyzes a batch with a read-through cache in front of the model (ADR-0002): a site's repeated
 * navigation and footers are classified once. The cache keeps each block's role and confidence,
 * keyed by site, provider, model, tag and text, not by mode, since the mode only decides what a
 * role means. Fallbacks (failed requests, oversized blocks) aren't cached.
 */
export function analyzePageContent(blocks: readonly Block[], mode: Mode = "main", { cache, site }: AnalysisCacheOptions = {}) {
  return Effect.gen(function* () {
    const { provider, model } = modelConfig(yield* Settings.use((settings) => settings.get), "analysis");
    const scope = cache && site ? { origin: site, parts: [provider, model] } : undefined;
    const items = blocks.map(({ tag, text }) => JSON.stringify([tag, text]));
    const stored = scope ? yield* Effect.tryPromise(() => cache!.get(scope, items)) : items.map(() => undefined);
    // An entry that doesn't decode counts as a miss and is overwritten.
    const hits = stored.map((value) => value === undefined ? undefined : Option.getOrUndefined(decodeCachedRole(value)));
    const misses = hits.flatMap((hit, index) => hit ? [] : [index]);
    yield* Effect.annotateCurrentSpan({ "obt.cache.hits": blocks.length - misses.length });

    const analyzed: AnalyzedContent[] = misses.length
      ? yield* ContentAnalyzer.use((analyzer) => analyzer.analyze(misses.map((index) => blocks[index]!), { mode })).pipe(
        Effect.provide(ContentAnalyzer.Live.pipe(Layer.provide(AnalysisModel))),
      )
      : [];
    const answered = analyzed.flatMap((item, position) => item.fallbackReason
      ? []
      : [{ item: items[misses[position]!]!, value: encodeCachedRole({ role: item.role, confidence: item.confidence }) }]);
    if (scope && answered.length) yield* Effect.tryPromise(() => cache!.put(scope, answered));

    let next = 0;
    const results = hits.map((hit) => hit ? { ...judge(hit.role, hit.confidence, mode), fallbackReason: undefined } : analyzed[next++]!);
    return {
      status: "ok",
      blocks: results.map((item) => ({ keep: item.shouldTranslate, priority: item.priority })),
      fallbackCount: results.filter((item) => item.fallbackReason !== undefined).length,
    } satisfies PageAnalysisResult;
  }).pipe(
    Effect.timeout("15 seconds"),
    Effect.catchTag("ModelNotConfigured", ({ purpose }) => Effect.succeed<PageAnalysisResult>({ status: "not-configured", purpose })),
    Effect.catch((error) => Effect.succeed<PageAnalysisResult>({ status: "failed", error: describeError(error) })),
  );
}
