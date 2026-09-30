#!/usr/bin/env node
/**
 * SAFETY TOOL — bring THIS app's working copy (`data/app.db`) up to date with your original
 * app, without overwriting anything you may have changed here.
 *
 *   npm run refresh            # snapshot first, then merge the newest snapshot into data/app.db
 *   npm run refresh -- --source <path-to-snapshot>
 *
 * Merge rules:
 *   - sources are opened read-only; the original app is never written to;
 *   - rows are applied last-write-wins, so a newer edit made in this app is NOT clobbered by
 *     an older row coming from the original;
 *   - nothing is ever deleted here: rows that disappeared in the original stay until you delete
 *     them in the UI (so a stale snapshot can never silently lose data);
 *   - run this while the hub is stopped if you want a completely quiet migration.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { countDanglingLinks, ensureSchema, importLegacyDb } from "../src/server/sqliteStore.ts";

const ROOT = resolve(import.meta.dirname, "..");
const SNAPSHOTS = join(ROOT, "snapshots");
const TARGET = join(ROOT, "data", "app.db");

const sourceArg = (): string | undefined => {
  const index = process.argv.indexOf("--source");
  return index >= 0 ? process.argv[index + 1] : undefined;
};

/** Newest hot snapshot of the ORIGINAL app's live database (empty legacy copies are ignored). */
const newestOriginalSnapshot = (): string => {
  if (!existsSync(SNAPSHOTS)) throw new Error(`no snapshots directory — run "npm run snapshot" first`);
  const candidates = readdirSync(SNAPSHOTS)
    .filter((name) => /^baking-data.*\.db$/.test(name))
    .map((name) => join(SNAPSHOTS, name))
    .sort();

  const nonEmpty = candidates.filter((path) => {
    try {
      const probe = new DatabaseSync(path, { open: true });
      try { return (probe.prepare("SELECT COUNT(*) AS n FROM ingredients").get() as { n: number }).n > 0; }
      finally { probe.close(); }
    } catch { return false; }
  });

  const pick = nonEmpty.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs).pop();
  if (!pick) throw new Error(`no non-empty snapshot found in ${SNAPSHOTS} — run "npm run snapshot" first`);
  return pick;
};

const main = async (): Promise<void> => {
  const source = sourceArg() ?? newestOriginalSnapshot();
  if (!existsSync(source)) throw new Error(`snapshot not found: ${source}`);

  console.log(`[refresh] merging ${source} into ${TARGET}`);

  const db = new DatabaseSync(TARGET);
  try {
    ensureSchema(db);
    const before = countDanglingLinks(db);
    const applied = importLegacyDb(db, source, "refresh");
    const after = countDanglingLinks(db);

    console.log(`[refresh] applied ${applied} row(s) (last-write-wins; nothing deleted)`);
    if (Object.keys(after).length > 0) console.log(`[refresh] link rows whose parent is missing (kept as-is, reported only):`, after, before === after ? "" : "(changed)");

    for (const table of ["ingredients", "flour_mixes", "recipes", "recipe_categories"]) {
      const live = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE deleted = 0`).get() as { n: number };
      console.log(`[refresh] ${table}: ${live.n} live row(s)`);
    }
    console.log('[refresh] done — confirm with `npm run verify:data`');
  } finally {
    db.close();
  }
};

main().catch((error: unknown) => { console.error(String((error as Error)?.message ?? error)); process.exitCode = 1; });
