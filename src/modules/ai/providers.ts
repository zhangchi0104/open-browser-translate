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
/** Default Vercel AI Gateway evaluation model for content analysis; it answers decisions natively. */
export const DEFAULT_GATEWAY_DECISION_MODEL = "typesafe-ai/jev";
/** The gateway's evaluation models, which answer decisions through the System One API. */
export const GATEWAY_DECISION_MODELS = [
  { slug: "typesafe-ai/jev", displayName: "Jev" },
  { slug: "convaiinnovations/laya", displayName: "Laya" },
  { slug: "convaiinnovations/laya-free", displayName: "Laya (Free)" },
  { slug: "liquid/d1", displayName: "Liquid d1" },
];
