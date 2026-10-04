import { Effect, Layer, ManagedRuntime } from "effect";
import { storage } from "wxt/utils/storage";
import { AiProviders, aiSettings, Settings, SettingsLive, type AISettings } from "../modules/shared/settings";
import { analyzePageContent } from "../modules/background/content-analyzer/page-analysis";
import { decideTranslationPlan } from "../modules/background/content-analyzer/page-plan";
import { configuredSettings, modelAttributes, ModelsLive } from "../modules/background/ai/models";
import { ChatGPTToken } from "../modules/background/ai/chatgpt";
import {
  ChatGPTTokenLive, handleChatGPTNavigation, handleChatGPTTabClosed, listChatGPTModels, signOutChatGPT, startChatGPTSignIn,
} from "../modules/background/ai/chatgpt-session";
import { listOpenAIModels } from "../modules/background/ai/openai-models";
import { listGatewayModels } from "../modules/background/ai/gateway-models";
import { translatePageBatch } from "../modules/background/translation-dispatcher";
import { createTranslationCache } from "../modules/background/cache-store";
import { createIndexedDbCacheStore } from "../modules/background/cache-store/indexeddb";
import { createContextCarryover } from "../modules/background/site-context/carryover";
import { siteOf, type TranslationContext } from "../modules/background/site-context";
import { debugLog, describeError, localTracer, markFailed, pageOf, traceStore, tracingLayer } from "../modules/shared/debug-log";
import { batchChars, createDispatcher, PURPOSE_NAMES, type Block, type ChatGPTModel, type Failed, type ModelList, type Purpose, type Sender } from "../modules/shared/protocol";

const translationContexts = storage.defineItem<Record<string, TranslationContext>>("local:translationContexts", { fallback: {} });
const translationCache = createTranslationCache(createIndexedDbCacheStore());

// Every request runs on one runtime, so built model layers (and their HTTP clients) are shared
// across requests. Settings and the ChatGPT sign-in are read when a request starts.
const BackgroundLive = Layer.mergeAll(ModelsLive, tracingLayer(localTracer)).pipe(
  Layer.provideMerge(Layer.mergeAll(SettingsLive, ChatGPTTokenLive)),
);
const runtime = ManagedRuntime.make(BackgroundLive);
type Services = ManagedRuntime.ManagedRuntime.Services<typeof runtime>;
/** What a traced request can end in; replies may carry more. */
type Outcome = { status: "ok" } | { status: "not-configured"; purpose: Purpose } | { status: "failed"; error?: string };

/**
 * Runs a translation request as a root span, traced locally (see debug-log/trace.ts). The request
 * reads the settings and sign-in once, so its steps (model choice, cache key, span attributes) all
 * see the same ones even if the options page saves mid-request. A not-configured or failed result,
 * or a defect, marks the span failed; `failure` describes a failed result.
 */
const traceRequest = <A extends Outcome, E>(
  name: string,
  sender: Sender,
  attributes: Record<string, unknown>,
  failure: string,
  body: (settings: AISettings) => Effect.Effect<A, E, Services>,
): Promise<A | Failed> => runtime.runPromise(Effect.gen(function* () {
  const span = yield* Effect.orDie(Effect.currentSpan);
  return yield* Effect.gen(function* () {
    const [settings, token] = yield* Effect.all([
      Settings.use((settings) => settings.get),
      ChatGPTToken.use((token) => Effect.map(token.signedIn, (signedIn) => ({ ...token, signedIn: Effect.succeed(signedIn) }))),
    ], { concurrency: 2 });
    const result = yield* body(settings).pipe(
      Effect.provideService(Settings, { get: Effect.succeed(settings) }),
      Effect.provideService(ChatGPTToken, token),
    );
    const outcome: Outcome = result;
    if (outcome.status === "not-configured") markFailed(span, `${PURPOSE_NAMES[outcome.purpose]}未配置`);
    else if (outcome.status === "failed") markFailed(span, failure, outcome.error);
    return result;
  }).pipe(Effect.catchCause((cause) => {
    markFailed(span, "处理请求时出现异常", cause);
    return Effect.succeed<Failed>({ status: "failed" });
  }));
}).pipe(Effect.withSpan(name, { kind: "server", attributes: { "obt.page": pageOf(pageUrl(sender)), ...attributes } })));

// The sender's URL, not anything in the message, decides which page and site a request is for.
// Private windows report none, so nothing about them is cached, logged or kept as site context.
const pageUrl = (sender: Sender) => sender.tab?.incognito ? undefined : sender.tab?.url ?? sender.url;
const batchAttributes = (blocks: readonly Block[]) => ({ "obt.blocks": blocks.length, "obt.chars": batchChars(blocks) });

/** A model catalog for the options page; an empty one is logged, since it usually means a wrong key or plan. */
const catalog = (provider: string, list: () => Promise<ChatGPTModel[]>, emptyDetail?: string): Promise<ModelList> =>
  list().then((models) => {
    if (!models.length) void debugLog.warn(`${provider} 模型列表为空`, emptyDetail ? { detail: emptyDetail } : undefined);
    return { status: "ok", models };
  }, (error) => {
    void debugLog.error(`读取 ${provider} 模型列表失败`, { detail: describeError(error) });
    return { status: "failed" };
  });

export default defineBackground(() => {
  const contexts = createContextCarryover({
    get: () => translationContexts.getValue(),
    set: (value) => translationContexts.setValue(value),
  });
  browser.tabs.onUpdated.addListener((tabId, change) => { void handleChatGPTNavigation(tabId, change.url); });
  browser.tabs.onRemoved.addListener((tabId) => { void handleChatGPTTabClosed(tabId); });
  // The launcher only appears on web pages; the toolbar button reaches settings from anywhere.
  browser.action.onClicked.addListener(() => { void browser.runtime.openOptionsPage(); });

  const dispatcher = createDispatcher({
    trusted: (sender) => sender.id === browser.runtime.id,
    onInvalid: (type, error) => { void debugLog.warn(`收到无效请求：${type}`, { detail: error }); },
    handlers: {
      "open-settings": () => browser.runtime.openOptionsPage().then(() => ({ opened: true as const })),
      "debug-log": ({ entry }, sender) => {
        void debugLog.write(entry.level, entry.event, { detail: entry.detail, page: pageOf(pageUrl(sender)), source: "page" });
      },
      "debug-log-clear": () => debugLog.clear().then(() => ({ status: "ok" as const })),
      "traces-clear": () => traceStore.clear().then(() => ({ status: "ok" as const })),
      "cache-stats": () => translationCache.count().then((count) => ({ status: "ok" as const, count }), () => ({ status: "failed" as const })),
      "cache-clear": () => translationCache.clear().then(() => ({ status: "ok" as const }), () => ({ status: "failed" as const })),
      "chatgpt-sign-in": () => startChatGPTSignIn(),
      "chatgpt-sign-out": () => signOutChatGPT().then(() => ({ status: "ok" as const })),
      "chatgpt-models": () => catalog("ChatGPT", listChatGPTModels, "接口没有返回 visibility 为 list 的模型"),
      // The options page sends the key being edited, so the list follows it before it's saved.
      "openai-models": async ({ apiKey: edited }) => {
        const apiKey = edited?.trim() || (await aiSettings.getValue()).providers[AiProviders.OpenAIApi].apiKey.trim();
        return apiKey ? catalog("OpenAI", () => listOpenAIModels(apiKey), "接口没有返回可生成文本的模型") : { status: "no-key" as const };
      },
      "gateway-models": () => catalog("Vercel AI Gateway", listGatewayModels),
      "prepare-translation": ({ context }, sender) => traceRequest(
        "prepare-translation", sender, { "obt.sample.chars": context.sample.length }, "准备翻译失败",
        (settings) => Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan(modelAttributes(settings, "analysis"));
          yield* configuredSettings();
          void contexts.notePage(siteOf(pageUrl(sender)), context.title);
          const plan = yield* decideTranslationPlan(context);
          yield* Effect.annotateCurrentSpan({ "obt.plan.mode": plan.mode, "obt.plan.navigation": plan.navigation, "obt.plan.fallback": plan.fallback });
          return { status: "ok", plan } as const;
        }).pipe(Effect.catchTag("ModelNotConfigured", ({ purpose }) => Effect.succeed({ status: "not-configured", purpose } as const))),
      ),
      "analyze-content": ({ mode, blocks }, sender) => traceRequest(
        "analyze-content", sender, { "obt.mode": mode, ...batchAttributes(blocks) }, "内容分析失败",
        (settings) => Effect.andThen(Effect.annotateCurrentSpan(modelAttributes(settings, "analysis")), analyzePageContent(blocks, mode)),
      ),
    },
    translate: (blocks, sender, onBlock) => traceRequest(
      "translate-content", sender, { "obt.streaming": true, ...batchAttributes(blocks) }, "翻译批次失败",
      () => translatePageBatch(blocks, pageUrl(sender), { cache: translationCache, contexts }, onBlock),
    ),
  });
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => dispatcher.onMessage(message, sender, sendResponse));
  browser.runtime.onConnect.addListener((port) => dispatcher.onConnect(port));
});
