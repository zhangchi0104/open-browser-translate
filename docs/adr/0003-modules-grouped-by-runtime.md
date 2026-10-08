---
status: accepted
---

# Modules are grouped by where they run

`src/modules/` has three groups: `page/` for what runs in the content script (`block-collector`, `batch-scheduler`, `site-works`), `background/` for what runs in the service worker (`content-analyzer`, `translation-dispatcher`, `translation-service`, `cache-store`, `site-context`, `ai`), and `shared/` for what both sides use (`protocol`, `settings`, `stored-value`, `debug-log`). `page/` imports only `shared/`; `background/` imports `shared/` and itself; the options page, an extension page outside the web page's CORS, may import either. A test checks these imports.

The split ADR-0001 draws between page and background is a security boundary as much as a design one: content scripts are bound by the page's CORS and shouldn't hold API keys or the ChatGPT token. With flat modules, nothing stopped the page from importing `ai` by accident. Grouping by runtime makes such an import visible in review and lets the test reject it.

## Considered options

- **Flat `src/modules/<name>`, as before.** Fewer moves, but the page/background boundary lives only in reviewers' heads.
- **Grouping by feature (analysis, translation).** Each feature spans both sides, so every feature folder would mix code that may hold keys with code that must not.
