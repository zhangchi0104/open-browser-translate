# Translation flow

The launcher captures source groups, then asks the analysis model for a page-level plan using
bounded text samples, title, article presence, and pagination labels. High
confidence selects `all` (ordinary webpages) or `main` (reading content only).
Uncertain or failed planning defaults to `all` and reports fallback.

Each batch of up to eight groups is sent to the background. `ContentAnalyzer`
classifies with the selected scope; `Translator` sends retained texts to the
independently configured translation provider using Effect `LanguageModel`.
The current target language is Simplified Chinese.

Translation uses schema-validated structured output with one ID per retained
block. Missing, duplicate, unknown IDs and empty translations fail the batch.
Results are reordered by ID before being mapped to original DOM groups. Text is
rendered with `textContent` in isolated placeholders, never as HTML. Original
source nodes remain unchanged; changed or disconnected sources are skipped.

Each completed batch is appended immediately. A failed translation batch leaves
its source untouched and increments the failure count; other batches continue.
The batch has a 45-second total timeout and no automatic retries. Missing
analysis or translation configuration stops before provider calls.

Translation is viewport-first. After a click, only blocks within half a screen
above and 1.5 screens below the viewport are queued, nearest first
(`src/modules/viewport-queue`). Scrolling or resizing picks the next batch, and
content added later (infinite scroll, load more) joins the same queue. Content
that is never scrolled near is never sent to the provider.

The analysis model also classifies navigation as single, paginated, or dynamic. Following
pagination links and translating other tabs are not wired up.

Context carries across viewport batches and pages on the same site
(`src/modules/translation-context`). The background keeps one context per
origin in extension storage: the last five page titles, a glossary of terms the
model reported translating (newest rendering wins, at most 60), and the last
three translated passages. Each batch is sent with the page titles, the recent
passages, and only the glossary terms that occur in that batch. Glossary terms
are kept only if their source text appears in the batch they came from.
Contexts expire after seven days, at most 50 sites are kept, and private
windows keep none.

Validation: `bun test tests/translation.test.ts tests/viewport-queue.test.ts tests/translation-context.test.ts`. Tests use mocked HTTP responses;
they verify decision/translation routing and output alignment, not live quality.
