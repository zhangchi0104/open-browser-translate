import { Effect, Layer, ManagedRuntime, Schema, type Tracer } from "effect";
import { storage } from "wxt/utils/storage";
import { aiSettings, Settings, SettingsLive, type AISettings } from "../modules/settings";
import { analyzePageContent } from "../modules/content-analyzer/page-analysis";
import { decideTranslationPlan, PageContext } from "../modules/content-analyzer/page-plan";
import { modelAttributes, TARGET_LANGUAGE, translateBatch } from "../modules/translator/translate-batch";
import { configuredSettings, modelConfig, ModelsLive } from "../modules/ai/models";
import { ChatGPTToken } from "../modules/ai/chatgpt";
import { createTranslationCache, translateWithCache } from "../modules/translation-cache";
import { createIndexedDbCacheStore } from "../modules/translation-cache/indexeddb";
import {
  ChatGPTTokenLive, handleChatGPTNavigation, handleChatGPTTabClosed, listChatGPTModels, signOutChatGPT, startChatGPTSignIn,
} from "../modules/ai/chatgpt-session";

import { ANALYSIS_BATCH_SIZE } from "../modules/content-analyzer/protocol";
import { createContextCarryover } from "../modules/translation-context/carryover";
import type { TranslationContext } from "../modules/translation-context";
import {
  debugLog, describeError, localTracer, markFailed, pageOf, traceRequest as traceRequestOn, traceStore, tracingLayer, type RunInSpan,
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
const translationCache = createTranslationCache(createIndexedDbCacheStore());
const originOf = (url: string | undefined) => {
  try {
    const origin = url ? new URL(url).origin : undefined;
    return origin === "null" ? undefined : origin;
  } catch { return undefined; }
};

// Every request runs on one runtime, so built model layers (and their HTTP clients) are shared
// across requests. Settings and the ChatGPT sign-in are read when a request starts.
const BackgroundLive = Layer.mergeAll(ModelsLive, tracingLayer(localTracer)).pipe(
  Layer.provideMerge(Layer.mergeAll(SettingsLive, ChatGPTTokenLive)),
);
const runtime = ManagedRuntime.make(BackgroundLive);
type Run = RunInSpan<ManagedRuntime.ManagedRuntime.Services<typeof runtime>>;

// Translation requests are traced as OpenTelemetry spans kept locally (see debug-log/trace.ts).
// A request reads the settings and sign-in once, so its steps (model choice, cache scope, span
// attributes) all see the same ones even if the options page saves mid-request.
const traceRequest = <A>(
  name: string,
  attributes: Record<string, unknown>,
  body: (span: Tracer.Span, run: Run, settings: AISettings) => Promise<A>,
) => traceRequestOn(runtime.runPromise, name, attributes, async (span, run) => {
  const [settings, token] = await run(Effect.all([
    Settings.use((settings) => settings.get),
    ChatGPTToken.use((token) => Effect.map(token.signedIn, (signedIn) => ({ ...token, signedIn: Effect.succeed(signedIn) }))),
  ], { concurrency: 2 }));
  const snapshot: Run = (effect) => run(effect.pipe(
    Effect.provideService(Settings, { get: Effect.succeed(settings) }),
    Effect.provideService(ChatGPTToken, token),
  ));
  return body(span, snapshot, settings);
});

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
    if (message?.type === "cache-stats") return translationCache.count().then((count) => ({ status: "ok", count }), () => ({ status: "failed" }));
    if (message?.type === "cache-clear") return translationCache.clear().then(() => ({ status: "ok" }), () => ({ status: "failed" }));
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
      return traceRequest("prepare-translation", { "obt.page": page }, async (span, run, settings) => {
        try {
          const context = Schema.decodeUnknownSync(PageContext)(message.context);
          span.attribute("obt.sample.chars", context.sample.length);
          if (context.sample.length > 12000 || context.title.length > 1000 || context.pagination.length > 20) {
            markFailed(span, `页面信息超出长度限制：sample ${context.sample.length}，title ${context.title.length}，pagination ${context.pagination.length}`);
            return { status: "failed" };
          }
          return await run(Effect.gen(function* () {
            for (const [key, value] of Object.entries(modelAttributes(settings, "analysis"))) span.attribute(key, value);
            yield* configuredSettings();
            void contexts.notePage(pageUrl(sender), context.title);
            const plan = yield* decideTranslationPlan(context);
            span.attribute("obt.plan.mode", plan.mode);
            span.attribute("obt.plan.navigation", plan.navigation);
            span.attribute("obt.plan.fallback", plan.fallback);
            return { status: "ok", plan } as const;
          }).pipe(Effect.catchTag("ModelNotConfigured", ({ purpose }) => {
            markFailed(span, `${purposeNames[purpose]}未配置`);
            return Effect.succeed({ status: "not-configured", purpose } as const);
          })));
        } catch (error) {
          markFailed(span, "准备翻译时出现异常", error);
          return { status: "failed" };
        }
      });
    }
    if (message?.type === "analyze-content" || message?.type === "translate-content") return handleBatch(message, sender);
  });

  // Streaming translation: the page opens a port, sends one batch, and receives each
  // block's translation as it grows ({ type: "partial" }) before the final result.
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== "translate-stream" || port.sender?.id !== browser.runtime.id) return;
    let open = true;
    port.onDisconnect.addListener(() => { open = false; });
    port.onMessage.addListener((message: { blocks?: unknown; mode?: unknown }) => {
      const post = (value: unknown) => { if (open) port.postMessage(value); };
      // Cached translations are final; streamed ones are still being written.
      void handleBatch({ ...message, type: "translate-content" }, port.sender!, (index, text, final) => post({ type: final ? "cached" : "partial", index, text }))
        .then((result) => post({ type: "result", result }));
    });
  });

  function handleBatch(
    message: { type: "analyze-content" | "translate-content"; blocks?: unknown; mode?: unknown; analyzed?: unknown },
    sender: Parameters<typeof pageUrl>[0],
    onPartial?: (index: number, text: string, final?: boolean) => void,
  ) {
    const page = pageOf(pageUrl(sender));
    return traceRequest(message.type, { "obt.page": page, ...(onPartial && { "obt.streaming": true }) }, async (span, run, settings) => {
      try {
        const blocks = Schema.decodeUnknownSync(Blocks)(message.blocks);
        const length = blocks.reduce((sum, block) => sum + block.text.length, 0);
        span.attribute("obt.blocks", blocks.length);
        span.attribute("obt.chars", length);
        if (blocks.length > ANALYSIS_BATCH_SIZE || length > 200_000) {
          markFailed(span, `请求超出限制：${blocks.length} 段，${length} 字符`);
          return { status: "failed" };
        }
        const mode = message.mode === "main" ? "main" : "all";
        span.attribute("obt.mode", mode);
        if (message.type === "translate-content") {
          // The page analyzes blocks ahead of translation (to order them by priority) and sends
          // only blocks to translate; older callers still get analysis here.
          const analyzed = message.analyzed === true;
          span.attribute("obt.analyzed", analyzed);
          // Cached blocks are served from IndexedDB; only the rest reach the model and the site
          // context. Private windows have no page URL here, so they bypass the cache.
          const url = pageUrl(sender);
          const origin = originOf(url);
          const { provider, model } = modelConfig(settings, "translation");
          const result = await translateWithCache({
            cache: translationCache,
            scope: origin
              ? { origin, target: TARGET_LANGUAGE, provider, model, mode }
              : undefined,
            blocks,
            onCached: onPartial && ((index, text) => onPartial(index, text, true)),
            translate: (misses, indexes) => contexts.translate(url, misses, async (context) =>
              run(translateBatch(misses, mode, { context, analyzed, onPartial: onPartial && ((index, text) => onPartial(indexes[index]!, text)) }))),
          });
          span.attribute("obt.cache.hits", result.cacheHits ?? 0);
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
        const result = await run(analyzePageContent(blocks, mode));
        if (result.status === "failed") markFailed(span, "内容分析失败", result.error);
        return result;
      } catch (error) {
        markFailed(span, "处理请求时出现异常", error);
        return { status: "failed" };
      }
    });
  }
});
