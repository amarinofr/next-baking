#!/usr/bin/env node
/**
 * DATA FIDELITY CHECK — compares this app's working database against the newest hot
 * snapshot taken from the original app, row by row.
 *
 *   npm run verify:data            # newest snapshot vs data/app.db
 *   npm run verify:data -- <snapshot.db>
 *
 * Rules: the original is read-only; replication columns (updated_at/deleted/origin) are
 * ignored; rows we deleted on purpose (tombstones) are reported separately instead of
 * as a failure. Anything the original has and we do not => exit code 1.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const WORKING = join(ROOT, "data", "app.db");

/** Tables the original app owns. `recipe_categories` is intentionally unmodelled here. */
const LEGACY_TABLES: Array<{ table: string; keys: string[]; columns: string[] }> = [
  { table: "ingredients", keys: ["id"], columns: ["id", "name", "unit", "created_at", "price", "price_unit", "category", "calories", "protein", "fats", "carbs", "sugar", "fiber", "hybrid_water"] },
  { table: "flour_mixes", keys: ["id"], columns: ["id", "name", "created_at"] },
  { table: "flour_mix_components", keys: ["mix_id", "ingredient_id"], columns: ["mix_id", "ingredient_id", "amount"] },
  { table: "recipes", keys: ["id"], columns: ["id", "name", "instructions", "category_id", "servings", "hydration_percent", "created_at"] },
  { table: "recipe_ingredients", keys: ["recipe_id", "ingredient_id"], columns: ["recipe_id", "ingredient_id", "amount"] },
  { table: "recipe_mixes", keys: ["recipe_id", "mix_id"], columns: ["recipe_id", "mix_id", "amount"] },
  { table: "recipe_main_liquids", keys: ["recipe_id", "ingredient_id"], columns: ["recipe_id", "ingredient_id", "percentage"] },
];

const query = (db: string, sql: string): string[] => {
  try {
    return execFileSync("sqlite3", [db, sql], { encoding: "utf8" }).split("\n").map((line) => line.trim()).filter(Boolean);
  } catch (error) {
    throw new Error(`sqlite3 query failed on ${db}: ${String((error as Error).message)}`);
  }
};

const rowsOf = (db: string, spec: { table: string; keys: string[]; columns: string[] }, includeDeleted = false): Map<string, string> => {
  const hasReplicationColumns = query(db, `PRAGMA table_info(${spec.table});`).some((line) => line.includes("deleted"));
  const where = includeDeleted && hasReplicationColumns ? "" : (hasReplicationColumns ? "WHERE deleted = 0" : "");
  const select = `${spec.columns.join(", ")} FROM ${spec.table} ${where}`.trim();
  const map = new Map<string, string>();
  for (const line of query(db, `SELECT ${select};`)) {
    const values = line.split("|");
    const key = spec.keys.map((_, index) => values[index] ?? "").join("::");
    map.set(key, values.join("|"));
  }
  return map;
};

const newestSnapshot = (): string => {
  // works from the main checkout *and* from a git worktree, where snapshots/ lives in the parent project
  const dirs = [join(ROOT, "snapshots"), resolve(ROOT, "../snapshots"), resolve(ROOT, "../../snapshots")].filter((dir) => existsSync(dir));
  const candidates = dirs.flatMap((dir) => readdirSync(dir).filter((name) => /^baking-data.*\.db$/.test(name)).map((name) => join(dir, name)));

  // Newest by modification time, and only snapshots that actually contain data: some runs
  // backed up empty legacy copies, and comparing against one of those proves nothing.
  const dated = candidates.filter((path) => !path.endsWith("-wal") && !path.endsWith("-shm"));
  const nonEmpty = dated.filter((path) => {
    try {
      const out = execFileSync("sqlite3", [`file:${path}?mode=ro`, "SELECT COUNT(*) FROM ingredients;"], { encoding: "utf8" }).trim();
      return Number(out) > 0;
    } catch { return false; }
  });

  const pick = nonEmpty.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs).pop();
  if (!pick) throw new Error("no usable snapshot found — run `npm run snapshot` first");
  return pick;
};

/where a row's parent is missing in the original itself => we intentionally do not copy it/
const FOREIGN_PARENTS: Record<string, Array<[string, string]>> = {
  flour_mix_components: [["mix_id", "flour_mixes"], ["ingredient_id", "ingredients"]],
  recipe_ingredients: [["recipe_id", "recipes"], ["ingredient_id", "ingredients"]],
  recipe_mixes: [["recipe_id", "recipes"], ["mix_id", "flour_mixes"]],
  recipe_main_liquids: [["recipe_id", "recipes"], ["ingredient_id", "ingredients"]],
};

function danglingInOriginal(snapshot: string, spec: { table: string; keys: string[] }, key: string): boolean {
  const parents = FOREIGN_PARENTS[spec.table] ?? [];
  if (parents.length === 0) return false;
  const values = key.split("::");
  return parents.some(([column, parentTable], index) => {
    const value = values[index] ?? "";
    const escaped = value.replace(/'/g, "''");
    const found = query(`file:${snapshot}?mode=ro`, `SELECT 1 AS ok FROM ${parentTable} WHERE id = '${escaped}' LIMIT 1;`);
    return found.length === 0;
  });
}

const args = process.argv.slice(2);
const snapshot = args[0] ? resolve(args[0]) : newestSnapshot();

console.log(`\n  next-baking-app · data fidelity check\n  reference : ${snapshot}\n  working   : ${WORKING}\n`);

let problems = 0;

for (const spec of LEGACY_TABLES) {
  const original = rowsOf(`file:${snapshot}?mode=ro`, spec);
  const ours = rowsOf(WORKING, spec);
  const oursAll = rowsOf(WORKING, spec, true);

  const missing: string[] = [];
  const orphans: string[] = [];
  const different: string[] = [];
  for (const [key, value] of original) {
    const mine = ours.get(key);
    if (mine === undefined) {
      if (oursAll.has(key)) continue;
      if (danglingInOriginal(snapshot, spec, key)) orphans.push(value); else missing.push(value);
    } else if (mine !== value) different.push(`${key}: [${value}] -> [${mine}]`);
  }

  const extra: string[] = [];
  for (const [key, value] of ours) if (!original.has(key)) extra.push(value);

  const tombstoned = [...oursAll.keys()].filter((key) => !ours.has(key)).length;

  const ok = missing.length === 0 && different.length === 0;
  if (!ok) problems += 1;
  console.log(`  ${ok ? "OK  " : "FAIL"} ${spec.table.padEnd(22)} ${ours.size} live row(s)${tombstoned ? `, ${tombstoned} deleted here` : ""}${extra.length ? `, ${extra.length} added here` : ""}${orphans.length ? `, ${orphans.length} dangling in the original (skipped on purpose)` : ""}`);
  for (const line of missing.slice(0, 8)) console.log(`        missing from this app: ${line}`);
  for (const line of different.slice(0, 8)) console.log(`        changed: ${line}`);
  for (const line of extra.slice(0, 8)) console.log(`        only in this app: ${line}`);
}

console.log(problems === 0 ? "\n  Every row of the original is present and identical.\n" : `\n  ${problems} table(s) differ — investigate before relying on this copy.\n`);
process.exit(problems === 0 ? 0 : 1);
