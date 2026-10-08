import { TypeSafeClient } from "@effect/ai-typesafe";
import type * as TypeSafeSchema from "@effect/ai-typesafe/TypeSafeSchema";
import { Effect, Layer, type Redacted } from "effect";
import { DecisionModel } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import { DEFAULT_GATEWAY_DECISION_MODEL } from "../../shared/settings/model";
import { normalizeDistribution } from "./distribution";

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
