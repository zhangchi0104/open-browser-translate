# Translation flow

The launcher captures source groups, then asks Jev for a page-level plan using
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

Jev also classifies navigation as single, paginated, or dynamic. This currently
provides a decision only: following pagination links, translating other tabs,
and observing infinite-scroll content are not wired up pending scope selection.

Validation: `bun test tests/translation.test.ts`. Tests use mocked HTTP responses;
they verify decision/translation routing and output alignment, not live quality.
