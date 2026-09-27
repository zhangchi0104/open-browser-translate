import type { TranslatableContent } from "../modules/dom-parser";

export function createCapturedContent() {
  const placeholders: HTMLElement[] = [];
  const outsideAnchors = new Map<Element, HTMLElement>();
  const clear = () => {
    for (const placeholder of placeholders) placeholder.remove();
    placeholders.length = 0;
    outsideAnchors.clear();
  };

  return {
    clear,
    show(content: readonly TranslatableContent[]) {
      clear();
      this.append(content);
    },
    append(content: readonly TranslatableContent[], translations?: readonly string[]) {
      for (const [index, item] of content.entries()) {
        const last = item.segments.at(-1)?.node;
        if (!last || !item.element.isConnected
          || item.segments.some(({ node, text }) => !node.isConnected || node.data !== text)) continue;

        // Insert after this text run, since one element may contain several groups.
        let anchor: Node = last;
        while (anchor.parentElement && anchor.parentElement !== item.element && !anchor.nextSibling) {
          anchor = anchor.parentElement;
        }
        const document = last.ownerDocument;
        const style = document.defaultView!.getComputedStyle(item.element);
        const inline = style.display.startsWith("inline") || item.element.matches('button, a, [role="button"]');
        const placeholder = document.createElement("open-browser-translate-placeholder");
        placeholder.setAttribute("translate", "no");
        placeholder.setAttribute("aria-label", translations ? "译文" : "译文占位，尚未翻译");
        placeholder.style.cssText = `display: ${inline ? "inline-block" : "block"}; font: inherit; color: inherit; white-space: normal; box-sizing: border-box; max-width: 100%; border: 1px solid #a3a7da; border-radius: 4px; padding: 4px 8px;`;
        if (inline) placeholder.style.marginInlineStart = "0.5em";
        else placeholder.style.marginBlock = "6px";

        const shadow = placeholder.attachShadow({ mode: "closed" });
        const css = document.createElement("style");
        css.textContent = ":host { overflow-wrap: anywhere; } .text { white-space: pre-wrap; font-weight: normal; }";
        const text = document.createElement("span");
        text.className = "text";
        text.textContent = translations?.[index] ?? item.text;
        shadow.append(css, text);
        anchor.parentNode?.insertBefore(placeholder, anchor.nextSibling);
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
        if (clippingAncestor) {
          // Search snippets often clamp their children; keep the translation outside that clip.
          const insertionPoint = outsideAnchors.get(clippingAncestor) ?? clippingAncestor;
          insertionPoint.after(placeholder);
          placeholder.style.display = "block";
          placeholder.style.marginInlineStart = "0";
          placeholder.style.marginBlock = "6px";
          placeholder.style.font = style.font;
          placeholder.style.color = style.color;
          outsideAnchors.set(clippingAncestor, placeholder);
        }
        placeholders.push(placeholder);
      }
    },
    remove: clear,
  };
}
