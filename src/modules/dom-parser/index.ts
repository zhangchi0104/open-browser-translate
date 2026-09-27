import { Context, Effect, Layer } from "effect";

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
  "[hidden]", '[aria-hidden="true"]', '[translate="no"]',
  ".notranslate", "open-browser-translate",
].join(",");

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

  const isExcluded = (element: Element) => {
    const style = styleOf(element);
    return element.matches(EXCLUDED_SELECTOR)
      || (element as HTMLElement).isContentEditable
      || style.display === "none"
      || style.contentVisibility === "hidden"
      || style.opacity === "0"
      || isClippedHelper(element, style);
  };

  // A scoped root still inherits exclusions from the surrounding page.
  for (let ancestor: Element | null = root; ancestor; ancestor = ancestor.parentElement) {
    if (isExcluded(ancestor)) return [];
  }

  const content: TranslatableContent[] = [];
  let segments: TranslatableContent["segments"] = [];
  let owner = root;

  const flush = () => {
    const text = segments.map((segment) => segment.text).join("");
    if (/\p{L}/u.test(text)) {
      content.push({ element: owner, tag: owner.tagName.toLowerCase(), text, segments });
    }
    segments = [];
  };

  const visit = (element: Element) => {
    if (isExcluded(element)) {
      flush();
      return;
    }
    if (element.tagName === "BR" || element.tagName === "HR") {
      flush();
      return;
    }

    const style = styleOf(element);
    const isBoundary = (style.display !== "inline" && style.display !== "contents")
      || element.matches('button, [role="button"]');
    const previousOwner = owner;
    if (isBoundary) {
      flush();
      owner = element;
    }

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

    if (isBoundary) {
      flush();
      owner = previousOwner;
    }
  };

  visit(root);
  flush();
  return content;
}
