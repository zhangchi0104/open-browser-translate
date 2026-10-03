# Open Browser Translate

A browser extension that translates the page you're reading in place, content near the viewport first, with models you configure.

## Language

### The page

**Block**:
A piece of page text translated as one unit, such as a paragraph, heading or link, with the tag it came from.
_Avoid_: group, source group, segment (a segment is one text node inside a block)

**Site**:
The origin of an http or https page. Cached translations and site context belong to a site. A page with no site (private windows, browser pages) keeps neither.
_Avoid_: origin, context key, domain

**Session**:
Everything that follows one click on the launcher: planning the page, then analyzing and translating its blocks as the reader scrolls, until the next click.

### Deciding what to translate

**Plan**:
The page-level decision of the mode and how the page is organized (single, paginated or dynamic).

**Mode**:
Whether a page's interface text is translated (`all`) or only its main reading content (`main`).
_Avoid_: scope

**Analysis**:
Classifying each block's role on the page, which decides whether it is translated and its priority.
_Avoid_: classification, content analysis (as a noun for the result)

**Priority**:
When a block is translated relative to others: reading content first, then interface text, ads last.

**Fallback**:
A decision taken without a confident model answer: a plan that defaults to `all`, or a block kept at unsure priority.

### Translating

**Batch**:
Up to eight blocks sent together for analysis or translation.

**Site context**:
What earlier translations on a site leave for later batches: recent page titles, the glossary, and recent passages.
_Avoid_: carryover (that's how it travels, not what it is), translation context

**Glossary**:
The renderings of terms a site's earlier translations chose, reused so a term reads the same across pages.
_Avoid_: terms (a batch reports terms; the glossary keeps the accepted ones)

**Final**:
A block's translation that won't change: one served from the cache, or one from a batch that passed validation. Text still streaming in isn't final.
