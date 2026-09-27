import { AiProviders } from "../ai/providers";

export type AnalysisProvider = AiProviders.VercelAIGateway | AiProviders.TypeSafe;
export type TranslationProvider = AiProviders.VercelAIGateway | AiProviders.OpenAIApi;
export type SettingsProvider = AnalysisProvider | TranslationProvider;

export function validateModel(provider: SettingsProvider, model: string): string | undefined {
  const value = model.trim();
  if (!value) return;
  if (provider === AiProviders.VercelAIGateway && !/^[^\s/]+\/[^\s/]+$/.test(value)) {
    return "请填写 provider/model 格式的模型 ID";
  }
  if (/\s/.test(value)) return "模型 ID 不能包含空格";
}
export interface AISettings {
  providers: Record<SettingsProvider, { apiKey: string }>;
  analysis: { provider: AnalysisProvider; models: Record<AnalysisProvider, string> };
  translation: { provider: TranslationProvider; models: Record<TranslationProvider, string> };
}
export const defaultSettings: AISettings = {
  providers: {
    [AiProviders.VercelAIGateway]: { apiKey: "" },
    [AiProviders.TypeSafe]: { apiKey: "" },
    [AiProviders.OpenAIApi]: { apiKey: "" },
  },
  analysis: {
    provider: AiProviders.VercelAIGateway,
    models: { [AiProviders.VercelAIGateway]: "typesafe-ai/jev", [AiProviders.TypeSafe]: "jev-latest" },
  },
  translation: {
    provider: AiProviders.VercelAIGateway,
    models: { [AiProviders.VercelAIGateway]: "", [AiProviders.OpenAIApi]: "" },
  },
};
interface LegacySettings {
  provider?: AnalysisProvider;
  providers?: Partial<Record<AnalysisProvider, { apiKey?: string; model?: string }>>;
}
export function migrateSettings(old: LegacySettings | null): AISettings {
  const next = structuredClone(defaultSettings);
  for (const provider of [AiProviders.VercelAIGateway, AiProviders.TypeSafe] as const) {
    next.providers[provider].apiKey = old?.providers?.[provider]?.apiKey ?? "";
  }
  next.analysis.provider = old?.provider === AiProviders.TypeSafe ? AiProviders.TypeSafe : AiProviders.VercelAIGateway;
  next.analysis.models.TypeSafe = old?.providers?.TypeSafe?.model || "jev-latest";
  const gatewayModel = old?.providers?.VercelAIGateway?.model ?? "";
  if (gatewayModel.startsWith("typesafe-ai/")) {
    next.analysis.models.VercelAIGateway = gatewayModel;
  } else {
    next.translation.models.VercelAIGateway = gatewayModel;
  }
  return next;
}
