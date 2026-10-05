import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai-compat";
import { Layer, Redacted } from "effect";
import type { ReasoningEffort } from "../../shared/settings/model";
import { FetchHttpClient } from "effect/unstable/http";

export function vercelLayer(options: {
  apiKey: Redacted.Redacted<string>;
  model: string;
  reasoningEffort?: ReasoningEffort;
}) {
  return openAICompatibleLayer({ ...options, apiUrl: "https://ai-gateway.vercel.sh/v1" });
}

export function openAICompatibleLayer(options: {
  apiKey: Redacted.Redacted<string>;
  model: string;
  apiUrl: string;
  reasoningEffort?: ReasoningEffort;
}) {
  // Chat Completions takes `reasoning_effort` (the gateway too); unknown config keys pass through to the body.
  const config = options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : undefined;
  return OpenAiLanguageModel.layer({ model: options.model, config }).pipe(
    Layer.provide(OpenAiClient.layer({
      // A custom connection to a local server may have no key; send no Authorization header then.
      apiKey: Redacted.value(options.apiKey) ? options.apiKey : undefined,
      apiUrl: options.apiUrl,
    })),
    Layer.provide(FetchHttpClient.layer),
  );
}
