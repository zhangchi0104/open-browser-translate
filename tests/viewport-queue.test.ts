import { strict as assert } from "node:assert";
import { test } from "node:test";
import { pickNearViewport, viewportDistance, type Span } from "../src/modules/viewport-queue";

const HEIGHT = 1000;
const at = (top: number, height = 50): Span => ({ top, bottom: top + height });
const pick = (spans: (Span | null)[], limit = 8) =>
  pickNearViewport(spans.map((span, id) => ({ id, span })), ({ span }) => span, HEIGHT, limit).map(({ id }) => id);

test("distance is zero inside the viewport and grows outside it", () => {
  assert.equal(viewportDistance(at(100), HEIGHT), 0);
  assert.equal(viewportDistance(at(980), HEIGHT), 0);
  assert.equal(viewportDistance(at(1300), HEIGHT), 300);
  assert.equal(viewportDistance(at(-250), HEIGHT), 200);
});

test("visible items come first in document order, then the read-ahead buffer", () => {
  assert.deepEqual(pick([at(1800), at(100), at(1200), at(500)]), [1, 3, 2, 0]);
});

test("items beyond the read-ahead window or far above stay pending", () => {
  assert.deepEqual(pick([at(2600), at(-800), at(2400), at(-400)]), [3, 2]);
});

test("unrendered items are skipped and the batch size is respected", () => {
  assert.deepEqual(pick([null, at(0), at(60), at(120), null], 2), [1, 2]);
});
