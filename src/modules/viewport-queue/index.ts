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
