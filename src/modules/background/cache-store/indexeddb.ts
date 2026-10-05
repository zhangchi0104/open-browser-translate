import type { CacheEntry, CacheStore } from "./index";

const STORE = "entries";

const done = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const committed = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error);
});

// Version 2 renamed the entries' `translation` to `value`; version 1 entries are dropped.
const VERSION = 2;

/**
 * A cache in IndexedDB, one database per `name`. In the background it belongs to the
 * extension's origin, so pages can't read it and clearing a site's data doesn't touch it.
 */
export function createIndexedDbCacheStore(name: string): CacheStore {
  let opened: Promise<IDBDatabase> | undefined;
  const database = () => opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(name, VERSION);
    request.onupgradeneeded = () => {
      if (request.result.objectStoreNames.contains(STORE)) {
        request.transaction!.objectStore(STORE).clear();
        return;
      }
      const store = request.result.createObjectStore(STORE, { keyPath: "key" });
      store.createIndex("usedAt", "usedAt");
      store.createIndex("origin", "origin");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      opened = undefined;
      reject(request.error);
    };
  });
  const run = async <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => Promise<T>) => {
    const transaction = (await database()).transaction(STORE, mode);
    const [result] = await Promise.all([work(transaction.objectStore(STORE)), committed(transaction)]);
    return result;
  };
  return {
    get: (keys) => run("readonly", (store) => Promise.all(keys.map((key) => done(store.get(key) as IDBRequest<CacheEntry | undefined>)))),
    put: (entries) => run("readwrite", async (store) => { for (const entry of entries) store.put(entry); }),
    delete: (keys) => run("readwrite", async (store) => { for (const key of keys) store.delete(key); }),
    count: () => run("readonly", (store) => done(store.count())),
    scan: (visit) => run("readonly", (store) => new Promise<void>((resolve, reject) => {
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current) return resolve();
        visit(current.value as CacheEntry);
        current.continue();
      };
      cursor.onerror = () => reject(cursor.error);
    })),
    leastRecentlyUsed: (limit) => run("readonly", (store) => new Promise<string[]>((resolve, reject) => {
      const keys: string[] = [];
      if (limit <= 0) return resolve(keys);
      const cursor = store.index("usedAt").openKeyCursor();
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current || keys.length >= limit) return resolve(keys);
        keys.push(current.primaryKey as string);
        current.continue();
      };
      cursor.onerror = () => reject(cursor.error);
    })),
    clear: () => run("readwrite", (store) => done(store.clear()).then(() => {})),
  };
}
