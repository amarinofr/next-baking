/**
 * Replication client: one round-trip per sync.
 *
 * The device pushes every row it changed since its cursor and receives every row
 * the hub changed since that same cursor. Merging is last-write-wins with the
 * device id as deterministic tiebreak, so any order of devices converges.
 * Everything works offline: if the hub is unreachable the local store simply keeps
 * the changes queued in the outbox.
 */

import { Effect } from "effect";
import { StorageError, SyncError } from "../domain/schema.ts";
import { changesSince, maxUpdatedAt, mergeChangesets } from "../domain/syncMerge.ts";
import type { RowRecord } from "../domain/types.ts";
import type { Store } from "./store.ts";

export interface SyncOutcome {
  pushed: number;
  applied: number;
  cursor: number;
  hubUrl: string;
}

const CURSOR_KEY = "sync_cursor";

interface HubResponse { cursor?: number; changes?: RowRecord[] }

const asSyncError = (cause: unknown): SyncError => new SyncError({ cause: String((cause as Error)?.message ?? cause) });

export const hubUrlOf = (store: Store): Effect.Effect<string, StorageError> =>
  Effect.map(store.getMeta("hub_url"), (value) => value ?? "/api/sync");

export const setHubUrl = (store: Store, url: string): Effect.Effect<void, StorageError> => store.setMeta("hub_url", url);

export const pendingCount = (store: Store): Effect.Effect<number, StorageError> =>
  Effect.gen(function* () {
    const cursor = Number((yield* store.getMeta(CURSOR_KEY)) ?? 0);
    const records = yield* store.allRecords();
    return changesSince(records, cursor).length;
  });

export function syncNow(store: Store, deviceId: string): Effect.Effect<SyncOutcome, SyncError | StorageError> {
  return Effect.gen(function* () {
    const hubUrl = yield* hubUrlOf(store);
    const records = yield* store.allRecords();
    const cursor = Number((yield* store.getMeta(CURSOR_KEY)) ?? 0);
    const outbox = changesSince(records, cursor);

    const response = yield* Effect.tryPromise({
      try: async () => {
        const res = await fetch(hubUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deviceId, since: cursor, changes: outbox }),
        });
        if (!res.ok) throw new Error(`hub responded ${res.status}`);
        return (await res.json()) as HubResponse;
      },
      catch: asSyncError,
    });

    const remote = Array.isArray(response.changes) ? response.changes : [];
    const { toApply } = mergeChangesets(records, remote);
    if (toApply.length > 0) yield* store.putRecords(toApply);

    const merged = [...records.filter((r) => !toApply.some((a) => a.table === r.table && a.pk === r.pk)), ...toApply];
    const nextCursor = Math.max(maxUpdatedAt(merged), Number(response.cursor ?? cursor) || 0);
    yield* store.setMeta(CURSOR_KEY, String(nextCursor));

    return { pushed: outbox.length, applied: toApply.length, cursor: nextCursor, hubUrl };
  });
}

/** Full local export (portable JSON snapshot of every row, tombstones included). */
export const exportSnapshot = (store: Store): Effect.Effect<string, StorageError> =>
  Effect.map(store.allRecords(), (records) => JSON.stringify({ generated_at: new Date().toISOString(), records }, null, 2));
