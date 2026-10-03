import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Schema } from "effect";
import { createStoredValue } from "../src/modules/stored-value";

function memoryStore(initial?: number[]) {
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
const numbers = (stored: number[] | null | undefined) => stored ?? [];

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
  // Data from an older version is read as unknown and validated; a parse that throws starts empty.
  const garbage = { get: async (): Promise<unknown> => "garbage", set: async (_: number[]) => {} };
  const strict = (stored: unknown) => Schema.decodeUnknownSync(Schema.Array(Schema.Number))(stored ?? []);
  assert.deepEqual(await createStoredValue(garbage, { parse: strict, onError: unexpected }).get(), []);
});
