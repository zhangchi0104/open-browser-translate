import { storage } from "wxt/utils/storage";
import { defaultSettings, migrateSettings, type AISettings } from "./model";

export * from "./model";
export const aiSettings = storage.defineItem<AISettings>("local:aiSettings", {
  fallback: defaultSettings,
  version: 2,
  migrations: { 2: migrateSettings },
});
