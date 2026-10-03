export interface Span {
  top: number;
  bottom: number;
}

// Translate this far past the viewport so normal scrolling never meets source text.
export const LOOKAHEAD_SCREENS = 1.5;
// Keep a little above the viewport too, for readers who scroll back up.
export const LOOKBEHIND_SCREENS = 0.5;

/** Pixels between a span and the viewport; 0 when they overlap. */
export function viewportDistance(span: Span, viewportHeight: number) {
  if (span.bottom < 0) return -span.bottom;
  if (span.top > viewportHeight) return span.top - viewportHeight;
  return 0;
}

/**
 * Picks up to `limit` items inside the translation window, nearest to the
 * viewport first. Items without a span (detached or not rendered) are skipped.
 */
export function pickNearViewport<T>(
  pending: readonly T[],
  spanOf: (item: T) => Span | null,
  viewportHeight: number,
  limit: number,
): T[] {
  const above = -LOOKBEHIND_SCREENS * viewportHeight;
  const below = viewportHeight + LOOKAHEAD_SCREENS * viewportHeight;
  const near: { item: T; distance: number }[] = [];
  for (const item of pending) {
    const span = spanOf(item);
    if (!span || span.bottom < above || span.top > below) continue;
    near.push({ item, distance: viewportDistance(span, viewportHeight) });
  }
  // Array sort is stable, so equally near items keep document order.
  return near.sort((a, b) => a.distance - b.distance).slice(0, limit).map(({ item }) => item);
}

/** How many batches the launcher translates at once. */
export const MAX_CONCURRENT_BATCHES = 3;

/**
 * Runs batches with up to `limit` in flight, taking the next one from `next` (the nearest
 * pending content) whenever a slot frees up. With nothing near the viewport it waits for
 * `nudge` (scrolling, resizing, new content). A batch resolving to `false` stops the queue,
 * e.g. when translation isn't configured; one that throws counts as finished.
 */
export function createBatchQueue<T>(options: {
  limit: number;
  next: () => T | undefined;
  run: (batch: T) => Promise<boolean>;
  onBusy: (inFlight: number) => void;
  onIdle: () => void;
}) {
  let wake: (() => void) | undefined;
  let stopped = false;
  const nudge = () => {
    const resolve = wake;
    wake = undefined;
    resolve?.();
  };
  return {
    nudge,
    stop() {
      stopped = true;
      nudge();
    },
    /** Resolves once `active` turns false or a batch stops the queue; batches still in flight are left to finish. */
    async drain(active: () => boolean) {
      const inFlight = new Set<Promise<void>>();
      const fill = () => {
        while (inFlight.size < options.limit) {
          const batch = options.next();
          if (batch === undefined) return;
          const task: Promise<void> = new Promise<boolean>((resolve) => resolve(options.run(batch)))
            .then((keepGoing) => { if (!keepGoing) stopped = true; }, () => {})
            .finally(() => {
              inFlight.delete(task);
              nudge();
            });
          inFlight.add(task);
        }
      };
      while (active() && !stopped) {
        fill();
        if (inFlight.size) options.onBusy(inFlight.size);
        else options.onIdle();
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    },
  };
}
