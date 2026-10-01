/**
 * Seed a hub database from this repository's committed seed snapshot.
 *
 * Why this exists: `git clone && npm start` has to work on a machine that has no database yet. The tracked
 * `public/seed/state.json` is a JSON dump of every row (with the replication columns), so a fresh hub can be
 * built from it without ever opening anyone's live SQLite file.
 */

import { existsSync, readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { loadSeedRecords } from "../domain/seed.ts";
import { TABLE_NAMES, type RowRecord, type TableName } from "../domain/types.ts";
import { applyChanges, hubStats } from "./sqliteStore.ts";

export interface SeedFile {
  generated_at?: string;
  source?: string;
  snapshot_ms?: number;
  origin?: string;
  tables?: Partial<Record<TableName, Record<string, unknown>[]>>;
}

export function readSeedFile(path: string): { file?: SeedFile; error?: string } {
  if (!existsSync(path)) return { error: `no seed file at ${path}` };
  try {
    return { file: JSON.parse(readFileSync(path, "utf8")) as SeedFile };
  } catch (error) {
    return { error: `seed file at ${path} could not be parsed: ${String((error as Error).message)}` };
  }
}

/** Rows waiting in a seed file, normalised into replication-ready records. */
export function seedRecords(file: SeedFile): { records?: RowRecord[]; error?: string } {
  const snapshotMs = Number(file.snapshot_ms ?? Date.now());
  const origin = String(file.origin ?? "seed");

  const result = Effect.runSync(Effect.either(Effect.gen(function* () {
    const all: RowRecord[] = [];
    for (const table of TABLE_NAMES) {
      all.push(...(yield* loadSeedRecords(table, file.tables?.[table] ?? [], snapshotMs, origin)));
    }
    return all;
  })));

  if (result._tag === "Left") return { error: `seed rows are invalid: ${String((result.left as Error)?.message ?? result.left)}` };
  return { records: result.right };
}

/** Fill an empty hub database from a seed file. Returns how many rows landed. */
export function seedDatabaseFromFile(db: DatabaseSync, path: string): { applied: number; reason?: string; stats?: Record<string, number> } {
  const read = readSeedFile(path);
  if (read.error) return { applied: 0, reason: read.error };

  const converted = seedRecords(read.file!);
  if (converted.error) return { applied: 0, reason: converted.error };
  if (!converted.records || converted.records.length === 0) return { applied: 0, reason: `seed file at ${path} holds no rows` };

  db.exec("BEGIN");
  try {
    const { applied } = applyChanges(db, converted.records);
    db.exec("COMMIT");
    return { applied, stats: hubStats(db) };
  } catch (error) {
    db.exec("ROLLBACK");
    return { applied: 0, reason: `seeding failed: ${String((error as Error).message)}` };
  }
}

/**
 * Guard against regenerating the tracked seed from an empty or half-filled database. On a fresh machine the
 * order is easy to get wrong — build first with no data yet — and without this check the build would quietly
 * replace a full backup with nothing. Small intentional deletions are allowed; large ones need --force.
 */
export function seedWriteDecision(previousRows: number, nextRows: number): { ok: boolean; warn?: string; reason?: string } {
  if (nextRows >= previousRows) return { ok: true };

  const dropped = previousRows - nextRows;
  const tolerance = Math.max(5, Math.floor(previousRows * 0.1));

  if (dropped > tolerance) {
    return {
      ok: false,
      reason: `refusing to shrink the seed from ${previousRows} rows to ${nextRows}. If you really deleted that many rows, pass --force.`,
    };
  }
  return { ok: true, warn: `${dropped} row(s) fewer than the tracked seed (${previousRows} → ${nextRows})` };
}
