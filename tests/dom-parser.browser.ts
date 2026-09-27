import { Effect } from "effect";
import { DomParser } from "../src/modules/dom-parser";

const fixture = document.createElement("main");
document.body.append(fixture);
const parse = () => Effect.runSync(
  DomParser.use((parser) => parser.parseTranslatableContent(fixture)).pipe(
    Effect.provide(DomParser.Live),
  ),
);
let passed = 0;

function check(name: string, html: string, expected: string[]) {
  fixture.innerHTML = html;
  const before = fixture.innerHTML;
  const content = parse();
  const actual = content.map((item) => item.text);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${name}: ${JSON.stringify(actual)}`);
  }
  if (fixture.innerHTML !== before) throw new Error(`${name}: mutated DOM`);
  for (const item of content) {
    if (item.segments.map((segment) => segment.text).join("") !== item.text
      || item.segments.some(({ node, text }) => !node.isConnected || node.data !== text)
      || item.segments.some(({ node }) => !item.element.contains(node))) {
      throw new Error(`${name}: invalid source mapping`);
    }
  }
  passed++;
}

try {
  check("inline sentence", "<p>These are results for <b>translation</b> <i>text</i></p>", ["These are results for translation text"]);
  check("punctuation and numbers", "<p>There are <b>42</b> results<span>!</span></p>", ["There are 42 results!"]);
  check("paragraph boundaries", "<div>Before<p>Inside <a href='#'>a link</a>.</p>After</div>", ["Before", "Inside a link.", "After"]);
  check("line breaks", "<p>First<br>Second</p>", ["First", "Second"]);
  check("no synthetic CJK spaces", "<p>这是<b>中文</b>内容。</p>", ["这是中文内容。"]);
  check("excluded subtrees", '<p>Hello</p><pre>code</pre><div contenteditable>draft</div><div translate="no">excluded</div><p hidden>hidden</p><p style="display:none">hidden</p>', ["Hello"]);
  check("clipped helper", '<a style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)">Skip to main content</a><p>Content</p>', ["Content"]);
  check("visibility override", '<div style="visibility:hidden">hidden<span style="visibility:visible">Visible</span></div>', ["Visible"]);
  check("below viewport", '<p style="margin-top:200vh">Below fold</p>', ["Below fold"]);
  check("standalone symbols", '<p>123 !</p><p>Text</p>', ["Text"]);
  check("separate controls", '<div><button>First</button><button>Second</button></div>', ["First", "Second"]);
  check("excluded inline boundary", '<p>Before <code>code</code> after</p>', ["Before ", " after"]);
  document.body.textContent = `PASS: ${passed} DOM parser browser cases`;
} catch (error) {
  document.body.textContent = `FAIL: ${String(error)}`;
}
