/**
 * Hub storage: real SQLite, schema-compatible with the original app.
 *
 * The hub keeps ordinary tables (so you can open the file with any SQLite tool and
 * so an export can be fed back into the legacy app), and only adds three columns
 * per table for replication. Rows are converted to/from `RowRecord` at the edge.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { pkOf, TABLES, type RowRecord, type TableName } from "../domain/types.ts";
import { normalizeRow } from "../domain/seed.ts";

const DDL: Record<TableName, string> = {
  ingredients: `CREATE TABLE IF NOT EXISTS ingredients (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, unit TEXT NOT NULL DEFAULT 'g',
      created_at TEXT NOT NULL, price REAL, category TEXT CHECK(category IN ('dry','hybrid','liquid')),
      calories REAL DEFAULT 0, protein REAL DEFAULT 0, fats REAL DEFAULT 0, carbs REAL DEFAULT 0,
      sugar REAL DEFAULT 0, fiber REAL DEFAULT 0, hybrid_water REAL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, origin TEXT NOT NULL DEFAULT '')`,
  flour_mixes: `CREATE TABLE IF NOT EXISTS flour_mixes (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, origin TEXT NOT NULL DEFAULT '')`,
  flour_mix_components: `CREATE TABLE IF NOT EXISTS flour_mix_components (
      mix_id TEXT NOT NULL REFERENCES flour_mixes(id) ON DELETE CASCADE,
      ingredient_id TEXT NOT NULL REFERENCES ingredients(id), amount REAL NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, origin TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (mix_id, ingredient_id))`,
  recipes: `CREATE TABLE IF NOT EXISTS recipes (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT '',
      servings INTEGER NOT NULL DEFAULT 1, hydration_percent REAL NOT NULL DEFAULT 65.0, created_at TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, origin TEXT NOT NULL DEFAULT '')`,
  recipe_ingredients: `CREATE TABLE IF NOT EXISTS recipe_ingredients (
      recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      ingredient_id TEXT NOT NULL REFERENCES ingredients(id), amount REAL NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, origin TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (recipe_id, ingredient_id))`,
  recipe_mixes: `CREATE TABLE IF NOT EXISTS recipe_mixes (
      recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      mix_id TEXT NOT NULL REFERENCES flour_mixes(id), amount REAL NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, origin TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (recipe_id, mix_id))`,
  recipe_main_liquids: `CREATE TABLE IF NOT EXISTS recipe_main_liquids (
      recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      ingredient_id TEXT NOT NULL REFERENCES ingredients(id), percentage REAL NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, origin TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (recipe_id, ingredient_id))`,
};

const tableInfo = (db: DatabaseSync, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name);

/** Additively migrate a legacy database copy: never drops or renames anything. */
export function ensureSchema(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");

  for (const [table, ddl] of Object.entries(DDL) as Array<[TableName, string]>) {
    const existing = tableInfo(db, table);
    if (existing.length === 0) { db.exec(ddl); continue; }
    for (const column of ["updated_at", "deleted", "origin"]) {
      if (!existing.includes(column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
      }
    }
    // Backfill replication fields on rows imported from the legacy database.
    const nowMs = Date.now();
    db.exec(`UPDATE ${table} SET updated_at = ${nowMs} WHERE updated_at IS NULL OR updated_at = 0;`);
    db.exec(`UPDATE ${table} SET deleted = 0 WHERE deleted IS NULL;`);
    db.exec(`UPDATE ${table} SET origin = 'legacy' WHERE origin IS NULL OR origin = ''`);
  }

  // Legacy tables we do not model (categories) are left untouched on purpose.
  db.exec(`CREATE TABLE IF NOT EXISTS sync_meta (device_id TEXT PRIMARY KEY, cursor INTEGER NOT NULL DEFAULT 0)`);
}

const toRecord = (table: TableName, row: Record<string, unknown>, fallbackMs: number, fallbackOrigin: string): RowRecord => {
  const normalized = normalizeRow(table, row, fallbackMs, fallbackOrigin);
  const cols: Record<string, unknown> = {};
  for (const column of TABLES[table].columns) {
    if (column === "updated_at" || column === "deleted" || column === "origin") continue;
    cols[column] = normalized[column];
  }
  return {
    table, pk: pkOf(table, normalized), cols,
    updated_at: Number(normalized.updated_at), deleted: Boolean(normalized.deleted), origin: String(normalized.origin),
  };
};

export function readRecords(db: DatabaseSync, since = 0): RowRecord[] {
  const out: RowRecord[] = [];
  const stamp = Date.now();
  for (const table of Object.keys(TABLES) as TableName[]) {
    const rows = db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
    for (const raw of rows) {
      const record = toRecord(table, { ...raw }, stamp, "hub");
      if (record.updated_at > since) out.push(record);
    }
  }
  return out;
}

/** Last-write-wins upsert: an incoming row only overwrites a stored one when it is newer. */
export function applyChanges(db: DatabaseSync, records: readonly RowRecord[]): { applied: number; rejected: number } {
  let applied = 0; let rejected = 0;

  for (const record of records) {
    const spec = TABLES[record.table];
    const columns = spec.columns;
    const pkValues = record.pk.split("::");

    const whereClauses = spec.pkColumns.map((c, i) => `${c} = ?`).join(" AND ");
    const existingRow = db.prepare(`SELECT * FROM ${record.table} WHERE ${whereClauses}`).get(...pkValues) as Record<string, unknown> | undefined;

    if (existingRow) {
      const currentMs = Number(existingRow.updated_at ?? 0);
      const currentOrigin = String(existingRow.origin ?? "");
      const newer = record.updated_at > currentMs || (record.updated_at === currentMs && record.origin >= currentOrigin);
      if (!newer) { rejected += 1; continue; }
    }

    const placeholders = columns.map(() => "?").join(", ");
    const values: Array<number | string | null> = columns.map((column) => {
      if (column === "updated_at") return record.updated_at;
      if (column === "deleted") return record.deleted ? 1 : 0;
      if (column === "origin") return record.origin;
      const raw = record.cols[column];
      if (raw === undefined || raw === null) return null;
      if (typeof raw === "number" || typeof raw === "string") return raw;
      return String(raw);
    });

    db.prepare(`INSERT OR REPLACE INTO ${record.table} (${columns.join(", ")}) VALUES (${placeholders})`).run(...values);
    applied += 1;
  }

  return { applied, rejected };
}

export const setDeviceCursor = (db: DatabaseSync, deviceId: string, cursor: number): void => {
  db.prepare("INSERT OR REPLACE INTO sync_meta (device_id, cursor) VALUES (?, ?)").run(deviceId, cursor);
};

export const getDeviceCursor = (db: DatabaseSync, deviceId: string): number => {
  const row = db.prepare("SELECT cursor FROM sync_meta WHERE device_id = ?").get(deviceId) as { cursor?: number } | undefined;
  return Number(row?.cursor ?? 0);
};

export const hubStats = (db: DatabaseSync): Record<string, number> => {
  const stats: Record<string, number> = {};
  for (const table of Object.keys(TABLES) as TableName[]) {
    const live = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE COALESCE(deleted, 0) = 0`).get() as { n: number };
    stats[table] = Number(live.n);
  }
  return stats;
};

/** Import rows from a legacy SQLite file (read-only on the source). */
export function importLegacyDb(target: DatabaseSync, sourcePath: string, origin = "import"): number {
  if (!existsSync(sourcePath)) throw new Error(`source database not found: ${sourcePath}`);
  const source = new DatabaseSync(sourcePath, { open: true });
  try {
    let count = 0;
    const stamp = Date.now();
    for (const table of Object.keys(TABLES) as TableName[]) {
      let rows: Array<Record<string, unknown>> = [];
      try { rows = source.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>; } catch { continue; }
      const records = rows.map((row) => toRecord(table, { ...row }, stamp, origin));
      count += applyChanges(target, records).applied;
    }
    return count;
  } finally {
    source.close();
  }
}
