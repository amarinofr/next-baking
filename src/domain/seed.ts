/**
 * Seed / import layer: legacy SQLite rows  ->  domain records.
 *
 * The legacy database (`legacy-baking/data/app.db`) has no sync columns and may
 * contain NULLs. This module normalizes rows and validates them through the
 * Effect Schemas before they are used anywhere else.
 */

import { Effect, Schema } from "effect";
import { pkOf, TABLES, type RowRecord, type TableName } from "./types.ts";
import { ROW_SCHEMAS, ValidationError } from "./schema.ts";

const NUMERIC_DEFAULTS: Record<string, number> = {
  price: 0, calories: 0, protein: 0, fats: 0, carbs: 0, sugar: 0, fiber: 0, hybrid_water: 0,
  amount: 0, percentage: 0, servings: 1, hydration_percent: 65,
};

const STRING_DEFAULTS: Record<string, string> = {
  id: "", name: "", instructions: "", created_at: "", unit: "g", category: "dry",
};

const defaultFor = (column: string): unknown => {
  if (column in NUMERIC_DEFAULTS) return NUMERIC_DEFAULTS[column];
  if (column in STRING_DEFAULTS) return STRING_DEFAULTS[column];
  return null;
};

export interface SeedEnvelope {
  generated_at: string;
  source: string;
  snapshot_ms: number;
  origin: string;
  records: RowRecord[];
}

/** Normalize a raw row read from any SQLite table into the domain shape. */
export function normalizeRow(table: TableName, raw: Record<string, unknown>, snapshotMs: number, origin: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const column of TABLES[table].columns) {
    const value = raw[column];
    if (column === "updated_at") {
      out[column] = typeof value === "number" && value > 0 ? value : snapshotMs;
    } else if (column === "deleted") {
      out[column] = Boolean(value ?? false);
    } else if (column === "origin") {
      out[column] = String(value ?? origin);
    } else if (value === null || value === undefined) {
      let fallback = defaultFor(column);
      if (column === "created_at" && fallback === "") fallback = new Date(snapshotMs).toISOString();
      out[column] = fallback;
    } else if (column in NUMERIC_DEFAULTS) {
      const n = Number(value);
      out[column] = Number.isFinite(n) ? n : NUMERIC_DEFAULTS[column]!;
    } else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[column] = value;
    } else {
      out[column] = defaultFor(column);
    }
  }
  // created_at is kept EXACTLY as your original stores it (e.g. "2026-04-11 21:19:58 +0000 +00").
  // Rewriting it would look tidier but would silently change data that the old app also reads.
  return out;
}

/** Validate one normalized row and wrap it as a replication record. */
export function rowToRecord(table: TableName, row: Record<string, unknown>): Effect.Effect<RowRecord, ValidationError> {
  const schema = ROW_SCHEMAS[table];
  return Effect.gen(function* () {
    const parsed = yield* (Schema.decodeUnknown(schema as never)(row) as Effect.Effect<Record<string, unknown>, unknown>).pipe(
      Effect.mapError((err) => new ValidationError({ field: `${table}.${String(row["id"] ?? row["mix_id"] ?? row["recipe_id"] ?? "?")}`, reason: String((err as Error)?.message ?? err).slice(0, 300) })),
    );
    const pk = pkOf(table, parsed);
    if (!pk) return yield* Effect.fail(new ValidationError({ field: `${table}.id`, reason: "missing primary key" }));
    const cols: Record<string, unknown> = {};
    for (const c of TABLES[table].columns) {
      if (c === "updated_at" || c === "deleted" || c === "origin") continue;
      cols[c] = parsed[c];
    }
    return {
      table, pk, cols,
      updated_at: Number(parsed.updated_at), deleted: Boolean(parsed.deleted), origin: String(parsed.origin),
    } satisfies RowRecord;
  });
}

/** Load a seed file payload into validated records. */
export const loadSeedRecords = (table: TableName, rows: Iterable<Record<string, unknown>>, snapshotMs: number, origin: string): Effect.Effect<RowRecord[], ValidationError> =>
  Effect.forEach(
    [...rows],
    (raw) => rowToRecord(table, normalizeRow(table, raw, snapshotMs, origin)),
  );
