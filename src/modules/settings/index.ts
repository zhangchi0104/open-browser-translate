import { storage } from "wxt/utils/storage";
import { defaultSettings, migrateSettings, migrateToOpenAIAnalysis, type AISettings } from "./model";

export * from "./model";
export const aiSettings = storage.defineItem<AISettings>("local:aiSettings", {
  fallback: defaultSettings,
  version: 3,
  migrations: { 2: migrateSettings, 3: migrateToOpenAIAnalysis },
});
