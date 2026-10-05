import { Context, Effect, Layer } from "effect";
import { SURROUNDINGS_LIMITS } from "../../shared/protocol";

export interface TranslatableContent {
  tag: string;
  element: Element;
  text: string;
  segments: { node: Text; text: string }[];
}

export class DomParser extends Context.Service<DomParser, {
  readonly parseTranslatableContent: (
    root?: Element,
  ) => Effect.Effect<TranslatableContent[]>;
}>()("open-browser-translate/DomParser") {
  static readonly Live = Layer.succeed(DomParser, {
    parseTranslatableContent: (root) =>
      Effect.sync(() => parseTranslatableContent(root)),
  });
}

const EXCLUDED_SELECTOR = [
  "script", "style", "noscript", "template", "head",
  "code", "pre", "kbd", "samp",
  "input", "textarea", "select", "option",
  "svg", "math", "canvas", "iframe",
  '[aria-hidden="true"]', '[translate="no"]',
  ".notranslate", "open-browser-translate",
].join(",");
// Within a sentence, these excluded elements don't end it. Kept text (a command, a formula, a
// brand name marked translate="no", a decorative arrow) is sent with the sentence but not
// translated; text-free graphics (icons) are skipped.
const KEPT_INLINE_SELECTOR = 'code, kbd, samp, math, [aria-hidden="true"], [translate="no"], .notranslate';
const GRAPHIC_INLINE_SELECTOR = "svg, canvas";
const OWN_UI_SELECTOR = "open-browser-translate, open-browser-translate-placeholder";
const hasLetter = (text: string | null) => /\p{L}/u.test(text ?? "");

function parseTranslatableContent(
  root: Element = document.body,
): TranslatableContent[] {
  if (!root) return [];

  const document = root.ownerDocument;
  const window = document.defaultView;
  if (!window) return [];

  const styles = new Map<Element, CSSStyleDeclaration>();
  const styleOf = (element: Element) => {
    let style = styles.get(element);
    if (!style) {
      style = window.getComputedStyle(element);
      styles.set(element, style);
    }
    return style;
  };

  const isClippedHelper = (element: Element, style: CSSStyleDeclaration) => {
    const hasClipping = style.overflow === "hidden"
      || style.overflow === "clip"
      || style.clipPath !== "none"
      || style.clip !== "auto";
    if (!hasClipping) return false;
    const bounds = element.getBoundingClientRect();
    return bounds.width <= 1 && bounds.height <= 1;
  };

  /** Not rendered for the reader at all: skipped, and the text around it reads as one. */
  const isInvisible = (element: Element) => {
    const style = styleOf(element);
    return element.matches("[hidden]")
      || style.display === "none"
      || style.contentVisibility === "hidden"
      || style.opacity === "0"
      || isClippedHelper(element, style);
  };
  /** Rendered but not page text to translate (code, inputs, icons, opted-out subtrees): ends the group. */
  const isExcluded = (element: Element) => element.matches(EXCLUDED_SELECTOR)
    || (element as HTMLElement).isContentEditable;

  // A scoped root still inherits exclusions from the surrounding page.
  for (let ancestor: Element | null = root; ancestor; ancestor = ancestor.parentElement) {
    if (isExcluded(ancestor) || isInvisible(ancestor)) return [];
  }

  const content: TranslatableContent[] = [];
  let segments: TranslatableContent["segments"] = [];
  let owner = root;
  // Inside an inline box that joined a sentence: its contents are part of that sentence too.
  let inlineBoxDepth = 0;
  // Kept text (inline code and the like): it doesn't make a group worth translating on its own.
  const keptText = new Set<Text>();

  const flush = () => {
    const text = segments.map((segment) => segment.text).join("");
    if (hasLetter(segments.filter(({ node }) => !keptText.has(node)).map((segment) => segment.text).join(""))) {
      content.push({ element: owner, tag: owner.tagName.toLowerCase(), text, segments });
    }
    segments = [];
  };

  /**
   * Whether words sit right before or after the element in its block, so an inline box (a badge,
   * a link styled inline-flex) reads as part of that sentence rather than as an item of its own (a
   * nav entry among others).
   */
  const besideWords = (element: Element) => (["previousSibling", "nextSibling"] as const).some((direction) => {
    for (let at = element; ; at = at.parentElement!) {
      let node = at[direction];
      while (node && (node.nodeType === 8 || (node.nodeType === 3 && !/\S/.test(node.textContent!)))) node = node[direction];
      if (node) {
        return hasLetter(node.textContent)
          && (node.nodeType === 3 || (node.nodeType === 1 && styleOf(node as Element).display === "inline"));
      }
      const parent = at.parentElement;
      if (!parent || parent === owner || styleOf(parent).display !== "inline") return false;
    }
  });

  const visit = (element: Element) => {
    // The selector check first: it's cheap, and excluded subtrees then skip the style lookup.
    if (isExcluded(element)) {
      // In running text, inline code, icons and the like stay part of the sentence around them
      // (`run <code>claude --version</code>.`), so it is translated whole; code blocks, inputs and
      // other excluded subtrees end the group.
      if (element !== root && !element.matches(OWN_UI_SELECTOR) && !(element as HTMLElement).isContentEditable
        && (inlineBoxDepth > 0 || /^(inline|math$)/.test(styleOf(element).display))) {
        if (isInvisible(element) || element.matches(GRAPHIC_INLINE_SELECTOR)) return;
        if (element.matches(KEPT_INLINE_SELECTOR)) {
          const walker = document.createTreeWalker(element, 4 /* NodeFilter.SHOW_TEXT */);
          for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
            keptText.add(node);
            segments.push({ node, text: node.data });
          }
          return;
        }
      }
      flush();
      return;
    }
    // Hidden helper text, such as a link's screen-reader-only "(opens in a new window)", sits
    // between words the reader sees as one sentence, so it doesn't end the group.
    if (element !== root && isInvisible(element)) return;
    if (element.tagName === "BR" || element.tagName === "HR") {
      flush();
      return;
    }

    const style = styleOf(element);
    const joinsInlineBox = inlineBoxDepth === 0 && style.display.startsWith("inline") && style.display !== "inline"
      && besideWords(element);
    const isBoundary = (inlineBoxDepth === 0 && !joinsInlineBox && style.display !== "inline" && style.display !== "contents")
      || element.matches('button, [role="button"]');
    const previousOwner = owner;
    if (isBoundary) {
      flush();
      owner = element;
    }
    if (joinsInlineBox) inlineBoxDepth++;

    for (const child of element.childNodes) {
      if (child.nodeType === 1) {
        visit(child as Element);
      } else if (child.nodeType === 3) {
        // Descendants can override visibility:hidden; only skip this element's text.
        if (style.visibility === "hidden" || style.visibility === "collapse") {
          flush();
          continue;
        }
        const node = child as Text;
        segments.push({ node, text: node.data });
      }
    }

    if (joinsInlineBox) inlineBoxDepth--;
    if (isBoundary) {
      flush();
      owner = previousOwner;
    }
  };

  visit(root);
  flush();
  return content;
}

/**
 * The page brief: what the page is about, in its own words (title, meta description, first
 * heading), with repeats and blank parts left out. Sent with every batch of the page.
 */
export function pageBrief(page: { title: string; description?: string | null; heading?: string | null }): string | undefined {
  const parts: string[] = [];
  for (const part of [page.title, page.description, page.heading]) {
    const text = part?.replace(/\s+/g, " ").trim();
    if (text && !parts.some((kept) => kept.includes(text))) parts.push(text);
  }
  return parts.join("\n").slice(0, SURROUNDINGS_LIMITS.brief) || undefined;
}
