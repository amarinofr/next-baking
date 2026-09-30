/** Last-Write-Wins replication primitives (pure, shared by client and hub). */

import { PK_SEPARATOR, TABLES, type RowRecord, type TableName } from "./types.ts";

/** Composite identity of a row across all devices. */
export const recordKey = (table: TableName, pk: string): string => `${table}${PK_SEPARATOR}${pk}`;

/** Deterministic total order: timestamp first, device id as tiebreak. */
export function wins(candidate: RowRecord, incumbent: RowRecord): boolean {
  if (candidate.updated_at !== incumbent.updated_at) return candidate.updated_at > incumbent.updated_at;
  if (candidate.origin !== incumbent.origin) return candidate.origin > incumbent.origin;
  return candidate.pk >= incumbent.pk;
}

export interface MergeResult {
  /** rows the local device owns (should be pushed to peers) */
  toPush: ReadonlyArray<RowRecord>;
  /** rows newer on the peer (should be applied locally) */
  toApply: ReadonlyArray<RowRecord>;
  /** converged state after merging both sides */
  merged: Map<string, RowRecord>;
}

export function mergeChangesets(local: Iterable<RowRecord>, remote: Iterable<RowRecord>): MergeResult {
  const merged = new Map<string, RowRecord>();
  const toApply: RowRecord[] = [];

  for (const r of local) merged.set(recordKey(r.table, r.pk), r);
  for (const r of remote) {
    const key = recordKey(r.table, r.pk);
    const incumbent = merged.get(key);
    if (!incumbent || wins(r, incumbent)) {
      merged.set(key, r);
      toApply.push(r);
    }
  }

  const toPush: RowRecord[] = [];
  const remoteMap = new Map<string, RowRecord>();
  for (const r of remote) remoteMap.set(recordKey(r.table, r.pk), r);
  for (const r of local) {
    const key = recordKey(r.table, r.pk);
    const other = remoteMap.get(key);
    if (!other || wins(r, other)) toPush.push(r);
  }

  return { toPush, toApply, merged };
}

export const maxUpdatedAt = (records: Iterable<RowRecord>): number => {
  let max = 0;
  for (const r of records) if (r.updated_at > max) max = r.updated_at;
  return max;
};

export const changesSince = (records: Iterable<RowRecord>, cursorMs: number): RowRecord[] => {
  const out: RowRecord[] = [];
  for (const r of records) if (r.updated_at > cursorMs) out.push(r);
  return out;
};

/** Live (non-tombstoned) rows of a table. */
export function liveRows<T>(records: Iterable<RowRecord>, table: TableName): T[] {
  const out: T[] = [];
  for (const r of records) if (r.table === table && !r.deleted) out.push({ ...r.cols, ...pkFromPk(table, r.pk) } as T);
  return out;
}

function pkFromPk(table: TableName, pk: string): Record<string, string> {
  const parts = pk.split(PK_SEPARATOR);
  const out: Record<string, string> = {};
  TABLES[table].pkColumns.forEach((c, i) => { out[c] = parts[i] ?? ""; });
  return out;
}
