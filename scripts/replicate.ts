#!/usr/bin/env node
/**
 * Copy rows between two hubs of this app — the "make my laptop hold the same database as my desktop" command.
 *
 *   npm run replicate -- http://192.168.1.20:7902              # pull their rows into this hub (read-only on them)
 *   npm run replicate -- http://192.168.1.20:7902 --push       # two-way: send ours, take theirs, one round-trip
 *   npm run replicate -- http://host:7902/api/sync             # same thing, either URL form works
 *   DB_PATH=data/app.db npm run replicate -- ...               # which local database participates
 *
 * Merge rule is exactly the one the devices use: every row carries (updated_at, origin) and both sides keep the
 * greater version; tombstones travel like any other write so deletes stay deleted. It merges per row, so pulling
 * does not roll back unrelated work on either machine — no file copying, no whole-database overwrite.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { applyChanges, ensureSchema, hubStats, readRecords } from "../src/server/sqliteStore.ts";
import type { RowRecord } from "../src/domain/types.ts";

const ROOT = resolve(import.meta.dirname, "..");
const DB_PATH = process.env.DB_PATH ?? join(ROOT, "data", "app.db");

const arg = process.argv[2];
const push = process.argv.includes("--push");

if (!arg || !/^https?:\/\//i.test(arg)) {
  console.error("\n  usage: npm run replicate -- http://<other-machine>:7902 [--push]\n");
  process.exit(1);
}

const remote = new URL(arg);
const base = `${remote.protocol}//${remote.host}`;
const deviceId = `replicate-${hostname()}`;

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
ensureSchema(db);

const before = hubStats(db);

const show = (label: string, stats: Record<string, number>) => {
  const total = Object.values(stats).reduce((a, b) => a + b, 0);
  console.log(`  [replicate] ${label}: ${total} rows (${Object.entries(stats).map(([t, n]) => `${t} ${n}`).join(", ")})`);
};

try {
  if (push) {
    const changes = readRecords(db, 0);
    console.log(`\n  [replicate] pushing ${changes.length} local row(s) to ${base}/api/sync as "${deviceId}"`);
    const res = await fetch(`${base}/api/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId, since: 0, changes }),
    });
    if (!res.ok) throw new Error(`hub refused the push (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const reply = (await res.json()) as { applied?: number; rejected?: number; changes?: RowRecord[] };
    console.log(`  [replicate] hub stored ${reply.applied ?? "?"} row(s), skipped ${reply.rejected ?? "?"} older one(s)`);

    const incoming = Array.isArray(reply.changes) ? reply.changes : [];
    const merged = applyChanges(db, incoming);
    console.log(`  [replicate] applied ${merged.applied} of ${incoming.length} row(s) coming back (${merged.rejected} were not newer here)`);
  } else {
    console.log(`\n  [replicate] pulling from ${base}/api/export.json`);
    const res = await fetch(`${base}/api/export.json`, { cache: "no-store" });
    if (!res.ok) throw new Error(`hub refused the export (${res.status})`);
    const payload = (await res.json()) as { records?: RowRecord[] };
    const incoming = Array.isArray(payload.records) ? payload.records : [];
    if (incoming.length === 0) throw new Error("the hub returned no rows");
    const merged = applyChanges(db, incoming);
    console.log(`  [replicate] applied ${merged.applied} of ${incoming.length} row(s) (${merged.rejected} were not newer here)`);
  }

  show("local store before", before);
  show("local store after", hubStats(db));
  console.log("\n  [replicate] devices pointed at this hub pick the changes up automatically (or press Sync now)\n");
} catch (error) {
  console.error(`\n  [replicate] ${String((error as Error)?.message ?? error)}`);
  console.error("  [replicate] is the other machine running `npm start`, and is its port reachable from here?\n");
  process.exitCode = 1;
} finally {
  db.close();
}
