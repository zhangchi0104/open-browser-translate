import { Effect, Schema } from "effect";
import { storage } from "wxt/utils/storage";
import { aiSettings, type AISettings } from "../modules/settings";
import { analyzePageContent } from "../modules/content-analyzer/page-analysis";
import { decideTranslationPlan, PageContext } from "../modules/content-analyzer/page-plan";
import { missingConfiguration, translateBatch } from "../modules/translator/translate-batch";
import {
  chatgptCredentials, handleChatGPTNavigation, handleChatGPTTabClosed, listChatGPTModels, signOutChatGPT, startChatGPTSignIn,
} from "../modules/ai/chatgpt-session";

import { ANALYSIS_BATCH_SIZE } from "../modules/content-analyzer/protocol";
import { createContextCarryover } from "../modules/translation-context/carryover";
import type { TranslationContext } from "../modules/translation-context";
import { debugLog, describeError, pageOf } from "../modules/debug-log";

const translationContexts = storage.defineItem<Record<string, TranslationContext>>("local:translationContexts", { fallback: {} });
const Blocks = Schema.Array(Schema.Struct({ text: Schema.String, tag: Schema.String }));
const PageLog = Schema.Struct({
  level: Schema.Literals(["info", "warn", "error"]),
  event: Schema.String.check(Schema.isMaxLength(200)),
  detail: Schema.optional(Schema.String),
});
const purposeNames = { analysis: "内容分析", translation: "翻译" } as const;
const modelOf = (settings: AISettings, purpose: "analysis" | "translation") => {
  const { provider, models } = settings[purpose];
  return `${provider} / ${(models as Record<string, string | undefined>)[provider] || "（未填写）"}`;
};
const since = (start: number) => `${Date.now() - start} ms`;
const withError = (text: string, error?: string) => error ? `${text}\n${error}` : text;

export default defineBackground(() => {
  const contexts = createContextCarryover({
    get: () => translationContexts.getValue(),
    set: (value) => translationContexts.setValue(value),
  });
  // The sender's URL, not anything in the message, decides which site's context is used.
  // Private windows keep no context, so nothing about them is written to disk.
  const pageUrl = (sender: { url?: string; tab?: { url?: string; incognito?: boolean } }) =>
    sender.tab?.incognito ? undefined : sender.tab?.url ?? sender.url;
  browser.tabs.onUpdated.addListener((tabId, change) => { void handleChatGPTNavigation(tabId, change.url); });
  browser.tabs.onRemoved.addListener((tabId) => { void handleChatGPTTabClosed(tabId); });
  browser.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== browser.runtime.id) return;
    const page = pageOf(pageUrl(sender));
    if (message?.type === "open-settings") {
      return browser.runtime.openOptionsPage().then(() => ({ opened: true }));
    }
    if (message?.type === "debug-log") {
      try {
        const entry = Schema.decodeUnknownSync(PageLog)(message.entry);
        void debugLog.write(entry.level, entry.event, { detail: entry.detail, page, source: "page" });
      } catch {}
      return;
    }
    if (message?.type === "debug-log-clear") return debugLog.clear().then(() => ({ status: "ok" }));
    if (message?.type === "chatgpt-sign-in") return startChatGPTSignIn();
    if (message?.type === "chatgpt-sign-out") return signOutChatGPT().then(() => ({ status: "ok" }));
    if (message?.type === "chatgpt-models") {
      return listChatGPTModels().then((models) => ({ status: "ok", models }), (error) => {
        void debugLog.error("读取 ChatGPT 模型列表失败", { detail: describeError(error) });
        return { status: "failed" };
      });
    }
    if (message?.type === "prepare-translation") {
      return (async () => {
        const start = Date.now();
        try {
          const context = Schema.decodeUnknownSync(PageContext)(message.context);
          if (context.sample.length > 12000 || context.title.length > 1000 || context.pagination.length > 20) {
            void debugLog.error("准备翻译：页面信息超出长度限制", {
              page, detail: `sample ${context.sample.length}，title ${context.title.length}，pagination ${context.pagination.length}`,
            });
            return { status: "failed" };
          }
          const settings = await aiSettings.getValue();
          const chatgpt = await chatgptCredentials();
          const missing = missingConfiguration(settings, chatgpt);
          if (missing) {
            void debugLog.warn(`准备翻译：${purposeNames[missing]}未配置`, {
              page, detail: `分析：${modelOf(settings, "analysis")}\n翻译：${modelOf(settings, "translation")}\nChatGPT 已登录：${chatgpt ? "是" : "否"}`,
            });
            return { status: "not-configured", purpose: missing };
          }
          void contexts.notePage(pageUrl(sender), context.title);
          const plan = await Effect.runPromise(decideTranslationPlan(context, settings, chatgpt));
          const summary = `模式 ${plan.mode}，导航 ${plan.navigation}，耗时 ${since(start)}\n分析：${modelOf(settings, "analysis")}`;
          if (plan.error) void debugLog.warn("准备翻译：页面规划失败，按普通网页翻译", { page, detail: withError(summary, plan.error) });
          else void debugLog.info(plan.fallback ? "准备翻译：规划置信度不足，按普通网页翻译" : "准备翻译：完成", { page, detail: summary });
          return { status: "ok", plan };
        } catch (error) {
          void debugLog.error("准备翻译：异常", { page, detail: withError(`耗时 ${since(start)}`, describeError(error)) });
          return { status: "failed" };
        }
      })();
    }
    if (message?.type === "analyze-content" || message?.type === "translate-content") {
      return (async () => {
        const start = Date.now();
        const label = message.type === "translate-content" ? "翻译批次" : "内容分析";
        try {
          const blocks = Schema.decodeUnknownSync(Blocks)(message.blocks);
          const length = blocks.reduce((sum, block) => sum + block.text.length, 0);
          if (blocks.length > ANALYSIS_BATCH_SIZE || length > 200_000) {
            void debugLog.error(`${label}：请求超出限制`, { page, detail: `${blocks.length} 段，${length} 字符` });
            return { status: "failed" };
          }
          const settings = await aiSettings.getValue();
          const chatgpt = chatgptCredentials();
          if (message.type === "translate-content") {
            const mode = message.mode === "main" ? "main" : "all";
            const result = await contexts.translate(pageUrl(sender), blocks, async (context) =>
              Effect.runPromise(translateBatch(blocks, mode, settings, await chatgpt, context)));
            const summary = `${blocks.length} 段 / ${length} 字符，模式 ${mode}，耗时 ${since(start)}\n`
              + `分析：${modelOf(settings, "analysis")}\n翻译：${modelOf(settings, "translation")}`;
            if (result.status === "ok") {
              const shown = result.translations.filter((text) => text !== null).length;
              const detail = `${summary}\n译出 ${shown} 段，术语 ${result.terms.length} 条，分析回退 ${result.analysisFallbackCount} 段`;
              if (result.analysisError) void debugLog.warn(`${label}：完成，但内容分析失败`, { page, detail: withError(detail, result.analysisError) });
              else void debugLog.info(`${label}：完成`, { page, detail });
            } else if (result.status === "not-configured") {
              void debugLog.warn(`${label}：${purposeNames[result.purpose]}未配置`, { page, detail: summary });
            } else {
              void debugLog.error(`${label}：失败`, { page, detail: withError(summary, result.error) });
            }
            return result;
          }
          const result = await Effect.runPromise(analyzePageContent(blocks, settings, await chatgpt));
          if (result.status === "failed") void debugLog.error(`${label}：失败`, { page, detail: withError(`耗时 ${since(start)}`, result.error) });
          return result;
        } catch (error) {
          void debugLog.error(`${label}：异常`, { page, detail: withError(`耗时 ${since(start)}`, describeError(error)) });
          return { status: "failed" };
        }
      })();
    }
  });
});
