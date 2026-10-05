import type { TranslatableContent } from "../modules/page/block-collector";

// Shimmering bars in a faint version of the text color, so they suit light and dark pages.
const PLACEHOLDER_CSS = `:host { overflow-wrap: break-word; } .text { white-space: pre-wrap; }
:host([data-nowrap]) { overflow-wrap: normal; } :host([data-nowrap]) .text { white-space: nowrap; }
.skeleton { display: flex; flex-direction: column; gap: 0.4em; padding-block: 0.15em; }
.skeleton.inline { display: inline-flex; vertical-align: middle; padding: 0; }
.bar { display: block; height: 0.8em; border-radius: 0.3em;
  background: linear-gradient(90deg, color-mix(in srgb, currentColor 8%, transparent) 25%, color-mix(in srgb, currentColor 20%, transparent) 50%, color-mix(in srgb, currentColor 8%, transparent) 75%);
  background-size: 200% 100%; animation: shimmer 1.4s ease-in-out infinite; }
@keyframes shimmer { from { background-position: 100% 0; } to { background-position: -100% 0; } }
@media (prefers-reduced-motion: reduce) { .bar { animation: none; } }`;

// A faint indigo wash behind translations, so they stand apart from the page's own text on light
// and dark pages alike without looking like a box.
const TRANSLATION_TINT = "rgb(99 102 241 / 0.1)";

// Text styling copied from the source so the translation reads like the original.
const SOURCE_STYLES = [
  "font-family", "font-size", "font-weight", "font-style", "font-variant", "font-stretch", "line-height",
  "color", "letter-spacing", "word-spacing", "text-transform", "text-align",
  "text-decoration-line", "text-decoration-style", "text-decoration-color", "text-shadow",
] as const;

/** How many lines the group's text takes up on screen; 0 when it isn't rendered. */
function lineCount(item: TranslatableContent): number {
  const first = item.segments[0]?.node;
  const last = item.segments.at(-1)?.node;
  if (!first || !last) return 0;
  const range = first.ownerDocument.createRange();
  range.setStart(first, 0);
  range.setEnd(last, last.length);
  const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0).sort((a, b) => a.top - b.top);
  // Inline boxes on one line can differ slightly in top (mixed font sizes), so a new line
  // starts only below half the previous box's height.
  let lines = 0;
  let lineBottom = -Infinity;
  for (const rect of rects) {
    if (rect.top >= lineBottom - rect.height / 2) lines++;
    lineBottom = Math.max(lineBottom, rect.bottom);
  }
  return lines;
}

/** Block translations' tint padding; inline ones are padded to fill their line instead. */
const BLOCK_PADDING = "0.15em 0.4em";

/**
 * Pads an inline translation's tint to its line's height. An inline box's background covers only
 * the font's height, so under a tall line-height it would be a thin strip beside the full-height
 * block translations; filled out, wrapped lines meet like a block's.
 */
function fillLine(placeholder: HTMLElement) {
  const lineHeight = Number.parseFloat(placeholder.ownerDocument.defaultView!.getComputedStyle(placeholder).lineHeight);
  // `normal` line height is about the font's own height, so there's nothing to fill.
  if (!Number.isFinite(lineHeight)) return;
  placeholder.style.paddingBlock = "0";
  const fontHeight = placeholder.getClientRects()[0]?.height;
  if (fontHeight) placeholder.style.paddingBlock = `${Math.max(0, (lineHeight - fontHeight) / 2)}px`;
}

/** Whether `from` or an ancestor up to `block` lays its children out as a flex or grid row. */
function inRow(from: Element | null, block: Element): boolean {
  const view = block.ownerDocument.defaultView!;
  for (let element = from; element; element = element.parentElement) {
    if (/flex|grid/.test(view.getComputedStyle(element).display)) return true;
    if (element === block) return false;
  }
  return false;
}

/**
 * Where a one-line translation goes: after the text, or after the outermost link, kept text (code,
 * translate="no") or inline box (a badge) around it within the block, so the translation doesn't
 * become part of it (clickable, underlined, monospace, boxed). A block that is itself a link keeps
 * it inside.
 */
function inlineAnchor(last: Text, block: Element): Node {
  const view = block.ownerDocument.defaultView!;
  let anchor: Node = last;
  for (let element = last.parentElement; element && element !== block && block.contains(element); element = element.parentElement) {
    if (element.matches('a, code, kbd, samp, math, [aria-hidden="true"], [translate="no"], .notranslate')
      || view.getComputedStyle(element).display !== "inline") anchor = element;
  }
  return anchor;
}

/** The element holding most of the group's text: the whole group for a link title, the paragraph for one short link. */
function styleSource(item: TranslatableContent): Element {
  const weight = new Map<Element, number>();
  for (const { node, text } of item.segments) {
    const parent = node.parentElement ?? item.element;
    weight.set(parent, (weight.get(parent) ?? 0) + text.trim().length);
  }
  let source = item.element;
  let most = -1;
  for (const [element, length] of weight) if (length > most) [source, most] = [element, length];
  return source;
}

export function createCapturedContent() {
  const placeholders: HTMLElement[] = [];
  // The target language, so translations render with that language's fonts and line breaking.
  let language: string | undefined;
  const outsideAnchors = new Map<Element, HTMLElement>();
  // Each translated item's placeholder, so streaming text can update it in place.
  const placed = new Map<TranslatableContent, { placeholder: HTMLElement; text: HTMLElement; skeleton?: HTMLElement }>();
  const clear = () => {
    for (const placeholder of placeholders) placeholder.remove();
    placeholders.length = 0;
    outsideAnchors.clear();
    placed.clear();
  };

  /** Moves a placeholder out of an ancestor that clamps or clips it, so the translation stays visible. */
  function escapeClip(placeholder: HTMLElement, item: TranslatableContent, translated: boolean) {
    const document = placeholder.ownerDocument;
    let clippingAncestor: Element | undefined;
    for (let ancestor = placeholder.parentElement;
      ancestor && ancestor !== document.body && ancestor !== document.documentElement;
      ancestor = ancestor.parentElement) {
      const ancestorStyle = document.defaultView!.getComputedStyle(ancestor);
      const clamped = Number.parseInt(ancestorStyle.webkitLineClamp, 10) > 0;
      const bounds = ancestor.getBoundingClientRect();
      const translatedBounds = placeholder.getBoundingClientRect();
      const clipsVertically = ["hidden", "clip"].includes(ancestorStyle.overflowY)
        && (translatedBounds.bottom > bounds.bottom || translatedBounds.top < bounds.top);
      if (clamped || clipsVertically) clippingAncestor = ancestor;
    }
    if (!clippingAncestor) return;
    // Search snippets often clamp their children; keep the translation outside that clip.
    const insertionPoint = outsideAnchors.get(clippingAncestor) ?? clippingAncestor;
    insertionPoint.after(placeholder);
    placeholder.style.display = "block";
    placeholder.style.marginInlineStart = "0";
    placeholder.style.marginBlock = translated ? "0.25em" : "6px";
    if (translated) placeholder.style.padding = BLOCK_PADDING;
    if (!translated) {
      // Outside the clip, `inherit` would pick up the wrong element's text styles.
      const style = document.defaultView!.getComputedStyle(item.element);
      placeholder.style.font = style.font;
      placeholder.style.color = style.color;
    }
    outsideAnchors.set(clippingAncestor, placeholder);
  }

  /**
   * Inserts a placeholder after the item's text: its translation, a loading skeleton while it's
   * being translated, or a boxed preview of the source.
   */
  function place(item: TranslatableContent, translation: string | undefined, loading = false) {
    const last = item.segments.at(-1)?.node;
    if (!last || !item.element.isConnected
      || item.segments.some(({ node, text }) => !node.isConnected || node.data !== text)) return;

    const document = last.ownerDocument;
    const style = document.defaultView!.getComputedStyle(item.element);
    const translated = translation !== undefined || loading;
    // A translation of one-line text (links, headings, contents entries, buttons) follows it on
    // the same line, right after the text node, so it flows with the text even inside flex rows.
    // Multi-line text gets its translation as a block below.
    const inline = translated
      ? lineCount(item) <= 1 || style.display.startsWith("inline")
      : style.display.startsWith("inline") || item.element.matches('button, a, [role="button"]');
    // Insert after this text run, since one element may contain several groups.
    let anchor: Node = translated && inline ? inlineAnchor(last, item.element) : last;
    while (!(translated && inline) && anchor.parentElement && anchor.parentElement !== item.element && !anchor.nextSibling) {
      anchor = anchor.parentElement;
    }
    const placeholder = document.createElement("open-browser-translate-placeholder");
    placeholder.setAttribute("translate", "no");
    if (language) placeholder.setAttribute("lang", language);
    placeholder.setAttribute("aria-label", loading ? "正在翻译" : translated ? "译文" : "译文占位，尚未翻译");
    placeholder.style.cssText = `display: ${!inline ? "block" : translated ? "inline" : "inline-block"}; white-space: normal; box-sizing: border-box; max-width: 100%;`;
    if (translated) {
      // Copied rather than inherited: the placeholder may sit in a different element than the
      // text it translates, and text decoration doesn't reach inline-block descendants.
      const source = document.defaultView!.getComputedStyle(styleSource(item));
      for (const property of SOURCE_STYLES) placeholder.style.setProperty(property, source.getPropertyValue(property));
      // The skeleton shows alone; the tint comes with the text, and the padding is already in place
      // so the text arriving doesn't move anything.
      if (!loading) placeholder.style.backgroundColor = TRANSLATION_TINT;
      placeholder.style.borderRadius = "0.3em";
      // Inline translations wrap across lines; each line fragment gets its own rounded ends.
      placeholder.style.padding = inline ? "0 0.25em" : BLOCK_PADDING;
      if (inline) placeholder.style.setProperty("box-decoration-break", "clone");
    } else {
      // Untranslated previews stay boxed so they read as placeholders.
      placeholder.style.cssText += "font: inherit; color: inherit; border: 1px solid #a3a7da; border-radius: 4px; padding: 4px 8px;";
    }
    if (inline) placeholder.style.marginInlineStart = "0.5em";
    else placeholder.style.marginBlock = translated ? "0.25em" : "6px";

    const shadow = placeholder.attachShadow({ mode: "closed" });
    const css = document.createElement("style");
    css.textContent = PLACEHOLDER_CSS;
    const text = document.createElement("span");
    text.className = "text";
    text.textContent = loading ? "" : translation ?? item.text;
    shadow.append(css, text);
    let skeleton: HTMLElement | undefined;
    if (loading) {
      // As many bars as the source has lines (up to three); one short bar after one-line text.
      skeleton = document.createElement("span");
      skeleton.className = inline ? "skeleton inline" : "skeleton";
      // Roughly the width of a Chinese translation (about 0.3em per source character), kept short
      // so it stays on the source's line.
      if (inline) skeleton.style.width = `${Math.min(Math.max(item.text.length * 0.3, 2), 5)}em`;
      const bars = inline ? 1 : Math.min(Math.max(lineCount(item), 1), 3);
      for (let index = 0; index < bars; index++) {
        const bar = document.createElement("span");
        bar.className = "bar";
        if (bars > 1 && index === bars - 1) bar.style.width = "60%";
        skeleton.append(bar);
      }
      shadow.append(skeleton);
      placeholder.dataset.loading = "";
      placeholder.setAttribute("aria-busy", "true");
    }
    // A one-line translation in a flex or grid row (a nav button's label, say), as an item or inside
    // one, would be squeezed to its narrowest width, one Chinese character per line; it stays on one
    // line instead. Checked before inserting, so placing it reads styles once.
    if (translated && inline && inRow(anchor.parentElement, item.element)) {
      placeholder.dataset.nowrap = "";
      placeholder.style.flexShrink = "0";
    }
    anchor.parentNode?.insertBefore(placeholder, anchor.nextSibling);
    escapeClip(placeholder, item, translated);
    if (translated && placeholder.style.display === "inline") fillLine(placeholder);
    placeholders.push(placeholder);
    return { placeholder, text, skeleton };
  }

  return {
    clear,
    /** The language translations placed from now on are in. */
    setLanguage(code: string) {
      language = code;
    },
    show(content: readonly TranslatableContent[]) {
      clear();
      this.append(content);
    },
    append(content: readonly TranslatableContent[], translations?: readonly string[]) {
      for (const [index, item] of content.entries()) {
        if (translations) this.update(item, translations[index]!, false);
        else place(item, undefined);
      }
    },
    /**
     * Shows `text` as the item's translation, creating its placeholder on first use. While
     * `streaming`, the text is still being written and is shown faded.
     */
    update(item: TranslatableContent, text: string, streaming: boolean) {
      let entry = placed.get(item);
      if (!entry) {
        entry = place(item, text);
        if (!entry) return;
        placed.set(item, entry);
      } else {
        entry.text.textContent = text;
      }
      if (entry.skeleton) {
        entry.skeleton.remove();
        entry.skeleton = undefined;
        delete entry.placeholder.dataset.loading;
        entry.placeholder.style.backgroundColor = TRANSLATION_TINT;
        entry.placeholder.removeAttribute("aria-busy");
        entry.placeholder.setAttribute("aria-label", "译文");
      }
      if (streaming) {
        entry.placeholder.dataset.streaming = "";
        entry.placeholder.style.opacity = "0.6";
      } else {
        delete entry.placeholder.dataset.streaming;
        entry.placeholder.style.removeProperty("opacity");
        // Short streamed text may have fit inside a clip that the full translation overflows.
        escapeClip(entry.placeholder, item, true);
      }
    },
    /** Shows a loading skeleton where each item's translation will appear, until `update` fills it. */
    loading(items: readonly TranslatableContent[]) {
      for (const item of items) {
        if (placed.has(item)) continue;
        const entry = place(item, undefined, true);
        if (entry) placed.set(item, entry);
      }
    },
    /** Removes the items' translations, e.g. the partial text of a batch that failed. */
    discard(items: readonly TranslatableContent[]) {
      for (const item of items) {
        const entry = placed.get(item);
        if (!entry) continue;
        entry.placeholder.remove();
        placeholders.splice(placeholders.indexOf(entry.placeholder), 1);
        placed.delete(item);
        // Later translations escaping the same clip would otherwise be inserted after a detached node.
        for (const [ancestor, anchor] of outsideAnchors) if (anchor === entry.placeholder) outsideAnchors.delete(ancestor);
      }
    },
    remove: clear,
  };
}
