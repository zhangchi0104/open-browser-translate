# Translation service

`createTranslationService(cache)` is the read-through translation cache in front
of the model (ADR-0002): `translate(blocks, { site, context, onBlock })` sends
cached blocks to `onBlock` at once and final, translates only the rest with
`translateBatch`, and caches a successful result. The cache key's model comes
from the request's settings, the same ones the model is built from. The rest of
this file describes the translation flow end to end.

The launcher captures source groups, then asks the analysis model for a page-level plan using
bounded text samples, title, article presence, and pagination labels. High
confidence selects `all` (ordinary webpages) or `main` (reading content only).
Uncertain or failed planning defaults to `all` and reports fallback.

Analysis runs ahead of translation. The launcher sends nearby groups to the
background in batches of up to eight (`analyze-content`); `ContentAnalyzer`
classifies each group's role with the selected scope, which decides whether it
is translated and its priority (`TRANSLATION_PRIORITY`): reading content 0,
unsure 1, controls and navigation 2, auxiliary text and ads 3. A role below the
confidence threshold counts as unsure, so possible content isn't pushed back.
Translation batches take the highest-priority analyzed groups near the
viewport, distance only breaking ties, and wait until everything on screen has
been analyzed so visible navigation doesn't go before visible content. Only
blocks analysis chose to translate are sent, and `translateBatch` translates
exactly those: `Translator` sends them to the independently configured
translation provider using Effect `LanguageModel`, and the result has one
translation per block.
The current target language is Simplified Chinese.

Translation uses schema-validated structured output with one ID per retained
block. Missing, duplicate, unknown IDs and empty translations fail the batch.
Results are reordered by ID before being mapped to original DOM groups. Text is
rendered with `textContent` in isolated placeholders, never as HTML. Each
placeholder copies the text styles (font, size, weight, line height, color,
spacing, decoration) of the element holding most of the source text, so the
translation reads like the original. A translation of text that fits on one line
(links, headings, contents entries, buttons) follows it inline on the same
line, inserted right after the text node so it flows with the text even inside
flex layouts; text spanning several lines gets its translation as a block below. Original
source nodes remain unchanged; changed or disconnected sources are skipped.

Translations stream onto the page. The launcher sends each batch over the
`translate-stream` port (`../../shared/protocol`); the background runs it through
`translatePageBatch` (`../translation-dispatcher`), which calls the service, and `translateBatch` passes `onPartial`,
and the Translator then uses `streamText` instead of `generateObject`, since
Effect can't stream structured output. The prompt spells out the same JSON
shape, `partial-json.ts` reads the half-written JSON as it arrives, and each
block's text so far is posted as `{ type: "block", index, text, final: false }`
(cached blocks arrive at once with `final: true`). While a
batch waits for its first text, each block shows a loading skeleton in its
placeholder: shimmering bars in a faint version of the text color, one short bar
after one-line text and up to three for paragraphs, static when reduced motion
is preferred. The page
shows it faded in the block's placeholder and updates it in place. When the
stream ends the whole response must parse and pass the same checks as before;
the final `{ type: "result" }` then makes the text normal, or a failed batch
removes its partial text. Content analysis still waits for its full response.

A failed translation batch leaves its source untouched and increments the
failure count; blocks it served from the cache stay, and other batches continue.
The batch has a 45-second total timeout and no automatic retries. Missing
analysis or translation configuration stops before provider calls.

Translation is viewport-first. After a click, only blocks within half a screen
above and 1.5 screens below the viewport are queued, nearest first
(`src/modules/page/batch-scheduler/viewport.ts`). Scrolling or resizing picks the next batch, and
content added later (infinite scroll, load more) joins the same queue. Content
that is never scrolled near is never sent to the provider.

Up to three batches are translated at once (`createBatchQueue`,
`MAX_CONCURRENT_BATCHES`): when one finishes, the next nearest batch starts, so
a page doesn't wait for batches one after another. Batches running together
each see the site context as it was when they started; terms one of them
learns reach later batches, not its siblings.

The analysis model also classifies navigation as single, paginated, or dynamic. Following
pagination links and translating other tabs are not wired up.

Context carries across viewport batches and pages on the same site
(`src/modules/background/site-context`). The background keeps one context per
origin in extension storage: the last five page titles, a glossary of terms the
model reported translating (newest rendering wins, at most 60), and the last
three translated passages. Each batch is sent with the page titles, the recent
passages, and only the glossary terms that occur in that batch, plus what the
page sends about where the batch sits: the page brief (its title, meta
description and first heading) and the preceding text (up to 600 characters of
source just before the batch's first block, skipping blocks analysis dropped).
Pages without a site still send those two. Glossary terms
are kept only if their source text appears in the batch they came from.
Contexts expire after seven days, at most 50 sites are kept, and private
windows keep none.

Scheduling lives in `../../page/batch-scheduler`. Validation: `bun test tests/translation-service.test.ts tests/batch-scheduler.test.ts tests/viewport.test.ts tests/site-context.test.ts`. Tests use mocked HTTP responses;
they verify decision/translation routing and output alignment, not live quality.
