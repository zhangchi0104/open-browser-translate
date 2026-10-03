import type { TranslatableContent } from "../modules/dom-parser";

// Text styling copied from the source so the translation reads like the original.
const SOURCE_STYLES = [
  "font-family", "font-size", "font-weight", "font-style", "font-variant", "font-stretch", "line-height",
  "color", "letter-spacing", "word-spacing", "text-transform", "text-align",
  "text-decoration-line", "text-decoration-style", "text-decoration-color", "text-shadow",
] as const;

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
  const outsideAnchors = new Map<Element, HTMLElement>();
  // Each translated item's placeholder, so streaming text can update it in place.
  const placed = new Map<TranslatableContent, { placeholder: HTMLElement; text: HTMLElement }>();
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
    if (!translated) {
      // Outside the clip, `inherit` would pick up the wrong element's text styles.
      const style = document.defaultView!.getComputedStyle(item.element);
      placeholder.style.font = style.font;
      placeholder.style.color = style.color;
    }
    outsideAnchors.set(clippingAncestor, placeholder);
  }

  /** Inserts a placeholder after the item's text: its translation, or a boxed preview of the source. */
  function place(item: TranslatableContent, translation: string | undefined) {
    const last = item.segments.at(-1)?.node;
    if (!last || !item.element.isConnected
      || item.segments.some(({ node, text }) => !node.isConnected || node.data !== text)) return;

    // Insert after this text run, since one element may contain several groups.
    let anchor: Node = last;
    while (anchor.parentElement && anchor.parentElement !== item.element && !anchor.nextSibling) {
      anchor = anchor.parentElement;
    }
    const document = last.ownerDocument;
    const style = document.defaultView!.getComputedStyle(item.element);
    const inline = style.display.startsWith("inline") || item.element.matches('button, a, [role="button"]');
    const translated = translation !== undefined;
    const placeholder = document.createElement("open-browser-translate-placeholder");
    placeholder.setAttribute("translate", "no");
    placeholder.setAttribute("aria-label", translated ? "译文" : "译文占位，尚未翻译");
    placeholder.style.cssText = `display: ${inline ? "inline-block" : "block"}; white-space: normal; box-sizing: border-box; max-width: 100%;`;
    if (translated) {
      // Copied rather than inherited: the placeholder may sit in a different element than the
      // text it translates, and text decoration doesn't reach inline-block descendants.
      const source = document.defaultView!.getComputedStyle(styleSource(item));
      for (const property of SOURCE_STYLES) placeholder.style.setProperty(property, source.getPropertyValue(property));
    } else {
      // Untranslated previews stay boxed so they read as placeholders.
      placeholder.style.cssText += "font: inherit; color: inherit; border: 1px solid #a3a7da; border-radius: 4px; padding: 4px 8px;";
    }
    if (inline) placeholder.style.marginInlineStart = "0.5em";
    else placeholder.style.marginBlock = translated ? "0.25em" : "6px";

    const shadow = placeholder.attachShadow({ mode: "closed" });
    const css = document.createElement("style");
    css.textContent = ":host { overflow-wrap: anywhere; } .text { white-space: pre-wrap; }";
    const text = document.createElement("span");
    text.className = "text";
    text.textContent = translation ?? item.text;
    shadow.append(css, text);
    anchor.parentNode?.insertBefore(placeholder, anchor.nextSibling);
    escapeClip(placeholder, item, translated);
    placeholders.push(placeholder);
    return { placeholder, text };
  }

  return {
    clear,
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
