import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createStoredValue } from "../src/modules/stored-value";

function memoryStore(initial: unknown = undefined) {
  let saved = initial;
  const calls = { get: 0, set: 0 };
  let failNext = false;
  return {
    get: async () => { calls.get++; return saved; },
    set: async (value: number[]) => {
      calls.set++;
      if (failNext) { failNext = false; throw new Error("quota exceeded"); }
      saved = value;
    },
    saved: () => saved,
    calls,
    failNextWrite: () => { failNext = true; },
  };
}
const unexpected = (error: unknown) => assert.fail(`unexpected write error: ${String(error)}`);
const numbers = (stored: unknown) => Array.isArray(stored) ? stored as number[] : [];

test("concurrent updates land in order, share writes, and read the store only once", async () => {
  const store = memoryStore([0]);
  const value = createStoredValue(store, { parse: numbers, onError: unexpected });
  const done = Array.from({ length: 5 }, (_, index) => value.update((current) => current.concat(index + 1)));
  await Promise.all(done);
  await value.update((current) => current.concat(6));
  assert.deepEqual(store.saved(), [0, 1, 2, 3, 4, 5, 6]);
  assert.ok(store.calls.set <= 3, `${store.calls.set} writes for 6 updates`);
  assert.equal(store.calls.get, 1);
  assert.deepEqual(await value.get(), [0, 1, 2, 3, 4, 5, 6]);
});

test("a failed write is reported and leaves the value as it was; later updates still land", async () => {
  const store = memoryStore([1]);
  const errors: unknown[] = [];
  const value = createStoredValue(store, { parse: numbers, onError: (error) => errors.push(error) });
  store.failNextWrite();
  await value.update((current) => current.concat(2));
  assert.equal(errors.length, 1);
  assert.deepEqual(await value.get(), [1]);
  await value.update((current) => current.concat(3));
  assert.deepEqual(store.saved(), [1, 3]);
});

test("missing or unreadable stored data starts from what parse makes of nothing", async () => {
  const broken = { get: async () => { throw new Error("storage unavailable"); }, set: async () => {} };
  assert.deepEqual(await createStoredValue(broken, { parse: numbers, onError: unexpected }).get(), []);
  const strict = (stored: unknown) => { if (stored !== undefined && !Array.isArray(stored)) throw new Error("corrupt"); return (stored ?? []) as number[]; };
  assert.deepEqual(await createStoredValue(memoryStore("garbage"), { parse: strict, onError: unexpected }).get(), []);
});
