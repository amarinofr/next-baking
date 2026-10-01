#!/usr/bin/env node
/**
 * Build the offline seed bundle: SQLite snapshot  ->  public/seed/state.json
 *
 * Source of truth is THIS project's own database copy (`data/app.db`). The original
 * app's live database is never opened by this script; refresh the copy first with
 * `npm run snapshot -- --refresh` if you want today's data from the old app.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TABLES, type TableName } from "../src/domain/types.ts";

const ROOT = resolve(import.meta.dirname, "..");
const DB_PATH = process.argv[2] ?? process.env.DB_PATH ?? join(ROOT, "data", "app.db");
const OUT = join(ROOT, "public", "seed", "state.json");

import { existsSync } from "node:fs";

// A fresh clone has no data/app.db (databases stay out of git). It does carry the seed snapshot, so the build
// keeps that snapshot instead of failing — `git clone && npm start` works on any machine.
if (!existsSync(DB_PATH)) {
  if (existsSync(OUT)) {
    console.log(`[seed] no local database at ${DB_PATH}; keeping the tracked seed snapshot at ${OUT}`);
    console.log(`[seed] to carry today's data instead: npm run replicate -- http://<machine-with-the-hub>:7902`);
    process.exit(0);
  }
  console.error(`[seed] no database at ${DB_PATH} and no seed snapshot at ${OUT}.`);
  console.error(`[seed] fix either way: npm run bootstrap   (from a seed file)   or   npm run replicate -- <hub-url>`);
  process.exit(1);
}

if (!process.argv[2] && !process.env.DB_PATH) {
  console.log(`[seed] reading ${DB_PATH} (this project's own copy)`);
} else {
  console.log(`[seed] reading explicit source ${DB_PATH}`);
}

const db = new DatabaseSync(DB_PATH, { open: true });
const snapshotMs = Date.now();
const tables: Record<string, Record<string, unknown>[]> = {};
let total = 0;

for (const table of Object.keys(TABLES) as TableName[]) {
  try {
    const rows = db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
    tables[table] = rows.map((row) => ({ ...row }));
    total += rows.length;
  } catch {
    tables[table] = [];
  }
}
db.close();

const payload = {
  generated_at: new Date().toISOString(),
  snapshot_ms: snapshotMs,
  source: DB_PATH,
  origin: "seed",
  tables,
};

mkdirSync(join(OUT, ".."), { recursive: true });
writeFileSync(OUT, JSON.stringify(payload));
console.log(`[seed] wrote ${OUT} with ${total} rows`);
