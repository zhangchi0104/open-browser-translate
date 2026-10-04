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

export type AnalysisProvider = AiProviders.VercelAIGateway | AiProviders.OpenAIApi | AiProviders.OpenAISubscription;
export type TranslationProvider = AiProviders.VercelAIGateway | AiProviders.OpenAIApi | AiProviders.OpenAISubscription;
export type SettingsProvider = AnalysisProvider | TranslationProvider;
/** Providers connected with an API key; the ChatGPT subscription signs in instead. */
export type KeyProvider = Exclude<SettingsProvider, AiProviders.OpenAISubscription>;

export function validateModel(provider: SettingsProvider, model: string): string | undefined {
  const value = model.trim();
  if (!value) return;
  if (provider === AiProviders.VercelAIGateway && !/^[^\s/]+\/[^\s/]+$/.test(value)) {
    return "请填写 provider/model 格式的模型 ID";
  }
  if (/\s/.test(value)) return "模型 ID 不能包含空格";
}
/** OpenAI reasoning effort levels; unset leaves the choice to the model. */
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];
export interface AISettings {
  providers: Record<KeyProvider, { apiKey: string }>;
  // `reasoningEffort` applies to OpenAI-style models; the gateway's evaluation models don't reason.
  // `fast` asks the ChatGPT plan for Fast mode; other providers ignore it.
  analysis: { provider: AnalysisProvider; models: Record<AnalysisProvider, string>; reasoningEffort?: ReasoningEffort; fast?: boolean };
  translation: { provider: TranslationProvider; models: Record<TranslationProvider, string>; reasoningEffort?: ReasoningEffort; fast?: boolean };
}
export const defaultSettings: AISettings = {
  providers: {
    [AiProviders.VercelAIGateway]: { apiKey: "" },
    [AiProviders.OpenAIApi]: { apiKey: "" },
  },
  analysis: {
    provider: AiProviders.VercelAIGateway,
    models: {
      [AiProviders.VercelAIGateway]: DEFAULT_GATEWAY_DECISION_MODEL,
      [AiProviders.OpenAIApi]: DEFAULT_DECISION_MODEL,
      [AiProviders.OpenAISubscription]: "",
    },
  },
  translation: {
    provider: AiProviders.VercelAIGateway,
    models: { [AiProviders.VercelAIGateway]: "", [AiProviders.OpenAIApi]: "", [AiProviders.OpenAISubscription]: "" },
  },
};
// Version 1 had one provider (TypeSafe or Vercel) shared by analysis and translation.
const enum LegacyProviders { TypeSafe = "TypeSafe" }
interface V1Settings {
  provider?: string;
  providers?: Partial<Record<string, { apiKey?: string; model?: string }>>;
}
/** Version 2 split analysis (Jev via TypeSafe or Vercel) from translation. */
export interface V2Settings {
  providers: Record<string, { apiKey: string }>;
  analysis: { provider: string; models: Record<string, string> };
  translation: AISettings["translation"];
}
export function migrateSettings(old: V1Settings | null): V2Settings {
  const keys = (provider: string) => ({ apiKey: old?.providers?.[provider]?.apiKey ?? "" });
  const gatewayModel = old?.providers?.VercelAIGateway?.model ?? "";
  const jevModel = gatewayModel.startsWith("typesafe-ai/");
  return {
    providers: { [AiProviders.VercelAIGateway]: keys(AiProviders.VercelAIGateway), [LegacyProviders.TypeSafe]: keys(LegacyProviders.TypeSafe), [AiProviders.OpenAIApi]: { apiKey: "" } },
    analysis: {
      provider: old?.provider === LegacyProviders.TypeSafe ? LegacyProviders.TypeSafe : AiProviders.VercelAIGateway,
      models: { [AiProviders.VercelAIGateway]: jevModel ? gatewayModel : "typesafe-ai/jev", [LegacyProviders.TypeSafe]: old?.providers?.TypeSafe?.model || "jev-latest" },
    },
    translation: { ...structuredClone(defaultSettings.translation), models: { ...defaultSettings.translation.models, [AiProviders.VercelAIGateway]: jevModel ? "" : gatewayModel } },
  };
}
/**
 * Version 3 replaces Jev with OpenAI for analysis. Jev settings are dropped; analysis
 * follows the ChatGPT sign-in when translation already uses it, otherwise the OpenAI key.
 */
export function migrateToOpenAIAnalysis(old: V2Settings): AISettings {
  const next = structuredClone(defaultSettings);
  next.analysis.provider = AiProviders.OpenAIApi;
  for (const provider of [AiProviders.VercelAIGateway, AiProviders.OpenAIApi] as const) {
    next.providers[provider].apiKey = old.providers?.[provider]?.apiKey ?? "";
  }
  next.translation = { ...next.translation, ...old.translation, models: { ...next.translation.models, ...old.translation?.models } };
  if (next.translation.provider === AiProviders.OpenAISubscription) {
    next.analysis.provider = AiProviders.OpenAISubscription;
    next.analysis.models.OpenAISubscription = next.translation.models.OpenAISubscription;
  }
  return next;
}
/**
 * Version 4 adds the Vercel AI Gateway for analysis while OpenAI's Decisions API is
 * unavailable. Analysis left on an OpenAI API key that was never filled in moves to the gateway.
 */
export function migrateToGatewayAnalysis(old: AISettings): AISettings {
  const next = structuredClone(old);
  next.analysis.models = { ...defaultSettings.analysis.models, ...old.analysis.models };
  if (next.analysis.provider === AiProviders.OpenAIApi && !next.providers[AiProviders.OpenAIApi].apiKey.trim()) {
    next.analysis.provider = AiProviders.VercelAIGateway;
  }
  return next;
}
