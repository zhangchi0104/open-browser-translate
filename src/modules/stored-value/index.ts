/**
 * Where a value lives: extension storage in the background, a variable in tests. `Stored` is what
 * reading it can give; `unknown` when what's there may predate the current shape.
 */
export interface ValueStore<T, Stored = T | null | undefined> {
  get(): Promise<Stored>;
  set(value: T): Promise<void>;
}

/**
 * A stored value that only this object writes, changed through ordered read-modify-write updates.
 * It's read from the store once (`parse` turns what's there, or nothing when it can't be read,
 * into a value) and kept in memory after that. Updates made while a write is in flight share the next write, applied in the
 * order they were made, so concurrent requests never overwrite each other. A failed write goes to
 * `onError` and leaves the value as it was; later updates still go through.
 */
export function createStoredValue<T, Stored = T | null | undefined>(store: ValueStore<T, Stored>, options: {
  parse: (stored: NoInfer<Stored> | undefined) => T;
  onError: (error: unknown) => void;
}) {
  let current: Promise<T> | undefined;
  const load = () => current ??= store.get().then(options.parse).catch(() => options.parse(undefined));
  let queued: ((value: T) => T)[] = [];
  let writes: Promise<void> = Promise.resolve();
  return {
    /** The value as of the last write. */
    get: load,
    /** Changes the value; resolves once the change has reached the store (or failed to). */
    update(change: (value: T) => T): Promise<void> {
      if (queued.push(change) > 1) return writes;
      writes = writes.then(async () => {
        const changes = queued;
        queued = [];
        let next: T = await load();
        for (const change of changes) next = change(next);
        await store.set(next);
        current = Promise.resolve(next);
      }).catch(options.onError);
      return writes;
    },
    /** Resolves once every update made so far has reached the store. */
    flush: () => writes,
  };
}
