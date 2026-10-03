import { TypeSafeClient } from "@effect/ai-typesafe";
import type * as TypeSafeSchema from "@effect/ai-typesafe/TypeSafeSchema";
import { Effect, Layer, type Redacted } from "effect";
import { DecisionModel } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import { DEFAULT_GATEWAY_DECISION_MODEL } from "./providers";

// How far a distribution's sum may stray from 1 and still count as rounding. Jev's
// probabilities are rounded when serialized, so they can sum to 0.9998 or 1.0002, while
// DecisionModel accepts only 1e-6; anything further off is a wrong answer and still fails.
const ROUNDING_TOLERANCE = 0.05;

/**
 * Rescales a distribution over `labels` to sum to 1, counting labels the provider left out
 * as 0. Returns the input unchanged when the sum is off by more than rounding.
 */
export function normalizeDistribution(labels: readonly string[], probabilities: Readonly<Record<string, number>>): Readonly<Record<string, number>> {
  const values = labels.map((label) => {
    const value = probabilities[label];
    return typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0;
  });
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0 || Math.abs(total - 1) > ROUNDING_TOLERANCE) return probabilities;
  return Object.fromEntries(labels.map((label, index) => [label, values[index]! / total]));
}

/**
 * `DecisionModel` on one of the gateway's evaluation models (Jev, Laya, Liquid d1) through
 * the TypeSafe-compatible System One API. Mirrors `@effect/ai-typesafe`'s TypeSafeDecisionModel,
 * which passes provider values through unchanged, but renormalizes rounded distributions.
 */
const make = (model: string) => Effect.gen(function* () {
  const client = yield* TypeSafeClient.TypeSafeClient;
  return yield* DecisionModel.make({
    decide: ({ state, decisions }) => Effect.gen(function* () {
      const questions: Record<string, typeof TypeSafeSchema.Question.Encoded> = {};
      for (const [key, decision] of Object.entries(decisions)) {
        const type = decision._tag === "Classify" ? "choice" : decision._tag === "Rate" ? "score" : "noul";
        questions[key] = { type, instructions: decision.instructions, criteria: decision.criteria } as typeof TypeSafeSchema.Question.Encoded;
      }
      const response = yield* client.systemOne({ model, state, questions });
      const answers: Record<string, DecisionModel.ProviderAnswer> = {};
      for (const [key, decision] of Object.entries(decisions)) {
        const answer = response.answers[key];
        if (answer?.type === "choice" && decision._tag === "Classify") {
          answers[key] = {
            _tag: "Classify",
            label: answer.choice,
            probabilities: normalizeDistribution(Object.keys(decision.criteria), answer.probabilities),
            confidence: answer.confidence,
          };
        } else if (answer?.type === "score" && decision._tag === "Rate") {
          const levels = decision.criteria;
          const byLevel = Object.fromEntries(levels.flatMap((level, index) => {
            const probability = answer.probabilities[String(index)];
            return probability === undefined ? [] : [[level, probability]];
          }));
          answers[key] = { _tag: "Rate", rating: answer.score, probabilities: normalizeDistribution(levels, byLevel), confidence: answer.confidence };
        } else if (answer?.type === "noul") {
          answers[key] = { _tag: "Probability", probability: answer.noul };
        }
      }
      return { answers, usage: { inputTokens: response.usage?.input_tokens, outputTokens: response.usage?.output_tokens } };
    }),
  });
});

export function vercelDecisionLayer(options: { apiKey: Redacted.Redacted<string>; model?: string }) {
  return Layer.effect(DecisionModel.DecisionModel, make(options.model || DEFAULT_GATEWAY_DECISION_MODEL)).pipe(
    Layer.provide(TypeSafeClient.layer({ apiKey: options.apiKey, apiUrl: "https://ai-gateway.vercel.sh/typesafe/v1" })),
    Layer.provide(FetchHttpClient.layer),
  );
}
