import { Schema, type Tracer } from "effect";
import { storage } from "wxt/utils/storage";
import { aiSettings } from "../modules/settings";
import { analyzePageContent } from "../modules/content-analyzer/page-analysis";
import { decideTranslationPlan, PageContext } from "../modules/content-analyzer/page-plan";
import { missingConfiguration, modelAttributes, translateBatch } from "../modules/translator/translate-batch";
import {
  chatgptCredentials, handleChatGPTNavigation, handleChatGPTTabClosed, listChatGPTModels, signOutChatGPT, startChatGPTSignIn,
} from "../modules/ai/chatgpt-session";

import { ANALYSIS_BATCH_SIZE } from "../modules/content-analyzer/protocol";
import { createContextCarryover } from "../modules/translation-context/carryover";
import type { TranslationContext } from "../modules/translation-context";
import {
  debugLog, describeError, localTracer, markFailed, pageOf, traceRequest as traceRequestWith, traceStore, type RunInSpan,
} from "../modules/debug-log";
import { listOpenAIModels } from "../modules/ai/openai-models";
import { listGatewayModels } from "../modules/ai/gateway-models";
import { AiProviders } from "../modules/ai/providers";

const translationContexts = storage.defineItem<Record<string, TranslationContext>>("local:translationContexts", { fallback: {} });
const Blocks = Schema.Array(Schema.Struct({ text: Schema.String, tag: Schema.String }));
const PageLog = Schema.Struct({
  level: Schema.Literals(["info", "warn", "error"]),
  event: Schema.String.check(Schema.isMaxLength(200)),
  detail: Schema.optional(Schema.String),
});
const purposeNames = { analysis: "内容分析", translation: "翻译" } as const;

// Translation requests are traced as OpenTelemetry spans kept locally (see debug-log/trace.ts).
const traceRequest = <A>(name: string, attributes: Record<string, unknown>, body: (span: Tracer.Span, run: RunInSpan) => Promise<A>) =>
  traceRequestWith(localTracer, name, attributes, body);

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
    if (message?.type === "traces-clear") return traceStore.clear().then(() => ({ status: "ok" }));
    if (message?.type === "chatgpt-sign-in") return startChatGPTSignIn();
    if (message?.type === "chatgpt-sign-out") return signOutChatGPT().then(() => ({ status: "ok" }));
    if (message?.type === "chatgpt-models") {
      return listChatGPTModels().then((models) => {
        if (!models.length) void debugLog.warn("ChatGPT 模型列表为空", { detail: "接口没有返回 visibility 为 list 的模型" });
        return { status: "ok", models };
      }, (error) => {
        void debugLog.error("读取 ChatGPT 模型列表失败", { detail: describeError(error) });
        return { status: "failed" };
      });
    }
    if (message?.type === "openai-models") {
      // The options page sends the key being edited, so the list follows it before it's saved.
      return (async () => {
        try {
          const apiKey = typeof message.apiKey === "string" && message.apiKey.trim()
            ? message.apiKey.trim()
            : (await aiSettings.getValue()).providers[AiProviders.OpenAIApi].apiKey.trim();
          if (!apiKey) return { status: "no-key" };
          const models = await listOpenAIModels(apiKey);
          if (!models.length) void debugLog.warn("OpenAI 模型列表为空", { detail: "接口没有返回可生成文本的模型" });
          return { status: "ok", models };
        } catch (error) {
          void debugLog.error("读取 OpenAI 模型列表失败", { detail: describeError(error) });
          return { status: "failed" };
        }
      })();
    }
    if (message?.type === "gateway-models") {
      return listGatewayModels().then((models) => {
        if (!models.length) void debugLog.warn("Vercel AI Gateway 模型列表为空");
        return { status: "ok", models };
      }, (error) => {
        void debugLog.error("读取 Vercel AI Gateway 模型列表失败", { detail: describeError(error) });
        return { status: "failed" };
      });
    }
    if (message?.type === "prepare-translation") {
      return traceRequest("prepare-translation", { "obt.page": page }, async (span, run) => {
        try {
          const context = Schema.decodeUnknownSync(PageContext)(message.context);
          span.attribute("obt.sample.chars", context.sample.length);
          if (context.sample.length > 12000 || context.title.length > 1000 || context.pagination.length > 20) {
            markFailed(span, `页面信息超出长度限制：sample ${context.sample.length}，title ${context.title.length}，pagination ${context.pagination.length}`);
            return { status: "failed" };
          }
          const settings = await aiSettings.getValue();
          const chatgpt = await chatgptCredentials();
          for (const [key, value] of Object.entries(modelAttributes(settings, "analysis"))) span.attribute(key, value);
          const missing = missingConfiguration(settings, chatgpt);
          if (missing) {
            markFailed(span, `${purposeNames[missing]}未配置`);
            return { status: "not-configured", purpose: missing };
          }
          void contexts.notePage(pageUrl(sender), context.title);
          const plan = await run(decideTranslationPlan(context, settings, chatgpt));
          span.attribute("obt.plan.mode", plan.mode);
          span.attribute("obt.plan.navigation", plan.navigation);
          span.attribute("obt.plan.fallback", plan.fallback);
          return { status: "ok", plan };
        } catch (error) {
          markFailed(span, "准备翻译时出现异常", error);
          return { status: "failed" };
        }
      });
    }
    if (message?.type === "analyze-content" || message?.type === "translate-content") {
      return traceRequest(message.type, { "obt.page": page }, async (span, run) => {
        try {
          const blocks = Schema.decodeUnknownSync(Blocks)(message.blocks);
          const length = blocks.reduce((sum, block) => sum + block.text.length, 0);
          span.attribute("obt.blocks", blocks.length);
          span.attribute("obt.chars", length);
          if (blocks.length > ANALYSIS_BATCH_SIZE || length > 200_000) {
            markFailed(span, `请求超出限制：${blocks.length} 段，${length} 字符`);
            return { status: "failed" };
          }
          const settings = await aiSettings.getValue();
          const chatgpt = chatgptCredentials();
          if (message.type === "translate-content") {
            const mode = message.mode === "main" ? "main" : "all";
            span.attribute("obt.mode", mode);
            const result = await contexts.translate(pageUrl(sender), blocks, async (context) =>
              run(translateBatch(blocks, mode, settings, await chatgpt, context)));
            if (result.status === "ok") {
              span.attribute("obt.translated", result.translations.filter((text) => text !== null).length);
              span.attribute("obt.terms", result.terms.length);
              span.attribute("obt.analysis.fallback", result.analysisFallbackCount);
            } else if (result.status === "not-configured") {
              markFailed(span, `${purposeNames[result.purpose]}未配置`);
            } else {
              markFailed(span, "翻译批次失败", result.error);
            }
            return result;
          }
          const result = await run(analyzePageContent(blocks, settings, await chatgpt));
          if (result.status === "failed") markFailed(span, "内容分析失败", result.error);
          return result;
        } catch (error) {
          markFailed(span, "处理请求时出现异常", error);
          return { status: "failed" };
        }
      });
    }
  });
});
