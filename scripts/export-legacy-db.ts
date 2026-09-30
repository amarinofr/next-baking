#!/usr/bin/env node
/**
 * Rollback path: write THIS app's data back out as a plain SQLite file using the
 * original app's exact table/column shape (no replication columns), so it could be
 * dropped into the legacy app or any other tool.
 *
 *   npm run export:legacy            -> exports/legacy-compat-<timestamp>.db
 *
 * It never touches the original app's files: it reads this project's own database copy.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SOURCE = process.env.DB_PATH ?? join(ROOT, "data", "app.db");
const OUT_DIR = join(ROOT, "exports");
mkdirSync(OUT_DIR, { recursive: true });
const OUT = join(OUT_DIR, `legacy-compat-${new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16)}.db`);

// The legacy schema exactly as the Go backend created it.
const LEGACY_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ingredients (id TEXT PRIMARY KEY, name TEXT NOT NULL, unit TEXT NOT NULL DEFAULT 'g', created_at DATETIME NOT NULL, price REAL, category TEXT CHECK(category IN ('dry','hybrid','liquid')), calories REAL DEFAULT 0, protein REAL DEFAULT 0, fats REAL DEFAULT 0, carbs REAL DEFAULT 0, sugar REAL DEFAULT 0, fiber REAL DEFAULT 0, hybrid_water REAL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS flour_mixes (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at DATETIME NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS flour_mix_components (mix_id TEXT NOT NULL REFERENCES flour_mixes(id) ON DELETE CASCADE, ingredient_id TEXT NOT NULL REFERENCES ingredients(id), amount REAL NOT NULL, PRIMARY KEY (mix_id, ingredient_id))`,
  `CREATE TABLE IF NOT EXISTS recipes (id TEXT PRIMARY KEY, name TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT '', servings INTEGER NOT NULL DEFAULT 1, hydration_percent REAL NOT NULL DEFAULT 65.0, created_at DATETIME NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS recipe_ingredients (recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE, ingredient_id TEXT NOT NULL REFERENCES ingredients(id), amount REAL NOT NULL, PRIMARY KEY (recipe_id, ingredient_id))`,
  `CREATE TABLE IF NOT EXISTS recipe_main_liquids (recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE, ingredient_id TEXT NOT NULL REFERENCES ingredients(id), percentage REAL NOT NULL, PRIMARY KEY (recipe_id, ingredient_id))`,
  `CREATE TABLE IF NOT EXISTS recipe_mixes (recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE, mix_id TEXT NOT NULL REFERENCES flour_mixes(id), amount REAL NOT NULL, PRIMARY KEY (recipe_id, mix_id))`,
];

/** Columns the legacy app expects per table. */
const LEGACY_COLUMNS: Record<string, string[]> = {
  ingredients: ["id", "name", "unit", "created_at", "price", "category", "calories", "protein", "fats", "carbs", "sugar", "fiber", "hybrid_water"],
  flour_mixes: ["id", "name", "created_at"],
  flour_mix_components: ["mix_id", "ingredient_id", "amount"],
  recipes: ["id", "name", "instructions", "servings", "hydration_percent", "created_at"],
  recipe_ingredients: ["recipe_id", "ingredient_id", "amount"],
  recipe_main_liquids: ["recipe_id", "ingredient_id", "percentage"],
  recipe_mixes: ["recipe_id", "mix_id", "amount"],
};

const source = new DatabaseSync(SOURCE, { open: true });
const target = new DatabaseSync(OUT);
target.exec("PRAGMA foreign_keys = ON;");
for (const ddl of LEGACY_SCHEMA) target.exec(ddl);

/** Parent keys that actually exist, so dangling references left behind by earlier
 * deletes in the original database cannot break the export (the apps ignore them too). */
const liveKeys = new Map<string, Set<string>>();
for (const table of ["ingredients", "flour_mixes", "recipes"]) {
  const rows = source.prepare(`SELECT id FROM ${table} WHERE COALESCE(deleted, 0) = 0`).all() as Array<{ id: string }>;
  liveKeys.set(table, new Set(rows.map((r) => r.id)));
}

const PARENTS: Record<string, Array<[string, string]>> = {
  flour_mix_components: [["mix_id", "flour_mixes"], ["ingredient_id", "ingredients"]],
  recipe_ingredients: [["recipe_id", "recipes"], ["ingredient_id", "ingredients"]],
  recipe_main_liquids: [["recipe_id", "recipes"], ["ingredient_id", "ingredients"]],
  recipe_mixes: [["recipe_id", "recipes"], ["mix_id", "flour_mixes"]],
};

let total = 0;
let skipped = 0;
for (const [table, columns] of Object.entries(LEGACY_COLUMNS)) {
  const rows = source.prepare(`SELECT * FROM ${table} WHERE COALESCE(deleted, 0) = 0`).all() as Array<Record<string, unknown>>;
  if (rows.length === 0) continue;
  const parents = PARENTS[table] ?? [];
  const insert = target.prepare(`INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
  for (const row of rows) {
    const orphanOf = parents.find(([column, parentTable]) => !liveKeys.get(parentTable)?.has(String(row[column])));
    if (orphanOf) { skipped += 1; console.log(`  ${table}: skipped dangling row (${orphanOf[0]}=${String(row[orphanOf[0]])} has no ${orphanOf[1]})`); continue; }
    try {
      insert.run(...columns.map((c) => (row[c] ?? null) as number | string | null));
    } catch (error) {
      console.error(`  !! ${table} row failed:`, JSON.stringify(row), String((error as Error).message));
      throw error;
    }
  }
  total += rows.length;
  console.log(`  ${table}: ${rows.length} rows`);
}

source.close();
target.close();
console.log(`\n  wrote ${OUT}\n  ${total} live rows in the original schema (replication columns dropped), ${skipped} dangling row(s) skipped\n`);
