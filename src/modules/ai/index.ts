import { TypeSafeClient, TypeSafeDecisionModel } from "@effect/ai-typesafe";
import { Layer, type Redacted } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

export { DecisionModel as AI } from "effect/unstable/ai/DecisionModel";
export * as LanguageModel from "effect/unstable/ai/LanguageModel";
export { vercelLayer } from "./vercel";

export function jevLayer(options: {
  apiKey: Redacted.Redacted<string>;
  model?: string;
  provider?: "TypeSafe" | "VercelAIGateway";
}) {
  const gateway = options.provider === "VercelAIGateway";
  return TypeSafeDecisionModel.layer({ model: options.model ?? (gateway ? "typesafe-ai/jev" : "jev-latest") }).pipe(
    Layer.provide(TypeSafeClient.layer({
      apiKey: options.apiKey,
      apiUrl: gateway ? "https://ai-gateway.vercel.sh/typesafe/v1" : undefined,
    })),
    Layer.provide(FetchHttpClient.layer),
  );
}
