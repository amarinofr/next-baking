#!/usr/bin/env node
/**
 * Give this project's hub database its starting content.
 *
 *   npm run bootstrap                      # data/app.db <- public/seed/state.json (the tracked snapshot)
 *   npm run bootstrap -- <path-to-seed>    # from any other seed JSON you have
 *   DB_PATH=/tmp/x.db npm run bootstrap    # anywhere else you point DATA_DIR/DB_PATH
 *
 * Safety: it never overwrites an existing hub. If the database already has rows it reports them and stops,
 * because a stale seed file must not roll back edits made on this machine. To merge two populated stores use
 * `npm run replicate -- <other-hub-url>` instead: that merges row by row, last-write-wins.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ensureSchema, hubStats } from "../src/server/sqliteStore.ts";
import { seedDatabaseFromFile } from "../src/server/seedHub.ts";

const ROOT = resolve(import.meta.dirname, "..");
const DB_PATH = process.env.DB_PATH ?? join(ROOT, "data", "app.db");
const SEED = process.argv[2] ?? join(ROOT, "public", "seed", "state.json");

mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
ensureSchema(db);

const existing = hubStats(db);
const existingTotal = Object.values(existing).reduce((a, b) => a + b, 0);

if (existingTotal > 0) {
  console.log(`\n  [bootstrap] ${DB_PATH} already holds ${existingTotal} row(s); nothing was overwritten.`);
  console.log(`  [bootstrap] tables: ${Object.entries(existing).map(([t, n]) => `${t} ${n}`).join(", ")}`);
  console.log(`  [bootstrap] to merge another device's rows: npm run replicate -- http://<that-machine>:7902\n`);
  db.close();
  process.exit(0);
}

console.log(`\n  [bootstrap] creating ${DB_PATH}`);
console.log(`  [bootstrap] seeding from ${SEED}`);

const result = seedDatabaseFromFile(db, SEED);

if (result.applied === 0) {
  console.error(`  [bootstrap] ${result.reason ?? "seeding produced nothing"}`);
  console.error(`  [bootstrap] if this clone should carry your real data instead, point it at a running hub:`);
  console.error(`              npm run replicate -- http://<machine-running-the-hub>:7902`);
  db.close();
  process.exit(1);
}

console.log(`  [bootstrap] seeded ${result.applied} rows`);
for (const [table, count] of Object.entries(result.stats ?? {})) console.log(`              ${table.padEnd(24)} ${count}`);
console.log(`\n  [bootstrap] done. npm start serves the UI and the sync hub on :${process.env.PORT ?? 7902}\n`);
db.close();
