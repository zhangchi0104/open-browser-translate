import { Effect } from "effect";
import { DomParser } from "../src/modules/page/block-collector";
import { createCapturedContent } from "../src/components/captured-content";

const fixture = document.createElement("main");
fixture.style.cssText = "width:300px;font:16px/24px sans-serif";
document.body.append(fixture);
const preview = createCapturedContent();
const capture = () => {
  preview.clear();
  const content = Effect.runSync(DomParser.use((parser) => parser.parseTranslatableContent(fixture)).pipe(Effect.provide(DomParser.Live)));
  preview.show(content);
  return content;
};
function assert(value: boolean, message: string) {
  if (!value) throw new Error(message);
}
try {
  fixture.innerHTML = '<div id="clamp" style="display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden">Long result description with <b>inline emphasis</b> and enough text to span several lines in the search result.</div><div id="fixed" style="height:24px;overflow:hidden"><p>First group</p><p>Second group</p></div><p id="normal">Normal paragraph</p>';
  const original = fixture.innerHTML;
  const content = capture();
  assert(content.length === 4, "all source groups must be captured");
  preview.clear();
  preview.append(content.slice(0, 2));
  const firstPlaceholder = fixture.querySelector("open-browser-translate-placeholder");
  assert(fixture.querySelectorAll("open-browser-translate-placeholder").length === 2, "first batch renders before later batches");
  preview.append(content.slice(2));
  assert(firstPlaceholder === fixture.querySelector("open-browser-translate-placeholder"), "appending preserves earlier placeholder nodes");
  assert(fixture.querySelectorAll("open-browser-translate-placeholder").length === 4, "one placeholder per group");
  assert(fixture.querySelector("#clamp open-browser-translate-placeholder, #fixed open-browser-translate-placeholder") === null, "placeholders must escape clipping");
  const clamp = fixture.querySelector("#clamp")!;
  const fixed = fixture.querySelector("#fixed")!;
  assert(clamp.nextElementSibling!.getBoundingClientRect().top >= clamp.getBoundingClientRect().bottom, "clamped placeholder must be visible below source");
  assert(fixed.nextElementSibling?.localName === "open-browser-translate-placeholder" && fixed.nextElementSibling.nextElementSibling?.localName === "open-browser-translate-placeholder", "multiple groups share the outside insertion point");
  assert(fixture.querySelector("#normal open-browser-translate-placeholder") !== null, "normal paragraphs retain their placement");
  assert(capture().length === 4, "recapture must not include placeholders");
  preview.remove();
  assert(fixture.innerHTML === original, "cleanup restores original markup and clipping styles");

  fixture.innerHTML = '<h2 id="title" style="font:italic 700 24px/30px Georgia,serif;color:rgb(10, 20, 30);letter-spacing:1px;text-transform:uppercase">Heading text</h2>'
    + '<p id="para" style="font:400 15px/22px sans-serif;color:rgb(60, 60, 60)">Results for a query with <a href="#" style="color:rgb(0, 0, 200);text-decoration:underline">a link</a> inside</p>'
    + '<p style="font:400 15px/22px sans-serif"><a id="result" href="#" style="color:rgb(0, 0, 200);font-weight:600;text-decoration:underline">A whole search result title</a></p>'
    + '<div id="snippet" style="display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:1;overflow:hidden;font:700 18px/24px serif;color:rgb(1, 2, 3)">Clamped snippet text that is long enough to wrap over several lines in this narrow column</div>';
  const styled = Effect.runSync(DomParser.use((parser) => parser.parseTranslatableContent(fixture)).pipe(Effect.provide(DomParser.Live)));
  preview.clear();
  preview.append(styled, styled.map(() => "译文"));
  const [title, para, result, snippet] = Array.from(fixture.querySelectorAll("open-browser-translate-placeholder"), (node) => getComputedStyle(node));
  assert(title!.fontWeight === "700" && title!.fontSize === "24px" && title!.lineHeight === "30px" && title!.fontStyle === "italic", "translation keeps the heading's font");
  assert(title!.color === "rgb(10, 20, 30)" && title!.letterSpacing === "1px" && title!.textTransform === "uppercase", "translation keeps the heading's color and text styling");
  assert(title!.borderTopWidth === "0px" && title!.backgroundColor !== "rgba(0, 0, 0, 0)", "translations get a faint background, not a border");
  assert(para!.color === "rgb(60, 60, 60)" && para!.fontSize === "15px" && !para!.textDecorationLine.includes("underline"), "mixed text follows the element holding most of the text");
  assert(result!.color === "rgb(0, 0, 200)" && result!.fontWeight === "600" && result!.textDecorationLine.includes("underline"), "a group that is all link text looks like the link");
  assert(fixture.querySelector("#snippet")!.nextElementSibling?.localName === "open-browser-translate-placeholder", "a clamped translation moves outside the clip");
  assert(snippet!.fontSize === "18px" && snippet!.fontWeight === "700" && snippet!.color === "rgb(1, 2, 3)", "a translation moved outside a clip keeps the source styles");
  preview.remove();

  // Streaming: one placeholder per item, updated in place, faded until final, discardable.
  fixture.innerHTML = '<p id="one">First streamed paragraph</p><p id="two">Second streamed paragraph</p>';
  const streamed = Effect.runSync(DomParser.use((parser) => parser.parseTranslatableContent(fixture)).pipe(Effect.provide(DomParser.Live)));
  preview.update(streamed[0]!, "第", true);
  preview.update(streamed[0]!, "第一段", true);
  const growing = fixture.querySelectorAll("#one open-browser-translate-placeholder");
  assert(growing.length === 1, "updates reuse the item's placeholder");
  assert((growing[0] as HTMLElement).dataset.streaming === "" && getComputedStyle(growing[0]!).opacity === "0.6", "streaming text is faded");
  preview.update(streamed[0]!, "第一段译文", false);
  assert(!("streaming" in (growing[0] as HTMLElement).dataset) && getComputedStyle(growing[0]!).opacity === "1", "final text is shown normally");
  preview.update(streamed[1]!, "第二", true);
  preview.discard([streamed[1]!]);
  assert(fixture.querySelector("#two open-browser-translate-placeholder") === null, "a failed batch's partial text is removed");
  preview.remove();
  assert(fixture.querySelectorAll("open-browser-translate-placeholder").length === 0, "cleanup removes streamed translations");

  // One-line sources (a contents entry inside a flex row) get their translation on the same line,
  // right after the text; multi-line paragraphs keep it as a block below.
  fixture.innerHTML = '<ul style="width:300px;list-style:none;padding:0"><li><a id="toc" href="#s1"><div style="display:flex"><span>1</span><span id="toc-text">Production and release</span></div></a></li></ul>'
    + '<p id="long">A long paragraph that certainly wraps over several lines in a column only three hundred pixels wide, so its translation belongs below it.</p>';
  const placed = Effect.runSync(DomParser.use((parser) => parser.parseTranslatableContent(fixture)).pipe(Effect.provide(DomParser.Live)));
  const tocItem = placed.find((item) => item.text.includes("Production"))!;
  const longItem = placed.find((item) => item.text.includes("A long paragraph"))!;
  preview.append([tocItem, longItem], ["制作与发行", "一段很长的译文。"]);
  const tocTranslation = fixture.querySelector("#toc-text open-browser-translate-placeholder") as HTMLElement | null;
  assert(tocTranslation !== null, "a one-line source's translation goes inside the element holding its text, not into the flex row");
  assert(getComputedStyle(tocTranslation!).display === "inline", "and flows inline after it");
  const sourceTop = (fixture.querySelector("#toc-text") as HTMLElement).getClientRects()[0]!.top;
  assert(Math.abs(tocTranslation!.getClientRects()[0]!.top - sourceTop) < 4, "starting on the same line as the source");
  const longTranslation = fixture.querySelector("#long open-browser-translate-placeholder") as HTMLElement | null;
  assert(longTranslation !== null && getComputedStyle(longTranslation).display === "block", "a multi-line paragraph keeps its translation as a block");
  preview.remove();

  // Loading: a skeleton holds each block's place until its first text arrives.
  fixture.innerHTML = '<p id="short">Short line</p><p id="para" style="width:300px">A paragraph long enough to wrap across a few lines in a narrow three hundred pixel column of text.</p>';
  const waiting = Effect.runSync(DomParser.use((parser) => parser.parseTranslatableContent(fixture)).pipe(Effect.provide(DomParser.Live)));
  preview.loading(waiting);
  const shortSkeleton = fixture.querySelector("#short open-browser-translate-placeholder") as HTMLElement;
  const paraSkeleton = fixture.querySelector("#para open-browser-translate-placeholder") as HTMLElement;
  assert(shortSkeleton?.dataset.loading === "" && shortSkeleton.getAttribute("aria-busy") === "true", "each block shows a loading placeholder");
  assert(getComputedStyle(shortSkeleton).display === "inline", "a one-line source's skeleton sits on its line");
  assert(getComputedStyle(paraSkeleton).display === "block" && paraSkeleton.getBoundingClientRect().height > 20, "a paragraph's skeleton is a block of a few lines");
  assert(shortSkeleton.getBoundingClientRect().width > 10, "the skeleton takes up space");
  assert(getComputedStyle(paraSkeleton).backgroundColor === "rgba(0, 0, 0, 0)", "a skeleton has no tint behind it");
  preview.update(waiting[0]!, "短", true);
  assert(fixture.querySelectorAll("#short open-browser-translate-placeholder").length === 1, "the first text replaces the skeleton in the same placeholder");
  assert(!("loading" in shortSkeleton.dataset) && !shortSkeleton.hasAttribute("aria-busy"), "and it stops reading as loading");
  assert(getComputedStyle(shortSkeleton).backgroundColor !== "rgba(0, 0, 0, 0)", "the tint comes with the text");
  preview.discard([waiting[1]!]);
  assert(fixture.querySelector("#para open-browser-translate-placeholder") === null, "a block that won't be translated loses its skeleton");

  // A nav button lays its label out as a flex row: the translation becomes a flex item there and,
  // squeezed, would put one Chinese character on each line.
  fixture.innerHTML = '<nav style="display:flex;width:300px;gap:8px"><button id="nav-one" style="display:flex;font:16px/24px sans-serif">Platform<b>v</b></button><button style="display:flex;font:16px/24px sans-serif">Solutions<b>v</b></button><button style="display:flex;font:16px/24px sans-serif">Resources<b>v</b></button></nav>';
  const nav = Effect.runSync(DomParser.use((parser) => parser.parseTranslatableContent(fixture)).pipe(Effect.provide(DomParser.Live)));
  for (const item of nav) preview.update(item, "解决方案", false);
  const navTranslation = fixture.querySelector("#nav-one open-browser-translate-placeholder") as HTMLElement;
  // Four characters at 16px on one line; squeezed, it would be one character (16px) wide. Its height
  // is the row's, as flex items stretch.
  assert(navTranslation?.dataset.nowrap === "" && navTranslation.getBoundingClientRect().width >= 60, "a translation inside a flex row stays on one line");

  // A one-line block ending in a link: the translation follows the link rather than joining it.
  fixture.innerHTML = '<p id="ends-in-link" style="width:600px;font:16px/24px sans-serif">Read the <a id="guide" href="#">guide</a></p>';
  const linked = Effect.runSync(DomParser.use((parser) => parser.parseTranslatableContent(fixture)).pipe(Effect.provide(DomParser.Live)));
  preview.update(linked[0]!, "阅读指南", false);
  const afterLink = fixture.querySelector("#ends-in-link > open-browser-translate-placeholder");
  assert(afterLink !== null && afterLink.previousElementSibling?.id === "guide" && !fixture.querySelector("#guide open-browser-translate-placeholder"), "the translation sits after the link, outside it");
  // A one-line block ending in inline code: the translation follows the code rather than joining it.
  fixture.innerHTML = '<p id="ends-in-code" style="width:600px;font:16px/24px sans-serif">Then run <code id="command">claude --version</code></p>';
  const coded = Effect.runSync(DomParser.use((parser) => parser.parseTranslatableContent(fixture)).pipe(Effect.provide(DomParser.Live)));
  assert(coded.length === 1 && coded[0]!.text === "Then run claude --version", "the sentence and its code are one group");
  preview.update(coded[0]!, "然后运行 claude --version", false);
  const afterCode = fixture.querySelector("#ends-in-code > open-browser-translate-placeholder");
  assert(afterCode !== null && afterCode.previousElementSibling?.id === "command", "the translation sits after the code, outside it");
  // A one-line block ending in an inline box (a badge): the translation follows the box rather than joining it.
  fixture.innerHTML = '<p id="ends-in-badge" style="width:600px;font:16px/24px sans-serif">This feature is <span id="badge" style="display:inline-block;padding:0 4px;border:1px solid"><b>beta</b></span></p>';
  const badged = Effect.runSync(DomParser.use((parser) => parser.parseTranslatableContent(fixture)).pipe(Effect.provide(DomParser.Live)));
  assert(badged.length === 1, "the sentence and its badge are one group");
  preview.update(badged[0]!, "此功能为测试版", false);
  const afterBadge = fixture.querySelector("#ends-in-badge > open-browser-translate-placeholder");
  assert(afterBadge !== null && afterBadge.previousElementSibling?.id === "badge", "the translation sits after the badge, outside it");
  // Under a tall line-height, an inline translation's tint fills its line, as a block translation's does.
  fixture.innerHTML = '<p id="tall" style="width:600px;font:16px/40px sans-serif">One short line</p>';
  const tall = Effect.runSync(DomParser.use((parser) => parser.parseTranslatableContent(fixture)).pipe(Effect.provide(DomParser.Live)));
  preview.update(tall[0]!, "短短一行", false);
  const tallRect = fixture.querySelector("#tall > open-browser-translate-placeholder")!.getClientRects()[0]!;
  assert(Math.abs(tallRect.height - 40) < 1, `an inline translation's tint is as tall as its line (${tallRect.height}px)`);
  preview.remove();
  document.body.textContent = "PASS: clipped placeholders, multiple groups, normal placement, recapture, cleanup, source styles, streaming, inline after one-line sources, loading skeleton, flex rows, links, inline code, inline boxes, tint height";
} catch (error) {
  preview.remove();
  document.body.textContent = `FAIL: ${String(error)}`;
}
