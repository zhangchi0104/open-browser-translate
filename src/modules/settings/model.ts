import { AiProviders, DEFAULT_DECISION_MODEL } from "../ai/providers";

export type AnalysisProvider = AiProviders.OpenAIApi | AiProviders.OpenAISubscription;
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
export interface AISettings {
  providers: Record<KeyProvider, { apiKey: string }>;
  analysis: { provider: AnalysisProvider; models: Record<AnalysisProvider, string> };
  translation: { provider: TranslationProvider; models: Record<TranslationProvider, string> };
}
export const defaultSettings: AISettings = {
  providers: {
    [AiProviders.VercelAIGateway]: { apiKey: "" },
    [AiProviders.OpenAIApi]: { apiKey: "" },
  },
  analysis: {
    provider: AiProviders.OpenAIApi,
    models: { [AiProviders.OpenAIApi]: DEFAULT_DECISION_MODEL, [AiProviders.OpenAISubscription]: "" },
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
