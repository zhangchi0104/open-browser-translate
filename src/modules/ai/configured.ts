import { Redacted } from "effect";
import type { AISettings } from "../settings/model";
import { AiProviders } from "./providers";
import { openAICompatibleLayer } from "./vercel";
import { chatgptLayer, type ChatGPTCredentials } from "./chatgpt";
import { chatgptDecisionLayer, openAIDecisionLayer } from "./openai-decisions";
import { vercelDecisionLayer } from "./gateway-decisions";

export function analysisLayerFromSettings(settings: AISettings, chatgpt?: ChatGPTCredentials) {
  const { provider, models, reasoningEffort } = settings.analysis;
  if (provider === AiProviders.OpenAISubscription) {
    if (!chatgpt) throw new Error("ChatGPT is not signed in");
    return chatgptDecisionLayer({ model: models[provider], credentials: chatgpt, reasoningEffort });
  }
  if (provider === AiProviders.VercelAIGateway) {
    return vercelDecisionLayer({ model: models[provider], apiKey: Redacted.make(settings.providers[provider].apiKey) });
  }
  return openAIDecisionLayer({ model: models[provider], apiKey: Redacted.make(settings.providers[provider].apiKey), reasoningEffort });
}

export function translationLayerFromSettings(settings: AISettings, chatgpt?: ChatGPTCredentials) {
  const { provider, models, reasoningEffort } = settings.translation;
  if (provider === AiProviders.OpenAISubscription) {
    if (!chatgpt) throw new Error("ChatGPT is not signed in");
    return chatgptLayer({ model: models[provider], credentials: chatgpt, reasoningEffort });
  }
  return openAICompatibleLayer({
    model: models[provider],
    apiKey: Redacted.make(settings.providers[provider].apiKey),
    apiUrl: provider === AiProviders.VercelAIGateway ? "https://ai-gateway.vercel.sh/v1" : "https://api.openai.com/v1",
    reasoningEffort,
  });
}
