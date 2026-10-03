import { Data, Effect, Layer, LayerMap, Redacted } from "effect";
import type { DecisionModel, LanguageModel } from "effect/unstable/ai";
import { Settings } from "../settings/service";
import type { AISettings, ReasoningEffort, SettingsProvider } from "../settings/model";
import { AiProviders } from "./providers";
import { openAICompatibleLayer, vercelLayer } from "./vercel";
import { OPENAI_API_URL } from "./openai-models";
import { ChatGPTToken, chatgptLayer } from "./chatgpt";
import { chatgptDecisionLayer, openAIDecisionLayer } from "./openai-decisions";
import { vercelDecisionLayer } from "./gateway-decisions";

// Analysis and translation each run on the model the settings select when a request starts.
// Built model layers are cached by everything that picks the model (`ModelConfig`, compared by
// value), so requests share HTTP clients and a settings change applies to the next request.

export type Purpose = "analysis" | "translation";

/** The purpose's provider isn't connected or has no model; no request was sent. */
export class ModelNotConfigured extends Data.TaggedError("ModelNotConfigured")<{ readonly purpose: Purpose }> {}

/** Everything that decides which model a purpose runs on. */
export interface ModelConfig {
  readonly provider: SettingsProvider;
  readonly model: string;
  /** Empty on the ChatGPT plan, which signs in instead. */
  readonly apiKey: Redacted.Redacted<string>;
  readonly reasoningEffort?: ReasoningEffort;
  readonly fast?: boolean;
}

export function modelConfig(settings: AISettings, purpose: Purpose): ModelConfig {
  const { provider, models, reasoningEffort, fast } = settings[purpose];
  return {
    provider,
    model: (models as Record<string, string | undefined>)[provider] ?? "",
    apiKey: Redacted.make(provider === AiProviders.OpenAISubscription ? "" : settings.providers[provider].apiKey),
    ...(reasoningEffort && { reasoningEffort }),
    ...(fast && { fast }),
  };
}

/** The first of `purposes` whose provider isn't connected or has no model. */
export function missingConfiguration(settings: AISettings, signedIn: boolean, purposes: readonly Purpose[] = ["analysis", "translation"]): Purpose | undefined {
  for (const purpose of purposes) {
    const { provider, model, apiKey } = modelConfig(settings, purpose);
    const connected = provider === AiProviders.OpenAISubscription ? signedIn : !!Redacted.value(apiKey).trim();
    if (!connected || !model.trim()) return purpose;
  }
}

function analysisLayer({ provider, model, apiKey, reasoningEffort, fast }: ModelConfig): Layer.Layer<DecisionModel.DecisionModel, never, ChatGPTToken> {
  if (provider === AiProviders.OpenAISubscription) return chatgptDecisionLayer({ model, reasoningEffort, fast });
  if (provider === AiProviders.VercelAIGateway) return vercelDecisionLayer({ model, apiKey });
  return openAIDecisionLayer({ model, apiKey, reasoningEffort });
}

function translationLayer({ provider, model, apiKey, reasoningEffort, fast }: ModelConfig): Layer.Layer<LanguageModel.LanguageModel, never, ChatGPTToken> {
  if (provider === AiProviders.OpenAISubscription) return chatgptLayer({ model, reasoningEffort, fast });
  if (provider === AiProviders.VercelAIGateway) return vercelLayer({ model, apiKey, reasoningEffort });
  return openAICompatibleLayer({ model, apiKey, apiUrl: OPENAI_API_URL, reasoningEffort });
}

const IDLE_TIME_TO_LIVE = "5 minutes";

export class AnalysisModels extends LayerMap.Service<AnalysisModels>()("open-browser-translate/AnalysisModels", {
  lookup: analysisLayer,
  idleTimeToLive: IDLE_TIME_TO_LIVE,
}) {}

export class TranslationModels extends LayerMap.Service<TranslationModels>()("open-browser-translate/TranslationModels", {
  lookup: translationLayer,
  idleTimeToLive: IDLE_TIME_TO_LIVE,
}) {}

/** The current settings; fails with `ModelNotConfigured` for the first of `purposes` that isn't set up. */
export const configuredSettings = (purposes?: readonly Purpose[]) => Effect.gen(function* () {
  const settings = yield* (yield* Settings).get;
  const missing = missingConfiguration(settings, yield* (yield* ChatGPTToken).signedIn, purposes);
  if (missing) return yield* new ModelNotConfigured({ purpose: missing });
  return settings;
});

const configuredModel = (purpose: Purpose) => Effect.map(configuredSettings([purpose]), (settings) => modelConfig(settings, purpose));

/** `DecisionModel` on the analysis model the settings select when it's provided. */
export const AnalysisModel = Layer.unwrap(Effect.map(configuredModel("analysis"), AnalysisModels.get));

/** `LanguageModel` on the translation model the settings select when it's provided. */
export const TranslationModel = Layer.unwrap(Effect.map(configuredModel("translation"), TranslationModels.get));

/** The model caches `AnalysisModel` and `TranslationModel` draw from. */
export const ModelsLive = Layer.mergeAll(AnalysisModels.layer, TranslationModels.layer);

/** Models chosen by fixed `settings`, signed in to ChatGPT with `token` when given; for tests. */
export const modelsFor = (settings: AISettings, token?: string) => ModelsLive.pipe(
  Layer.provideMerge(Layer.mergeAll(Settings.fixed(settings), token ? ChatGPTToken.fixed(token) : ChatGPTToken.signedOut)),
);

/** `AnalysisModel` on fixed `settings`; for tests. */
export const analysisModelFor = (settings: AISettings, token?: string) => AnalysisModel.pipe(Layer.provide(modelsFor(settings, token)));

/** `TranslationModel` on fixed `settings`; for tests. */
export const translationModelFor = (settings: AISettings, token?: string) => TranslationModel.pipe(Layer.provide(modelsFor(settings, token)));
