import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai-compat";
import { Layer, type Redacted } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

export function vercelLayer(options: {
  apiKey: Redacted.Redacted<string>;
  model: string;
}) {
  return openAICompatibleLayer({ ...options, apiUrl: "https://ai-gateway.vercel.sh/v1" });
}

export function openAICompatibleLayer(options: {
  apiKey: Redacted.Redacted<string>;
  model: string;
  apiUrl: string;
}) {
  return OpenAiLanguageModel.layer({ model: options.model }).pipe(
    Layer.provide(OpenAiClient.layer({
      apiKey: options.apiKey,
      apiUrl: options.apiUrl,
    })),
    Layer.provide(FetchHttpClient.layer),
  );
}
