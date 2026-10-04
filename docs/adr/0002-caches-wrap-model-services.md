---
status: accepted
---

# Caches wrap the model services; the dispatcher never touches them

The translation cache sits inside `TranslationService` as a read-through layer around the model: cached blocks come back at once, only the rest reach the model, and its results are written back. Analysis gets the same layer around its decision model, keyed by site and block text, so a site's repeated navigation and footers aren't classified again. The layer and the model are built from the same model configuration, so a cache entry is always keyed by the model that wrote it, even if the settings change while a batch is in flight. Settings are read once per request, and only to build these services: `ContentAnalyzer` and `TranslationDispatcher` never read them.

## Considered options

- **The dispatcher reads the cache when a batch arrives and writes it after translating.** Hits return immediately, but the dispatcher has to work out the cache key's model from the settings on its own, and that can drift from the model that actually translated the batch.
- **The service owns the cache but is only called when a batch reaches the front of a background queue.** Cached batches wait behind uncached ones. ADR-0001 removes that queue, so it no longer applies.
