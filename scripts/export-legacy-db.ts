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

// The legacy schema exactly as the Go backend created it (verified against your live database).
const LEGACY_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ingredients (id TEXT PRIMARY KEY, name TEXT NOT NULL, unit TEXT NOT NULL DEFAULT 'g', created_at DATETIME NOT NULL, price REAL, price_unit TEXT, category TEXT, calories REAL, protein REAL, fats REAL, carbs REAL, sugar REAL, fiber REAL, hybrid_water REAL)`,
  `CREATE TABLE IF NOT EXISTS flour_mixes (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at DATETIME NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS flour_mix_components (mix_id TEXT NOT NULL, ingredient_id TEXT NOT NULL, amount REAL NOT NULL, FOREIGN KEY(mix_id) REFERENCES flour_mixes(id), FOREIGN KEY(ingredient_id) REFERENCES ingredients(id))`,
  `CREATE TABLE IF NOT EXISTS recipe_categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#4f46e5', created_at DATETIME NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS recipes (id TEXT PRIMARY KEY, name TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT '', category_id TEXT, servings INTEGER NOT NULL DEFAULT 1, hydration_percent REAL NOT NULL DEFAULT 65.0, created_at DATETIME NOT NULL, FOREIGN KEY(category_id) REFERENCES recipe_categories(id))`,
  `CREATE TABLE IF NOT EXISTS recipe_ingredients (recipe_id TEXT NOT NULL, ingredient_id TEXT NOT NULL, amount REAL NOT NULL, FOREIGN KEY(recipe_id) REFERENCES recipes(id), FOREIGN KEY(ingredient_id) REFERENCES ingredients(id))`,
  `CREATE TABLE IF NOT EXISTS recipe_mixes (recipe_id TEXT NOT NULL, mix_id TEXT NOT NULL, amount REAL NOT NULL, FOREIGN KEY(recipe_id) REFERENCES recipes(id), FOREIGN KEY(mix_id) REFERENCES flour_mixes(id))`,
  `CREATE TABLE IF NOT EXISTS recipe_main_liquids (recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE, ingredient_id TEXT NOT NULL REFERENCES ingredients(id), percentage REAL NOT NULL, PRIMARY KEY (recipe_id, ingredient_id))`,
];

/** Columns the legacy app expects per table — including price_unit and category_id. */
const LEGACY_COLUMNS: Record<string, string[]> = {
  ingredients: ["id", "name", "unit", "created_at", "price", "price_unit", "category", "calories", "protein", "fats", "carbs", "sugar", "fiber", "hybrid_water"],
  flour_mixes: ["id", "name", "created_at"],
  flour_mix_components: ["mix_id", "ingredient_id", "amount"],
  recipe_categories: ["id", "name", "color", "created_at"],
  recipes: ["id", "name", "instructions", "category_id", "servings", "hydration_percent", "created_at"],
  recipe_ingredients: ["recipe_id", "ingredient_id", "amount"],
  recipe_main_liquids: ["recipe_id", "ingredient_id", "percentage"],
  recipe_mixes: ["recipe_id", "mix_id", "amount"],
};

/** Written first so rows referencing them can be inserted without FK failures. */
const EXPORT_ORDER = ["ingredients", "flour_mixes", "flour_mix_components", "recipe_categories", "recipes", "recipe_ingredients", "recipe_mixes", "recipe_main_liquids"];

const source = new DatabaseSync(SOURCE, { open: true });
const target = new DatabaseSync(OUT);
target.exec("PRAGMA foreign_keys = ON;");
for (const ddl of LEGACY_SCHEMA) target.exec(ddl);

/** Parent keys that actually exist, so dangling references left behind by earlier
 * deletes in the original database cannot break the export (the apps ignore them too). */
const liveKeys = new Map<string, Set<string>>();
for (const table of ["ingredients", "flour_mixes", "recipes", "recipe_categories"]) {
  const rows = source.prepare(`SELECT id FROM ${table} WHERE COALESCE(deleted, 0) = 0`).all() as Array<{ id: string }>;
  liveKeys.set(table, new Set(rows.map((r) => r.id)));
}

const PARENTS: Record<string, Array<[string, string]>> = {
  flour_mix_components: [["mix_id", "flour_mixes"], ["ingredient_id", "ingredients"]],
  recipe_ingredients: [["recipe_id", "recipes"], ["ingredient_id", "ingredients"]],
  recipe_main_liquids: [["recipe_id", "recipes"], ["ingredient_id", "ingredients"]],
  recipe_mixes: [["recipe_id", "recipes"], ["mix_id", "flour_mixes"]],
  recipes: [["category_id", "recipe_categories"]],
};

let total = 0;
let skipped = 0;
for (const table of EXPORT_ORDER) {
  const columns = LEGACY_COLUMNS[table]!;
  const rows = source.prepare(`SELECT * FROM ${table} WHERE COALESCE(deleted, 0) = 0`).all() as Array<Record<string, unknown>>;
  if (rows.length === 0) continue;
  const parents = PARENTS[table] ?? [];
  const insert = target.prepare(`INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
  for (const row of rows) {
    const orphanOf = parents.find(([column, parentTable]) => {
      const value = String(row[column] ?? "");
      return value !== "" && !liveKeys.get(parentTable)?.has(value);   // empty means "none", not a broken link
    });
    if (orphanOf) { skipped += 1; console.log(`  ${table}: skipped dangling row (${orphanOf[0]}=${String(row[orphanOf[0]])} has no ${orphanOf[1]})`); continue; }
    try {
      insert.run(...columns.map((c) => {
        const value = row[c];
        // The legacy app stores "no category" as NULL; an empty string would break its FK check.
        if (c === "category_id" && (value === "" || value === undefined)) return null;
        return (value ?? null) as number | string | null;
      }));
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
