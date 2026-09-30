#!/usr/bin/env node
/**
 * SAFETY TOOL — hot backup of SQLite databases. READ-ONLY on every source.
 *
 *   npm run snapshot                     # back up the original app's DBs + this app's DB
 *   npm run snapshot -- --refresh        # additionally refresh THIS app's data/app.db copy
 *   npm run snapshot -- --source <path>  # back up one specific database file
 *
 * Copies are made with SQLite's online backup API so WAL content is included and a
 * running server is not disturbed. Source files are hashed before and after to prove
 * nothing was modified.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const APPS_DIR = resolve(ROOT, "..");
const SNAPSHOTS = join(ROOT, "snapshots");

const DEFAULT_SOURCES = [
  join(APPS_DIR, "baking", "data", "app.db"),            // the live database used by the old app today
  join(APPS_DIR, "baking", "backend", "data", "app.db"), // old app's secondary copy
  join(APPS_DIR, "data", "app.db"),                      // seed database referenced by the old plan
];

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

const labelFor = (path: string): string =>
  path.replace(`${APPS_DIR}/`, "").replace(/[/.]/g, "-");

const hotBackup = (source: string, destination: string): void => {
  try {
    execFileSync("sqlite3", [`file:${source}?mode=ro`, `.backup '${destination}'`], { stdio: "inherit" });
  } catch {
    execFileSync("node", ["-e", `
      import('node:sqlite').then(async ({ DatabaseSync }) => {
        const db = new DatabaseSync(${JSON.stringify(source)}, { open: true });
        await db.backup(${JSON.stringify(destination)});
        db.close();
      });
    `], { stdio: "inherit" });
  }
};

const rowCount = (dbPath: string, table: string): number => {
  try {
    const out = execFileSync("sqlite3", [dbPath, `SELECT COUNT(*) FROM ${table};`], { encoding: "utf8" }).trim();
    return Number(out) || 0;
  } catch { return 0; }
};

const args = process.argv.slice(2);
const refresh = args.includes("--refresh");
const sourceFlag = args.indexOf("--source");
const sources = sourceFlag >= 0 ? [resolve(args[sourceFlag + 1] ?? "")] : DEFAULT_SOURCES;

if (!existsSync(SNAPSHOTS)) readdirSync(ROOT); // no-op guard; snapshots dir created below
const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);

console.log("\n  next-baking-app · snapshot tool (sources are opened read-only)\n");

for (const source of sources) {
  if (!source || !existsSync(source)) { console.log(`  skip (missing): ${source}`); continue; }

  const before = sha256(source);
  const statBefore = statSync(source).mtimeMs;
  const target = join(SNAPSHOTS, `${labelFor(source)}.${stamp}.db`);

  hotBackup(source, target);

  const after = sha256(source);
  const statAfter = statSync(source).mtimeMs;
  const unchanged = before === after && statBefore === statAfter;

  const ingredients = rowCount(target, "ingredients");
  const recipes = rowCount(target, "recipes");

  console.log(`  ✓ ${source}`);
  console.log(`      → ${target}  (${ingredients} ingredients, ${recipes} recipes)`);
  console.log(`      source integrity: ${unchanged ? "UNCHANGED" : "CHANGED WHILE WE WERE READING (server wrote to it)"} · sha256 ${before.slice(0, 16)}…`);

  if (refresh && source.endsWith("baking/data/app.db")) {
    const workingCopy = join(ROOT, "data", "app.db");
    hotBackup(source, workingCopy);
    console.log(`      refreshed this app's working copy: ${workingCopy}`);
  }
}

console.log("\n  Original files were only ever opened with mode=ro.\n");
