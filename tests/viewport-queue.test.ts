import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createBatchQueue, pickByPriority, pickNearViewport, viewportDistance, type Span } from "../src/modules/viewport-queue";

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

function deferred() {
  let resolve!: (keepGoing: boolean) => void;
  const promise = new Promise<boolean>((done) => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the queue keeps up to `limit` batches in flight and refills as each finishes", async () => {
  const work = [1, 2, 3, 4, 5];
  const running = new Map<number, ReturnType<typeof deferred>>();
  const states: string[] = [];
  let maxInFlight = 0;
  const queue = createBatchQueue<number>({
    limit: 3,
    next: () => work.shift(),
    run: (batch) => {
      const task = deferred();
      running.set(batch, task);
      maxInFlight = Math.max(maxInFlight, running.size);
      return task.promise.finally(() => running.delete(batch));
    },
    onChange: (count) => states.push(count ? `busy ${count}` : "idle"),
  });
  const drained = queue.drain();
  await tick();
  assert.deepEqual([...running.keys()], [1, 2, 3], "three batches start at once");
  running.get(2)!.resolve(true);
  await tick();
  assert.deepEqual([...running.keys()], [1, 3, 4], "a finished batch is replaced right away");
  for (const batch of [1, 3, 4]) running.get(batch)!.resolve(true);
  await tick();
  running.get(5)!.resolve(true);
  await tick();
  assert.equal(maxInFlight, 3);
  assert.equal(states.at(-1), "idle", "with nothing left near the viewport the queue goes idle");

  work.push(6);
  queue.nudge();
  await tick();
  assert.deepEqual([...running.keys()], [6], "a nudge (scroll, new content) picks up new work");
  running.get(6)!.resolve(true);
  queue.stop();
  await drained;
});

test("a batch that returns false stops the queue, and a failed batch doesn't", async () => {
  const work = [1, 2, 3, 4];
  const started: number[] = [];
  const queue = createBatchQueue<number>({
    limit: 1,
    next: () => work.shift(),
    run: async (batch) => {
      started.push(batch);
      if (batch === 1) throw new Error("network");
      return batch !== 2;
    },
    onChange: () => {},
  });
  await queue.drain();
  assert.deepEqual(started, [1, 2], "a thrown batch continues; returning false (not configured) stops");
});

test("translation batches take higher-priority content first; distance only breaks ties", () => {
  const items = [
    { id: "nav", span: at(10), priority: 2 },
    { id: "ad", span: at(60), priority: 3 },
    { id: "body-far", span: at(1300), priority: 0 },
    { id: "body-near", span: at(300), priority: 0 },
    { id: "unsure", span: at(200), priority: 1 },
    { id: "body-offscreen", span: at(5000), priority: 0 },
  ];
  const picked = pickByPriority(items, ({ span }) => span, ({ priority }) => priority, HEIGHT, 4).map(({ id }) => id);
  assert.deepEqual(picked, ["body-near", "body-far", "unsure", "nav"], "content first, nearest first within a priority, nothing outside the window");
});
