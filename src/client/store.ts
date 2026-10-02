/**
 * Local-first storage adapters.
 *
 * The browser keeps every row in IndexedDB so the app works with no network at
 * all; a memory adapter is used by tests and the hub's import path. Both speak
 * the same `RowRecord` shape, which is also the replication payload.
 */

import { Effect } from "effect";
import { StorageError } from "../domain/schema.ts";
import { uuid } from "../domain/ids.ts";
import { recordKey, wins } from "../domain/syncMerge.ts";
import type { RowRecord } from "../domain/types.ts";

export interface Store {
  readonly allRecords: () => Effect.Effect<RowRecord[], StorageError>;
  readonly putRecords: (records: readonly RowRecord[]) => Effect.Effect<void, StorageError>;
  readonly getMeta: (key: string) => Effect.Effect<string | undefined, StorageError>;
  readonly setMeta: (key: string, value: string) => Effect.Effect<void, StorageError>;
  readonly replaceAll: (records: readonly RowRecord[]) => Effect.Effect<void, StorageError>;
  /** Apply remote rows inside one transaction, keeping locally-newer versions. Returns how many were applied. */
  readonly mergeRemote: (records: readonly RowRecord[]) => Effect.Effect<number, StorageError>;
}

const DB_NAME = "next-baking-app";
const DB_VERSION = 1;
const RECORDS = "records";
const META = "meta";

interface StoredRecord extends RowRecord { key: string }

const reqToPromise = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexeddb request failed"));
  });

const txDone = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("indexeddb transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("indexeddb transaction aborted"));
  });

const openDatabase = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RECORDS)) db.createObjectStore(RECORDS, { keyPath: "key" });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexeddb open failed"));
    request.onblocked = () => reject(new Error("indexeddb open blocked by another tab"));
  });

const asStorageError = (cause: unknown): StorageError =>
  new StorageError({ cause: String((cause as Error)?.message ?? cause) });

export const makeIdbStore = (): Effect.Effect<Store, StorageError> =>
  Effect.gen(function* () {
    const db = yield* Effect.tryPromise({ try: openDatabase, catch: asStorageError });

    const allRecords = (): Effect.Effect<RowRecord[], StorageError> => Effect.tryPromise({
      try: async () => {
        const tx = db.transaction(RECORDS, "readonly");
        const rows = await reqToPromise(tx.objectStore(RECORDS).getAll() as IDBRequest<StoredRecord[]>);
        return rows.map(({ key: _key, ...record }) => record as RowRecord);
      },
      catch: asStorageError,
    });

    const putRecords = (records: readonly RowRecord[]) => Effect.tryPromise({
      try: async () => {
        const tx = db.transaction(RECORDS, "readwrite");
        for (const r of records) tx.objectStore(RECORDS).put({ ...r, key: recordKey(r.table, r.pk) } satisfies StoredRecord);
        await txDone(tx);
      },
      catch: asStorageError,
    });

    const replaceAll = (records: readonly RowRecord[]) => Effect.tryPromise({
      try: async () => {
        const tx = db.transaction(RECORDS, "readwrite");
        tx.objectStore(RECORDS).clear();
        for (const r of records) tx.objectStore(RECORDS).put({ ...r, key: recordKey(r.table, r.pk) } satisfies StoredRecord);
        await txDone(tx);
      },
      catch: asStorageError,
    });

    // Read + compare + write in ONE transaction: no window where a concurrent local
    // edit could be overwritten by a stale copy arriving from the hub.
    const mergeRemote = (incoming: readonly RowRecord[]) => Effect.tryPromise({
      try: async () => {
        const tx = db.transaction(RECORDS, "readwrite");
        const store = tx.objectStore(RECORDS);
        const live = await reqToPromise(store.getAll() as IDBRequest<StoredRecord[]>);
        const byKey = new Map(live.map((row) => [row.key, row]));
        let applied = 0;
        for (const record of incoming) {
          const key = recordKey(record.table, record.pk);
          const incumbent = byKey.get(key);
          if (incumbent) {
            const liveRow: RowRecord = { table: incumbent.table, pk: incumbent.pk, cols: incumbent.cols, updated_at: incumbent.updated_at, deleted: incumbent.deleted, origin: incumbent.origin };
            if (!wins(record, liveRow)) continue;
          }
          store.put({ ...record, key } satisfies StoredRecord);
          applied += 1;
        }
        await txDone(tx);
        return applied;
      },
      catch: asStorageError,
    });

    const getMeta = (key: string) => Effect.tryPromise({
      try: async () => {
        const tx = db.transaction(META, "readonly");
        const row = await reqToPromise(tx.objectStore(META).get(key) as IDBRequest<{ key: string; value: string } | undefined>);
        return row?.value;
      },
      catch: asStorageError,
    });

    const setMeta = (key: string, value: string) => Effect.tryPromise({
      try: async () => {
        const tx = db.transaction(META, "readwrite");
        tx.objectStore(META).put({ key, value });
        await txDone(tx);
      },
      catch: asStorageError,
    });

    return { allRecords, putRecords, replaceAll, mergeRemote, getMeta, setMeta } satisfies Store;
  });

/** In-memory store used by tests and by the hub when importing a seed file. */
export const makeMemoryStore = (initial: readonly RowRecord[] = []): Store & { snapshot: () => RowRecord[] } => {
  const records = new Map<string, RowRecord>();
  const meta = new Map<string, string>();
  for (const r of initial) records.set(recordKey(r.table, r.pk), r);

  const snapshot = () => [...records.values()];

  return {
    snapshot,
    allRecords: () => Effect.succeed(snapshot()),
    putRecords: (rows) => Effect.sync(() => { for (const r of rows) records.set(recordKey(r.table, r.pk), r); }),
    replaceAll: (rows) => Effect.sync(() => { records.clear(); for (const r of rows) records.set(recordKey(r.table, r.pk), r); }),
    mergeRemote: (rows) => Effect.sync(() => {
      let applied = 0;
      for (const r of rows) {
        const incumbent = records.get(recordKey(r.table, r.pk));
        if (incumbent && !wins(r, incumbent)) continue;
        records.set(recordKey(r.table, r.pk), r);
        applied += 1;
      }
      return applied;
    }),
    getMeta: (key) => Effect.sync(() => meta.get(key)),
    setMeta: (key, value) => Effect.sync(() => { meta.set(key, value); }),
  };
};

/** Stable per-device id, persisted in IndexedDB meta. */
export const deviceIdOf = (store: Store): Effect.Effect<string, StorageError> =>
  Effect.gen(function* () {
    const existing = yield* store.getMeta("device_id");
    if (existing) return existing;
    const id = `dev-${uuid().slice(0, 8)}`;
    yield* store.setMeta("device_id", id);
    return id;
  });
