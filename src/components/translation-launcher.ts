import { Effect } from "effect";
import { storage } from "wxt/utils/storage";
import { browser } from "wxt/browser";
import { DomParser, type TranslatableContent } from "../modules/dom-parser";
import { createBatchQueue, MAX_CONCURRENT_BATCHES, pickNearViewport, type Span } from "../modules/viewport-queue";
import { createCapturedContent } from "./captured-content";
import { ANALYSIS_BATCH_SIZE } from "../modules/content-analyzer/protocol";
import type { TranslationBatchResult } from "../modules/translator/translate-batch";
import type { TranslationPlan } from "../modules/content-analyzer/page-plan";
import { describeError, type LogLevel } from "../modules/debug-log/model";

const BALL_SIZE = 52;
const LAUNCHER_HEIGHT = 94;
const EDGE_MARGIN = 16;
const DRAG_THRESHOLD = 4;

type BadgeState = "translating" | "done" | "failed";

const BADGE_ICONS: Record<BadgeState, string> = {
  translating: "",
  done: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 12.5 4 4 8-9"/></svg>`,
  failed: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>`,
};

const BADGE_LABELS: Record<BadgeState, string> = {
  translating: "正在翻译",
  done: "翻译完成",
  failed: "翻译失败",
};

interface BallPosition {
  x: number;
  y: number;
}

const ballPosition = storage.defineItem<BallPosition>("local:ballPosition");

/** Sends an entry to the background's debug log; the background adds the page URL. */
const log = (level: LogLevel, event: string, detail?: string) => {
  browser.runtime.sendMessage({ type: "debug-log", entry: { level, event, detail } }).catch(() => {});
};

export function mountTranslationLauncher(container: HTMLElement) {
  const root = document.createElement("div");
  root.className = "translation-launcher";
  root.setAttribute("translate", "no");

  const ball = document.createElement("button");
  ball.type = "button";
  ball.className = "translation-ball";
  ball.setAttribute("aria-label", "Open Browser Translate");
  ball.title = "Open Browser Translate";
  ball.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 5h12M9 3v2M5 5c1 5 4 8 8 10M13 5c-1 5-4 8-8 10M13 21l4-10 4 10M14.5 17h5"/>
    </svg>
  `;
  root.append(ball);
  // 翻译状态角标：放在按钮左下角，作为兄弟节点以免受按钮 disabled 透明度影响
  const badge = document.createElement("span");
  badge.className = "translation-badge";
  badge.hidden = true;
  root.append(badge);
  const setBadge = (state: BadgeState | null) => {
    if (!state) {
      badge.hidden = true;
      badge.removeAttribute("data-state");
      badge.removeAttribute("title");
      badge.innerHTML = "";
      return;
    }
    badge.hidden = false;
    badge.dataset.state = state;
    badge.title = BADGE_LABELS[state];
    badge.innerHTML = BADGE_ICONS[state];
  };
  const capturedContent = createCapturedContent();
  let mounted = true;
  const status = document.createElement("div");
  status.className = "translation-status";
  status.setAttribute("role", "status");
  status.setAttribute("translate", "no");
  status.hidden = true;
  container.append(status);

  const settings = document.createElement("button");
  settings.type = "button";
  settings.className = "translation-settings";
  settings.setAttribute("aria-label", "打开翻译设置");
  settings.title = "翻译设置";
  settings.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 3-.6 2.2-2 .9-2.1-.6-2 3.5 1.5 1.6v2.8L2.3 15l2 3.5 2.1-.6 2 .9L9 21h4l.6-2.2 2-.9 2.1.6 2-3.5-1.5-1.6v-2.8L19.7 9l-2-3.5-2.1.6-2-.9L13 3Z"/><circle cx="11" cy="12" r="3"/></svg>`;
  settings.addEventListener("click", async () => {
    settings.disabled = true;
    try {
      await browser.runtime.sendMessage({ type: "open-settings" });
      settings.title = "翻译设置";
    } catch {
      settings.title = "无法打开设置，请刷新页面后重试";
    } finally {
      settings.disabled = false;
    }
  });
  root.append(settings);

  const clampX = (x: number) =>
    Math.min(Math.max(x, 0), Math.max(0, window.innerWidth - BALL_SIZE));
  const clampY = (y: number) =>
    Math.min(Math.max(y, 0), Math.max(0, window.innerHeight - LAUNCHER_HEIGHT));

  // 默认位置：右下角
  const pos: BallPosition = {
    x: clampX(window.innerWidth - BALL_SIZE - EDGE_MARGIN),
    y: clampY(window.innerHeight - LAUNCHER_HEIGHT - EDGE_MARGIN),
  };

  const applyPosition = () => {
    root.style.left = `${pos.x}px`;
    root.style.top = `${pos.y}px`;
  };
  applyPosition();

  // 从扩展存储恢复上次拖拽位置
  ballPosition.getValue().then((saved) => {
    if (saved && typeof saved.x === "number" && typeof saved.y === "number") {
      pos.x = clampX(saved.x);
      pos.y = clampY(saved.y);
      applyPosition();
    }
  }).catch(() => {});

  // —— 拖拽 ——
  let dragging = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let originX = 0;
  let originY = 0;

  ball.addEventListener("pointerdown", (event) => {
    dragging = true;
    moved = false;
    startX = event.clientX;
    startY = event.clientY;
    originX = pos.x;
    originY = pos.y;
    ball.setPointerCapture(event.pointerId);
  });

  ball.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    // 位移超过阈值才算拖拽，避免把点击误判成拖动
    if (
      !moved &&
      Math.abs(dx) <= DRAG_THRESHOLD &&
      Math.abs(dy) <= DRAG_THRESHOLD
    ) {
      return;
    }
    moved = true;
    pos.x = clampX(originX + dx);
    pos.y = clampY(originY + dy);
    applyPosition();
  });

  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    if (!moved) return;
    // 松手后吸附到左右边缘
    pos.x = pos.x < window.innerWidth / 2 ? 0 : clampX(window.innerWidth);
    applyPosition();
    void ballPosition.setValue({ ...pos }).catch(() => {});
  };
  ball.addEventListener("pointerup", endDrag);
  ball.addEventListener("pointercancel", endDrag);

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

  // Each click starts a new session; a later click or unmount stops the previous one.
  let session = 0;
  let stopSession = () => {};

  ball.addEventListener("click", async () => {
    if (ball.disabled) return;
    if (moved) {
      moved = false;
      return; // 拖拽结束后的 click 不算点击
    }
    stopSession();
    const id = ++session;
    const active = () => mounted && id === session;
    const setBusy = (busy: boolean) => {
      ball.disabled = busy;
      if (busy) ball.setAttribute("aria-busy", "true");
      else ball.removeAttribute("aria-busy");
    };
    let queue: ReturnType<typeof createBatchQueue<TranslatableContent[]>> | undefined;
    // Scrolling, resizing, new content and stopping the session all wake the queue.
    const nudge = () => queue?.nudge();
    let observer: MutationObserver | undefined;
    stopSession = () => {
      observer?.disconnect();
      document.removeEventListener("scroll", nudge, true);
      window.removeEventListener("resize", nudge);
      nudge();
    };
    setBusy(true);
    setBadge("translating");
    let outcome: BadgeState | null = "failed";
    status.hidden = false;
    status.textContent = "正在捕获页面内容…";
    try {
      capturedContent.clear();
      const content = parseContent();
      log("info", `开始翻译：捕获 ${content.length} 段`);
      if (content.length === 0) {
        status.textContent = "没有捕获到待翻译内容。";
        outcome = null;
        return;
      }
      status.textContent = "正在判断页面翻译模式…";
      const prepared = await browser.runtime.sendMessage({
        type: "prepare-translation",
        context: {
          title: document.title.slice(0, 1000),
          sample: content.slice(0, 30).map(({ text }) => text).join("\n").slice(0, 12000),
          hasArticle: document.querySelector('article, [role="article"]') !== null,
          pagination: Array.from(document.querySelectorAll('a[rel="next"], nav[aria-label*="page" i] a, [aria-label*="pagination" i] a'))
            .slice(0, 20).map((element) => (element.textContent ?? "").trim().slice(0, 100)),
        },
      });
      if (!active()) return;
      if (prepared?.status === "not-configured") {
        status.textContent = `请在设置中填写${prepared.purpose === "translation" ? "翻译" : "内容分析"}的 API key 和模型。`;
        return;
      }
      if (prepared?.status !== "ok") {
        status.textContent = "无法准备翻译，请检查设置后重试。";
        return;
      }
      const plan: TranslationPlan = prepared.plan;
      const modeLabel = plan.mode === "main" ? "仅正文" : "普通网页";

      // Only content near the viewport is translated; scrolling and newly added
      // content (infinite scroll, load more) feed the same queue.
      let pending = content;
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
        if (added.length === 0) return;
        pending = pending.concat(added);
        nudge();
      });
      observer.observe(document.body, { childList: true, subtree: true });

      let kept = 0;
      let failures = 0;
      let fallbackCount = 0;
      const summary = () => `${modeLabel} · 已显示 ${kept} 段译文。`
        + (failures ? `${failures} 段翻译失败，请重试。` : "")
        + (fallbackCount || plan.fallback ? "部分内容使用本地筛选回退。" : "");
      // Several batches are translated at once, nearest first; each shows as soon as it's done.
      let translating = 0;
      let notConfigured: "analysis" | "translation" | undefined;
      queue = createBatchQueue<TranslatableContent[]>({
        limit: MAX_CONCURRENT_BATCHES,
        next: () => {
          pending = pending.filter(({ element }) => element.isConnected);
          const batch = pickNearViewport(pending, spanOf, window.innerHeight, ANALYSIS_BATCH_SIZE);
          if (batch.length === 0) return undefined;
          const picked = new Set(batch);
          pending = pending.filter((item) => !picked.has(item));
          return batch;
        },
        run: async (batch) => {
          translating += batch.length;
          try {
            let result: TranslationBatchResult;
            try {
              result = await browser.runtime.sendMessage({
                type: "translate-content",
                mode: plan.mode,
                blocks: batch.map(({ text, tag }) => ({ text, tag })),
              });
            } catch (error) {
              log("error", "翻译批次：发送请求失败", describeError(error));
              result = { status: "failed" };
            }
            if (!active()) return false;
            if (result.status === "not-configured") {
              notConfigured = result.purpose;
              return false;
            }
            if (result.status === "ok" && result.translations.length !== batch.length) {
              log("error", "翻译批次：译文数量与请求不一致", `请求 ${batch.length} 段，返回 ${result.translations.length} 段`);
            }
            if (result.status !== "ok" || result.translations.length !== batch.length) {
              failures += batch.length;
              return true;
            }
            const selected = batch.flatMap((item, index) => result.translations[index] !== null ? [item] : []);
            capturedContent.append(selected, result.translations.filter((text): text is string => text !== null));
            kept += selected.length;
            fallbackCount += result.analysisFallbackCount;
            return true;
          } finally {
            translating -= batch.length;
          }
        },
        onBusy: () => {
          setBusy(true);
          setBadge("translating");
          status.textContent = `${modeLabel} · 正在翻译附近 ${translating} 段，已显示 ${kept} 段…`;
        },
        onIdle: () => {
          status.textContent = summary() + (pending.length ? "滚动页面时继续翻译附近内容。" : "");
          setBusy(false);
          setBadge(failures ? "failed" : "done");
        },
      });
      await queue.drain(active);
      if (active() && notConfigured) {
        status.textContent = `请在设置中填写${notConfigured === "translation" ? "翻译" : "内容分析"}的 API key 和模型。`;
      }
    } catch (error) {
      log("error", "翻译中断：异常", describeError(error));
      if (active()) status.textContent = "无法完成翻译，请检查配置并刷新页面后重试。";
    } finally {
      if (id === session) {
        stopSession();
        setBusy(false);
        if (mounted) setBadge(outcome);
      }
    }
  });

  container.append(root);
  const onResize = () => {
    pos.x = clampX(pos.x);
    pos.y = clampY(pos.y);
    applyPosition();
  };
  window.addEventListener("resize", onResize);
  return () => {
    mounted = false;
    stopSession();
    window.removeEventListener("resize", onResize);
    root.remove();
    capturedContent.remove();
    status.remove();
  };
}
