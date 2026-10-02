import { Effect, Schema } from "effect";
import { storage } from "wxt/utils/storage";
import { aiSettings } from "../modules/settings";
import { analyzePageContent } from "../modules/content-analyzer/page-analysis";
import { decideTranslationPlan, PageContext } from "../modules/content-analyzer/page-plan";
import { missingConfiguration, translateBatch } from "../modules/translator/translate-batch";

import { ANALYSIS_BATCH_SIZE } from "../modules/content-analyzer/protocol";
import { createContextCarryover } from "../modules/translation-context/carryover";

const Blocks = Schema.Array(Schema.Struct({ text: Schema.String, tag: Schema.String }));

export default defineBackground(() => {
  const contexts = createContextCarryover({
    get: () => storage.getItem("local:translationContexts"),
    set: (value) => storage.setItem("local:translationContexts", value),
  });
  // The sender's URL, not anything in the message, decides which site's context is used.
  // Private windows keep no context, so nothing about them is written to disk.
  const pageUrl = (sender: { url?: string; tab?: { url?: string; incognito?: boolean } }) =>
    sender.tab?.incognito ? undefined : sender.tab?.url ?? sender.url;
  browser.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== browser.runtime.id) return;
    if (message?.type === "open-settings") {
      return browser.runtime.openOptionsPage().then(() => ({ opened: true }));
    }
    if (message?.type === "prepare-translation") {
      return (async () => {
        try {
          const context = Schema.decodeUnknownSync(PageContext)(message.context);
          if (context.sample.length > 12000 || context.title.length > 1000 || context.pagination.length > 20) return { status: "failed" };
          const settings = await aiSettings.getValue();
          const missing = missingConfiguration(settings);
          if (missing) return { status: "not-configured", purpose: missing };
          await contexts.notePage(pageUrl(sender), context.title);
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
            const url = pageUrl(sender);
            const context = await contexts.contextFor(url, blocks.map(({ text }) => text));
            const result = await Effect.runPromise(translateBatch(blocks, message.mode === "main" ? "main" : "all", settings, context));
            await contexts.record(url, blocks, result);
            return result;
          }
          return await Effect.runPromise(analyzePageContent(blocks, settings));
        } catch {
          return { status: "failed" };
        }
      })();
    }
  });
});
