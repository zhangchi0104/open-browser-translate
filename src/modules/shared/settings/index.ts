import { Effect, Layer } from "effect";
import { storage } from "wxt/utils/storage";
import { defaultSettings, migrateSettings, migrateToConnections, migrateToGatewayAnalysis, migrateToOpenAIAnalysis, type AISettings } from "./model";
import { Settings } from "./service";

export * from "./model";
export * from "./service";
export const aiSettings = storage.defineItem<AISettings>("local:aiSettings", {
  fallback: defaultSettings,
  version: 5,
  migrations: { 2: migrateSettings, 3: migrateToOpenAIAnalysis, 4: migrateToGatewayAnalysis, 5: migrateToConnections },
});

/** `Settings` backed by extension storage. */
export const SettingsLive = Layer.succeed(Settings, { get: Effect.promise(() => aiSettings.getValue()) });
