export const enum AiProviders {
  OpenAISubscription = "OpenAISubscription",
  OpenAIApi = "OpenAIApi",
  VercelAIGateway = "VercelAIGateway",
  OpenRouter = "OpenRouter",
  CloudflareAiGateway = "CloudflareAiGateway",
  Custom = "Custom",
}

/** Default OpenAI model for content analysis. */
export const DEFAULT_DECISION_MODEL = "gpt-6-luna";
