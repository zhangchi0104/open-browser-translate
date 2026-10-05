import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { storage } from "wxt/utils/storage";

/** The launcher's button and the settings button below it, in px; the markup in Launcher.tsx matches. */
const BALL_SIZE = 44;
const LAUNCHER_HEIGHT = 82;
const EDGE_MARGIN = 16;
const DRAG_THRESHOLD = 4;

interface BallPosition {
  x: number;
  y: number;
}
const ballPosition = storage.defineItem<BallPosition>("local:ballPosition");

// The visible area without the page's scrollbars: `innerWidth` includes a classic scrollbar,
// which would cover a launcher placed against the right edge.
const viewportWidth = () => document.documentElement.clientWidth || window.innerWidth;
const viewportHeight = () => document.documentElement.clientHeight || window.innerHeight;
// Kept EDGE_MARGIN from every edge, clear of overlay scrollbars too; this also pulls in
// positions saved flush against an edge.
const clampX = (x: number) => Math.min(Math.max(x, EDGE_MARGIN), Math.max(EDGE_MARGIN, viewportWidth() - BALL_SIZE - EDGE_MARGIN));
const clampY = (y: number) => Math.min(Math.max(y, EDGE_MARGIN), Math.max(EDGE_MARGIN, viewportHeight() - LAUNCHER_HEIGHT - EDGE_MARGIN));

/**
 * Where the launcher sits: bottom right at first, then wherever the reader drags it, snapped to the
 * nearer side and remembered across pages. `onDragStart` runs once a press turns into a drag.
 */
export function useLauncherPosition(onDragStart: () => void) {
  const [position, setPosition] = useState<BallPosition>(() => ({ x: clampX(Infinity), y: clampY(Infinity) }));
  const drag = useRef<{ startX: number; startY: number; originX: number; originY: number; moved: boolean } | undefined>(undefined);
  // Set when a drag ends, so the click that follows the release isn't taken as a click.
  const dragged = useRef(false);

  useEffect(() => {
    let current = true;
    ballPosition.getValue().then((saved) => {
      if (current && saved && typeof saved.x === "number" && typeof saved.y === "number") setPosition({ x: clampX(saved.x), y: clampY(saved.y) });
    }).catch(() => {});
    const onResize = () => setPosition((at) => ({ x: clampX(at.x), y: clampY(at.y) }));
    window.addEventListener("resize", onResize);
    return () => {
      current = false;
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const handlers = {
    onPointerDown(event: PointerEvent<HTMLElement>) {
      drag.current = { startX: event.clientX, startY: event.clientY, originX: position.x, originY: position.y, moved: false };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      const state = drag.current;
      if (!state) return;
      const dx = event.clientX - state.startX;
      const dy = event.clientY - state.startY;
      // Only a move past the threshold is a drag, so a click with a slight wobble stays a click.
      if (!state.moved && Math.abs(dx) <= DRAG_THRESHOLD && Math.abs(dy) <= DRAG_THRESHOLD) return;
      if (!state.moved) onDragStart();
      state.moved = true;
      setPosition({ x: clampX(state.originX + dx), y: clampY(state.originY + dy) });
    },
    onPointerUp() {
      const state = drag.current;
      drag.current = undefined;
      if (!state?.moved) return;
      dragged.current = true;
      // Snap to the nearer side once released.
      setPosition((at) => {
        const next = { x: clampX(at.x + BALL_SIZE / 2 < viewportWidth() / 2 ? 0 : Infinity), y: at.y };
        void ballPosition.setValue(next).catch(() => {});
        return next;
      });
    },
  };

  // Read when the launcher moves, not on every render: the viewport width forces layout.
  const onRight = useMemo(() => position.x + BALL_SIZE / 2 > viewportWidth() / 2, [position.x]);

  return {
    position,
    /** Whether the launcher sits on the right half, so panels open toward the page. */
    onRight,
    handlers: { ...handlers, onPointerCancel: handlers.onPointerUp },
    /** True once for the click that ends a drag. */
    consumeDrag() {
      const was = dragged.current;
      dragged.current = false;
      return was;
    },
  };
}
