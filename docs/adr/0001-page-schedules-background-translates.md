---
status: accepted
---

# The page schedules batches; the background translates them without a queue

The page keeps the queue of blocks waiting to be translated and sends a batch whenever fewer than N are in flight (two or three to start), picking by priority and distance from the viewport at that moment. The background translates each batch as it arrives and keeps no queue of its own. Ordering needs what only the page knows (where blocks are, what scrolled into view, whether the reader stopped), so a queue in the background could neither reorder on scroll nor drop work on stop without a cancel round trip.

Batches don't wait for each other's translations. Consistency comes from context that is ready before a batch starts: the preceding text and the page brief it carries from the page, and a snapshot of the site context. Each finished batch folds its terms back into the site context, so later batches see them. Two batches in flight at once can't see the terms the other picks. Within a batch, blocks stay in priority order rather than document order, so visible content streams first.

Analysis also runs in the background: content scripts are bound by the page's CORS and shouldn't hold API keys or the ChatGPT token. The page only collects blocks and applies the result.

The page brief is collected from the page itself (title, meta description, first heading) rather than written by the analysis model: the default analysis model (Jev on the Vercel AI Gateway) answers classification questions and can't write text, and the page's own words are available before the first batch with no extra model call.

## Considered options

- **A FIFO queue in the background, one batch at a time, each passing its updated context to the next.** Best continuity between neighbouring batches, but a page is translated one model call at a time (about 2.5 minutes for 30 batches at 5 s each), and the queue can't follow the reader's scrolling.
