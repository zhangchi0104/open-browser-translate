import { Effect, Schema } from "effect";
import { aiSettings } from "../modules/settings";
import { analyzePageContent } from "../modules/content-analyzer/page-analysis";
import { decideTranslationPlan, PageContext } from "../modules/content-analyzer/page-plan";
import { missingConfiguration, translateBatch } from "../modules/translator/translate-batch";
import {
  chatgptCredentials, handleChatGPTNavigation, handleChatGPTTabClosed, listChatGPTModels, signOutChatGPT, startChatGPTSignIn,
} from "../modules/ai/chatgpt-session";

import { ANALYSIS_BATCH_SIZE } from "../modules/content-analyzer/protocol";

const Blocks = Schema.Array(Schema.Struct({ text: Schema.String, tag: Schema.String }));

export default defineBackground(() => {
  browser.tabs.onUpdated.addListener((tabId, change) => { void handleChatGPTNavigation(tabId, change.url); });
  browser.tabs.onRemoved.addListener((tabId) => { void handleChatGPTTabClosed(tabId); });
  browser.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== browser.runtime.id) return;
    if (message?.type === "open-settings") {
      return browser.runtime.openOptionsPage().then(() => ({ opened: true }));
    }
    if (message?.type === "chatgpt-sign-in") return startChatGPTSignIn();
    if (message?.type === "chatgpt-sign-out") return signOutChatGPT().then(() => ({ status: "ok" }));
    if (message?.type === "chatgpt-models") {
      return listChatGPTModels().then((models) => ({ status: "ok", models }), () => ({ status: "failed" }));
    }
    if (message?.type === "prepare-translation") {
      return (async () => {
        try {
          const context = Schema.decodeUnknownSync(PageContext)(message.context);
          if (context.sample.length > 12000 || context.title.length > 1000 || context.pagination.length > 20) return { status: "failed" };
          const settings = await aiSettings.getValue();
          const missing = missingConfiguration(settings, await chatgptCredentials());
          if (missing) return { status: "not-configured", purpose: missing };
          return { status: "ok", plan: await Effect.runPromise(decideTranslationPlan(context, settings)) };
        } catch { return { status: "failed" }; }
      })();
    }
    if (message?.type === "analyze-content" || message?.type === "translate-content") {
      return (async () => {
        try {
          const blocks = Schema.decodeUnknownSync(Blocks)(message.blocks);
          if (blocks.length > ANALYSIS_BATCH_SIZE || blocks.reduce((sum, block) => sum + block.text.length, 0) > 200_000) {
            return { status: "failed" };
          }
          const settings = await aiSettings.getValue();
          if (message.type === "translate-content") {
            return await Effect.runPromise(translateBatch(blocks, message.mode === "main" ? "main" : "all", settings, await chatgptCredentials()));
          }
          return await Effect.runPromise(analyzePageContent(blocks, settings));
        } catch {
          return { status: "failed" };
        }
      })();
    }
  });
});
