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
type Side = "left" | "right";
/** Where the reader left the launcher: the side it's docked to, and its top before clamping. */
interface Dock {
  side: Side;
  y: number;
}
// Saved as `{ x, y }` before the launcher remembered its side; `x` then gives the side.
const ballPosition = storage.defineItem<{ side?: Side; x?: number; y?: number }>("local:ballPosition");

// The visible area without the page's scrollbars: `innerWidth` includes a classic scrollbar,
// which would cover a launcher placed against the right edge.
const viewportWidth = () => document.documentElement.clientWidth || window.innerWidth;
const viewportHeight = () => document.documentElement.clientHeight || window.innerHeight;
// Kept EDGE_MARGIN from every edge, clear of overlay scrollbars too; this also pulls in
// positions saved flush against an edge.
const clampX = (x: number) => Math.min(Math.max(x, EDGE_MARGIN), Math.max(EDGE_MARGIN, viewportWidth() - BALL_SIZE - EDGE_MARGIN));
const clampY = (y: number) => Math.min(Math.max(y, EDGE_MARGIN), Math.max(EDGE_MARGIN, viewportHeight() - LAUNCHER_HEIGHT - EDGE_MARGIN));
const sideOf = (x: number): Side => x + BALL_SIZE / 2 < viewportWidth() / 2 ? "left" : "right";

/**
 * Where the launcher sits: bottom right at first, then wherever the reader drags it, docked to the
 * nearer side and remembered across pages. It's placed from the side and height on every resize,
 * so it stays against its edge as the window changes, and a window shrunk and grown back puts it
 * where it was. `onDragStart` runs once a press turns into a drag.
 */
export function useLauncherPosition(onDragStart: () => void) {
  const [dock, setDock] = useState<Dock>({ side: "right", y: Infinity });
  // Where the launcher is while it's being dragged; it docks again on release.
  const [dragAt, setDragAt] = useState<BallPosition>();
  // Bumped on resize, so the position is worked out again for the new viewport.
  const [viewport, setViewport] = useState(0);
  const drag = useRef<{ startX: number; startY: number; originX: number; originY: number; moved: boolean } | undefined>(undefined);
  // Set when a drag ends, so the click that follows the release isn't taken as a click.
  const dragged = useRef(false);

  useEffect(() => {
    let current = true;
    ballPosition.getValue().then((saved) => {
      if (!current || !saved || typeof saved.y !== "number") return;
      const side = saved.side ?? (typeof saved.x === "number" ? sideOf(saved.x) : undefined);
      if (side) setDock({ side, y: saved.y });
    }).catch(() => {});
    const onResize = () => setViewport((count) => count + 1);
    window.addEventListener("resize", onResize);
    return () => {
      current = false;
      window.removeEventListener("resize", onResize);
    };
  }, []);

  // Worked out when the launcher moves or the viewport changes, not on every render: reading the
  // viewport forces layout.
  const position = useMemo<BallPosition>(
    () => dragAt
      ? { x: clampX(dragAt.x), y: clampY(dragAt.y) }
      : { x: clampX(dock.side === "left" ? 0 : Infinity), y: clampY(dock.y) },
    [dock, dragAt, viewport],
  );
  const onRight = useMemo(() => dragAt ? sideOf(position.x) === "right" : dock.side === "right", [dock.side, dragAt, position.x]);

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
      setDragAt({ x: state.originX + dx, y: state.originY + dy });
    },
    onPointerUp() {
      const state = drag.current;
      drag.current = undefined;
      if (!state?.moved) return;
      dragged.current = true;
      // Dock to the nearer side once released.
      const next: Dock = { side: sideOf(position.x), y: position.y };
      setDock(next);
      setDragAt(undefined);
      void ballPosition.setValue(next).catch(() => {});
    },
  };

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
