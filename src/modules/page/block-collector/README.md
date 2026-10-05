# Block collector

```ts
import { Effect } from "effect";
import { DomParser } from "@/modules/page/block-collector";

const program = Effect.gen(function* () {
  const parser = yield* DomParser;
  const content = yield* parser.parseTranslatableContent();
  return content.map(({ text }) => text);
});

vide(DomParser.Live)));
```

`DomParser` is an Effect service; `DomParser.Live` provides the browser
implementation. `parseTranslatableContent(root?)` returns a lazy Effect and
defaults to `document.body` at execution time. Each execution reads a fresh DOM
snapshot, even when reusing the same Effect. Importing the module or constructing
the layer does not access the DOM. Unexpected DOM exceptions are Effect defects.
Tests can substitute an implementation with `Layer.succeed(DomParser, ...)`.

Returns text groups in DOM order without modifying the page. Inline descendants
such as emphasis and links stay together; block layout boundaries, buttons,
line breaks, and excluded subtrees end a group. An inline box (`inline-block`,
`inline-flex`: a badge, a styled link) joins the group when words sit right
before or after it; otherwise, like nav entries, it is a group of its own. For example,
`<p>These are results for <b>translation</b> <i>text</i></p>` becomes one item
with `text: "These are results for translation text"`.

Each item contains its enclosing `element`, combined `text`, and ordered
`segments: { node: Text, text: string }[]`. Segments preserve the exact source
text, including whitespace, punctuation, and numbers. Before applying an
asynchronous result, verify that every node is still connected and unchanged.
The enclosing element can own several groups; replacing its `textContent`
would destroy markup. Mapping a translated group back across inline markup
is the translation renderer's responsibility.

Skips scripts, styles, code blocks, form inputs, editable content, non-HTML
content, the extension UI, and subtrees marked `translate="no"`, `.notranslate`,
`hidden`, or `aria-hidden="true"`. These subtree exclusions also apply to an
explicit root and its ancestors; a nested `translate="yes"` does not re-enable
an excluded subtree. A group must contain at least one Unicode letter.

Computed styles exclude `display: none`, `content-visibility: hidden`, zero
opacity, and hidden/collapsed text. Clipped elements no larger than one CSS
pixel in either dimension are treated as hidden helper text. Elements that
aren't rendered (these, and `[hidden]`) are skipped without ending the group,
so a link's screen-reader-only "(opens in a new window)" doesn't split the
sentence around it. Inline excluded elements don't split it either: inline
`code`/`kbd`/`samp`/`math`, `aria-hidden`, `translate="no"` and `.notranslate`
text is kept in the group's text and segments (for the model to keep as is),
inline `svg`/`canvas` are skipped. A group of only such kept text isn't
returned. Code blocks, inputs, and other block-level exclusions end the group. This is a
heuristic, not a full clipping or occlusion test. Below-the-fold content remains
eligible. Requires a browser document.

Only light-DOM text is read: attributes, input values, shadow roots, and iframe
documents are not extracted. Navigation and visible controls remain eligible;
this is not an article-only extractor or a linguistic sentence tokenizer.
Run the Effect again after page changes to collect current content.
