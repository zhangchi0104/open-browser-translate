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

/** Kinds of connection that take an API key; several of each can be added and named. */
export type ConnectionKind = AiProviders.VercelAIGateway | AiProviders.OpenAIApi | AiProviders.Custom;
export const CONNECTION_KINDS = [AiProviders.VercelAIGateway, AiProviders.OpenAIApi, AiProviders.Custom] as const satisfies readonly ConnectionKind[];
/** What runs a purpose's model: a kind of connection, or the ChatGPT plan. */
export type SettingsProvider = ConnectionKind | AiProviders.OpenAISubscription;
/** The ChatGPT sign-in is one per browser, so it is a connection with a fixed id rather than a listed one. */
export const CHATGPT_CONNECTION = AiProviders.OpenAISubscription;

/** A named way to reach models, added in the settings. */
export interface Connection {
  id: string;
  kind: ConnectionKind;
  name: string;
  /** May be empty for a custom connection to a server that needs no key. */
  apiKey: string;
  /** Base URL of an OpenAI-compatible API, such as https://openrouter.ai/api/v1; custom connections only. */
  apiUrl?: string;
}
export const CONNECTION_KIND_NAMES: Record<ConnectionKind, string> = {
  [AiProviders.VercelAIGateway]: "Vercel AI Gateway",
  [AiProviders.OpenAIApi]: "OpenAI",
  [AiProviders.Custom]: "自定义",
};

export function validateModel(provider: SettingsProvider, model: string): string | undefined {
  const value = model.trim();
  if (!value) return;
  if (provider === AiProviders.VercelAIGateway && !/^[^\s/]+\/[^\s/]+$/.test(value)) {
    return "请填写 provider/model 格式的模型 ID";
  }
  if (/\s/.test(value)) return "模型 ID 不能包含空格";
}
/** A custom connection's base URL must be an http or https URL. */
export function validateApiUrl(url: string): string | undefined {
  const value = url.trim();
  if (!value) return "请填写接口地址";
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return;
  } catch {}
  return "请填写以 https:// 或 http:// 开头的地址";
}
/** OpenAI reasoning effort levels; unset leaves the choice to the model. */
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];

export interface PurposeSettings {
  /** Id of one of `connections`, or `CHATGPT_CONNECTION`. */
  connection: string;
  /** The model last chosen on each connection, by connection id. */
  models: Record<string, string>;
  // `reasoningEffort` applies to OpenAI-style models; the gateway's evaluation models don't reason.
  // `fast` asks the ChatGPT plan for Fast mode; other providers ignore it.
  reasoningEffort?: ReasoningEffort;
  fast?: boolean;
}
export interface AISettings {
  connections: Connection[];
  analysis: PurposeSettings;
  translation: PurposeSettings;
}

// The built-in connections keep the provider names they had before connections could be added,
// so purposes and remembered models carried over from version 4 still point at them.
export const defaultSettings: AISettings = {
  connections: [
    { id: AiProviders.VercelAIGateway, kind: AiProviders.VercelAIGateway, name: CONNECTION_KIND_NAMES[AiProviders.VercelAIGateway], apiKey: "" },
    { id: AiProviders.OpenAIApi, kind: AiProviders.OpenAIApi, name: CONNECTION_KIND_NAMES[AiProviders.OpenAIApi], apiKey: "" },
  ],
  analysis: {
    connection: AiProviders.VercelAIGateway,
    models: { [AiProviders.VercelAIGateway]: DEFAULT_GATEWAY_DECISION_MODEL, [AiProviders.OpenAIApi]: DEFAULT_DECISION_MODEL },
  },
  translation: { connection: AiProviders.VercelAIGateway, models: {} },
};

export function findConnection(settings: AISettings, id: string): Connection | undefined {
  return settings.connections.find((connection) => connection.id === id);
}
/** What runs the model behind connection `id`; undefined once that connection is removed. */
export function providerOf(settings: AISettings, id: string): SettingsProvider | undefined {
  return id === CHATGPT_CONNECTION ? AiProviders.OpenAISubscription : findConnection(settings, id)?.kind;
}
/** The model a purpose starts with on a connection it hasn't used yet. */
export function defaultModel(purpose: "analysis" | "translation", provider: SettingsProvider | undefined): string {
  if (purpose !== "analysis") return "";
  return provider === AiProviders.VercelAIGateway ? DEFAULT_GATEWAY_DECISION_MODEL
    : provider === AiProviders.OpenAIApi ? DEFAULT_DECISION_MODEL : "";
}

// —— Migrations ——

type V4Provider = AiProviders.VercelAIGateway | AiProviders.OpenAIApi | AiProviders.OpenAISubscription;
type V4KeyProvider = Exclude<V4Provider, AiProviders.OpenAISubscription>;
/** Versions 3 and 4: one key per provider, and each purpose picks a provider. */
export interface V4Settings {
  providers: Record<V4KeyProvider, { apiKey: string }>;
  analysis: { provider: V4Provider; models: Record<V4Provider, string>; reasoningEffort?: ReasoningEffort; fast?: boolean };
  translation: { provider: V4Provider; models: Record<V4Provider, string>; reasoningEffort?: ReasoningEffort; fast?: boolean };
}
const v4Defaults: V4Settings = {
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
  translation: V4Settings["translation"];
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
    translation: { ...structuredClone(v4Defaults.translation), models: { ...v4Defaults.translation.models, [AiProviders.VercelAIGateway]: jevModel ? "" : gatewayModel } },
  };
}
/**
 * Version 3 replaces Jev with OpenAI for analysis. Jev settings are dropped; analysis
 * follows the ChatGPT sign-in when translation already uses it, otherwise the OpenAI key.
 */
export function migrateToOpenAIAnalysis(old: V2Settings): V4Settings {
  const next = structuredClone(v4Defaults);
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
export function migrateToGatewayAnalysis(old: V4Settings): V4Settings {
  const next = structuredClone(old);
  next.analysis.models = { ...v4Defaults.analysis.models, ...old.analysis.models };
  if (next.analysis.provider === AiProviders.OpenAIApi && !next.providers[AiProviders.OpenAIApi].apiKey.trim()) {
    next.analysis.provider = AiProviders.VercelAIGateway;
  }
  return next;
}
/**
 * Version 5 turns the one key per provider into a list of named connections. Each key becomes a
 * connection whose id is its provider's name, so purposes and their remembered models carry over.
 */
export function migrateToConnections(old: V4Settings): AISettings {
  const purpose = ({ provider, models, reasoningEffort, fast }: V4Settings["analysis"]): PurposeSettings => ({
    connection: provider,
    models: Object.fromEntries(Object.entries(models ?? {}).filter(([, model]) => model)),
    ...(reasoningEffort && { reasoningEffort }),
    ...(fast && { fast }),
  });
  return {
    connections: ([AiProviders.VercelAIGateway, AiProviders.OpenAIApi] as const).map((kind) => ({
      id: kind, kind, name: CONNECTION_KIND_NAMES[kind], apiKey: old.providers?.[kind]?.apiKey ?? "",
    })),
    analysis: purpose(old.analysis),
    translation: purpose(old.translation),
  };
}
