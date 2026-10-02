import { Redacted } from "effect";
import type { AISettings } from "../settings/model";
import { AiProviders } from "./providers";
import { jevLayer } from "./index";
import { openAICompatibleLayer } from "./vercel";
import { chatgptLayer, type ChatGPTCredentials } from "./chatgpt";

export function analysisLayerFromSettings(settings: AISettings) {
  const { provider, models } = settings.analysis;
  return jevLayer({ provider, model: models[provider], apiKey: Redacted.make(settings.providers[provider].apiKey) });
}

export function translationLayerFromSettings(settings: AISettings, chatgpt?: ChatGPTCredentials) {
  const { provider, models } = settings.translation;
  if (provider === AiProviders.OpenAISubscription) {
    if (!chatgpt) throw new Error("ChatGPT is not signed in");
    return chatgptLayer({ model: models[provider], credentials: chatgpt });
  }
  return openAICompatibleLayer({
    model: models[provider],
    apiKey: Redacted.make(settings.providers[provider].apiKey),
    apiUrl: provider === AiProviders.VercelAIGateway ? "https://ai-gateway.vercel.sh/v1" : "https://api.openai.com/v1",
  });
}
