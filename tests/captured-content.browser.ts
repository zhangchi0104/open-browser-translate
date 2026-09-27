import { Effect } from "effect";
import { DomParser } from "../src/modules/dom-parser";
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
  document.body.textContent = "PASS: clipped placeholders, multiple groups, normal placement, recapture, cleanup";
} catch (error) {
  preview.remove();
  document.body.textContent = `FAIL: ${String(error)}`;
}
