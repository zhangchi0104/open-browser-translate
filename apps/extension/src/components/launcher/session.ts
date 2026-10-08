import { Effect } from "effect";
import { background } from "@/lib/background";
import { DomParser, pageBrief, type TranslatableContent } from "../../modules/page/block-collector";
import type { Span } from "../../modules/page/batch-scheduler/viewport";
import { createTranslationSession, type SessionProgress, type TranslationSession } from "../../modules/page/batch-scheduler";
import { workOf } from "../../modules/page/site-works";
import { PAGE_CONTEXT_LIMITS, PURPOSE_NAMES, type Purpose } from "../../modules/shared/protocol";
import { describeError, type LogLevel } from "../../modules/shared/debug-log/model";
import { createCapturedContent } from "../captured-content";

export type BadgeState = "translating" | "done" | "failed";

/** What the launcher shows about the current session; `status` null hides the status line. */
export interface LauncherState {
  /** A session is running: the page shows translations, and the launcher's next click turns them off. */
  active: boolean;
  busy: boolean;
  badge: BadgeState | null;
  status: string | null;
}

/** Sends an entry to the background's debug log; the background adds the page URL. */
const log = (level: LogLevel, event: string, detail?: string) => {
  background.request({ type: "debug-log", entry: { level, event, detail } }).catch(() => {});
};

const parseContent = (root?: Element) => Effect.runSync(
  Effect.gen(function* () {
    const parser = yield* DomParser;
    return yield* parser.parseTranslatableContent(root);
  }).pipe(Effect.provide(DomParser.Live)),
);
const spanOf = ({ element }: TranslatableContent): Span | null => {
  if (!element.isConnected) return null;
  const bounds = element.getBoundingClientRect();
  return bounds.width === 0 && bounds.height === 0 ? null : bounds;
};
const notConfiguredText = (purpose: Purpose) => `请在设置中填写${PURPOSE_NAMES[purpose]}的 API key 和模型。`;

/**
 * Runs translation sessions on the page and reports what the launcher should show. Each `start`
 * begins a new session and stops the previous one; `stop` and `dispose` stop it and remove the
 * translations.
 */
export function createTranslationRunner(report: (change: Partial<LauncherState>) => void) {
  const capturedContent = createCapturedContent();
  let disposed = false;
  let session = 0;
  let stopSession = () => {};

  async function start() {
    stopSession();
    const id = ++session;
    const active = () => !disposed && id === session;
    let translation: TranslationSession | undefined;
    // Scrolling and resizing look for the next batches near the viewport.
    const nudge = () => translation?.nudge();
    let observer: MutationObserver | undefined;
    stopSession = () => {
      observer?.disconnect();
      document.removeEventListener("scroll", nudge, true);
      window.removeEventListener("resize", nudge);
      translation?.stop();
    };
    // The badge once the session ends here: a session only ends on its own when it can't go on
    // (nothing to translate, a model not configured, preparing failed, or an error).
    let outcome: BadgeState | null = "failed";
    report({ active: true, busy: true, badge: "translating", status: "正在捕获页面内容…" });
    try {
      capturedContent.clear();
      const content = parseContent();
      log("info", `开始翻译：捕获 ${content.length} 段`);
      if (content.length === 0) {
        report({ status: "没有捕获到待翻译内容。" });
        outcome = null;
        return;
      }
      report({ status: "正在判断页面翻译模式…" });
      const prepared = await background.request({
        type: "prepare-translation",
        context: {
          title: document.title.slice(0, PAGE_CONTEXT_LIMITS.title),
          sample: content.slice(0, 30).map(({ text }) => text).join("\n").slice(0, PAGE_CONTEXT_LIMITS.sample),
          hasArticle: document.querySelector('article, [role="article"]') !== null,
          pagination: Array.from(document.querySelectorAll('a[rel="next"], nav[aria-label*="page" i] a, [aria-label*="pagination" i] a'))
            .slice(0, PAGE_CONTEXT_LIMITS.pagination).map((element) => (element.textContent ?? "").trim().slice(0, PAGE_CONTEXT_LIMITS.paginationLabel)),
        },
      });
      if (!active()) return;
      if (prepared.status === "not-configured") {
        report({ status: notConfiguredText(prepared.purpose) });
        return;
      }
      if (prepared.status !== "ok") {
        report({ status: "无法准备翻译，请检查设置后重试。" });
        return;
      }
      capturedContent.setLanguage(prepared.language);
      const plan = prepared.plan;
      const modeLabel = plan.mode === "main" ? "仅正文" : "普通网页";
      const summary = ({ shown, failed, fallbacks }: SessionProgress) => `${modeLabel} · 已显示 ${shown} 段译文。`
        + (failed ? `${failed} 段翻译失败，请重试。` : "")
        + (fallbacks || plan.fallback ? "部分内容使用本地筛选回退。" : "");

      const brief = pageBrief({
        title: document.title,
        description: document.querySelector('meta[name="description"]')?.getAttribute("content"),
        heading: document.querySelector("h1")?.textContent,
      });
      const work = await workOf(location.href);
      if (!active()) return;
      translation = createTranslationSession(content, plan.mode, {
        spanOf,
        attached: ({ element }) => element.isConnected,
        viewportHeight: () => window.innerHeight,
        analyze: (blocks, mode) => background.request({ type: "analyze-content", mode, blocks: blocks.map(({ text, tag }) => ({ text, tag })) }),
        translate: (blocks, onBlock, preceding) => background.translate(blocks, onBlock, { brief, preceding, work }),
        loading: (items) => capturedContent.loading(items),
        show: (item, text, final) => capturedContent.update(item, text, !final),
        discard: (items) => capturedContent.discard(items),
        log,
      }, (progress) => {
        if (!active()) return;
        if (progress.translating || progress.analyzing) {
          report({
            busy: true,
            badge: "translating",
            status: progress.translating
              ? `${modeLabel} · 正在翻译附近 ${progress.translating} 段，已显示 ${progress.shown} 段…`
              : `${modeLabel} · 正在分析附近 ${progress.analyzing} 段…`,
          });
        } else {
          report({
            busy: false,
            badge: progress.failed ? "failed" : "done",
            status: summary(progress) + (progress.pending ? "滚动页面时继续翻译附近内容。" : ""),
          });
        }
      });

      // Content added later (infinite scroll, load more) joins the session; text already
      // captured, and the translations it shows, don't.
      const captured = new WeakSet<Text>();
      for (const item of content) for (const { node } of item.segments) captured.add(node);
      document.addEventListener("scroll", nudge, { capture: true, passive: true });
      window.addEventListener("resize", nudge);
      observer = new MutationObserver((records) => {
        const added: TranslatableContent[] = [];
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (!(node instanceof Element) || !node.isConnected
              || node.closest("open-browser-translate, open-browser-translate-placeholder")) continue;
            for (const item of parseContent(node)) {
              if (item.segments.some((segment) => captured.has(segment.node))) continue;
              for (const segment of item.segments) captured.add(segment.node);
              added.push(item);
            }
          }
        }
        translation?.add(added);
      });
      observer.observe(document.body, { childList: true, subtree: true });

      const { notConfigured } = await translation.run();
      if (active() && notConfigured) report({ status: notConfiguredText(notConfigured) });
    } catch (error) {
      log("error", "翻译中断：异常", describeError(error));
      if (active()) report({ status: "无法完成翻译，请检查配置并刷新页面后重试。" });
    } finally {
      if (id === session) {
        stopSession();
        if (!disposed) report({ active: false, busy: false, badge: outcome });
      }
    }
  }

  return {
    start,
    /** Ends the session and puts the page back as it was. */
    stop() {
      session++;
      stopSession();
      stopSession = () => {};
      capturedContent.clear();
      report({ active: false, busy: false, badge: null, status: null });
    },
    dispose() {
      disposed = true;
      stopSession();
      capturedContent.remove();
    },
  };
}
