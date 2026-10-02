import { TypeSafeClient, TypeSafeDecisionModel } from "@effect/ai-typesafe";
import { Layer, type Redacted } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { DEFAULT_GATEWAY_DECISION_MODEL } from "./providers";

/**
 * Answers `DecisionModel` decisions with one of the gateway's evaluation models (Jev, Laya,
 * Liquid d1), which take typed questions through the TypeSafe-compatible System One API
 * and return calibrated probabilities instead of generated text.
 */
export function vercelDecisionLayer(options: { apiKey: Redacted.Redacted<string>; model?: string }) {
  return TypeSafeDecisionModel.layer({ model: options.model || DEFAULT_GATEWAY_DECISION_MODEL }).pipe(
    Layer.provide(TypeSafeClient.layer({ apiKey: options.apiKey, apiUrl: "https://ai-gateway.vercel.sh/typesafe/v1" })),
    Layer.provide(FetchHttpClient.layer),
  );
}
