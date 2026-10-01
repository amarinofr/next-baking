#!/usr/bin/env node
/**
 * Garbage-collect tombstones from this project's own hub database (`data/app.db`).
 *
 *   npm run prune                        # dry run: show what is waiting to be collected
 *   npm run prune -- --apply             # remove deletes older than --days (default 30)
 *   npm run prune -- --days 7 --apply    # shorter window
 *   DB_PATH=/tmp/x.db npm run prune -- --apply
 *
 * Why tombstones exist at all: a delete has to travel. If a device remembered a row and the hub simply forgot it,
 * the next sync would resurrect it — so a deleted row stays as `deleted = 1` until everyone has seen the delete.
 *
 * Why they can eventually go: once a delete is older than every device's offline gap, no device can still hold the
 * pre-delete version, and the tombstone is pure weight. It shows up in exports and in the seed snapshot that every
 * fresh clone downloads. Choose `--days` longer than your longest "the phone was offline for…" gap.
 *
 * Only rows already marked deleted are ever removed; live rows are untouched. After collecting, refresh the seed:
 * `npm run seed && npm run build`.
 */

import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { TABLES, type TableName } from "../src/domain/types.ts";

const ROOT = resolve(import.meta.dirname, "..");
const DB_PATH = process.env.DB_PATH ?? join(ROOT, "data", "app.db");

const apply = process.argv.includes("--apply");
const daysFlag = process.argv.indexOf("--days");
const days = daysFlag >= 0 ? Number(process.argv[daysFlag + 1]) : 30;

if (!Number.isFinite(days) || days < 0) {
  console.error("\n  [prune] --days needs a number (0 removes the age requirement)\n");
  process.exit(1);
}

const cutoff = Date.now() - days * 86_400_000;
const db = new DatabaseSync(DB_PATH, { readOnly: !apply });

console.log(`\n  next-baking-app · tombstone collection`);
console.log(`  database : ${DB_PATH}`);
console.log(`  collecting deletes older than ${days} day(s)${apply ? "" : " — dry run, pass --apply to remove"}`);
console.log("");

const age = (updated: number): string => `${Math.max(0, Math.round((Date.now() - updated) / 86_400_000))}d`;
let collected = 0;

for (const table of Object.keys(TABLES) as TableName[]) {
  const pkColumns = TABLES[table].pkColumns;

  let tombstones: Array<Record<string, unknown>>;
  try {
    tombstones = db.prepare(
      `SELECT ${pkColumns.join(", ")}, updated_at FROM ${table} WHERE deleted = 1 AND updated_at <= ? ORDER BY updated_at`,
    ).all(cutoff) as Array<Record<string, unknown>>;
  } catch {
    continue;   // this database does not have that table yet
  }

  const live = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE deleted = 0`).get() as { n: number }).n;

  if (tombstones.length === 0) {
    console.log(`  ${table.padEnd(24)} live ${String(live).padStart(4)} · nothing waiting`);
    continue;
  }

  const label = (row: Record<string, unknown>): string => pkColumns.map((c) => String(row[c])).join("::");

  if (!apply) {
    console.log(`  ${table.padEnd(24)} live ${String(live).padStart(4)} · ${tombstones.length} waiting: ${tombstones.map((r) => `${label(r)} (${age(Number(r.updated_at))})`).join(", ")}`);
    continue;
  }

  const remove = db.prepare(
    `DELETE FROM ${table} WHERE deleted = 1 AND updated_at <= ? AND ${pkColumns.map((c) => `${c} = ?`).join(" AND ")}`,
  );
  for (const row of tombstones) {
    remove.run(cutoff, ...pkColumns.map((c) => row[c] as string | number));
    collected += 1;
  }
  console.log(`  ${table.padEnd(24)} live ${String(live).padStart(4)} · collected ${tombstones.length}`);
}

db.close();

if (!apply) {
  console.log("\n  nothing changed. Re-run with --apply.\n");
} else {
  console.log(`\n  collected ${collected} tombstone(s). Refresh the seed snapshot: npm run seed && npm run build\n`);
}
