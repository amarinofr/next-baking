#!/usr/bin/env node
/**
 * "I just cloned this repo and it says there is no database." — run this first.
 *
 * It checks the four things that actually matter on a fresh machine and tells you the one command to run next.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hubStats } from "../src/server/sqliteStore.ts";
import { readSeedFile, seedRecords } from "../src/server/seedHub.ts";

const ROOT = resolve(import.meta.dirname, "..");
const DB_PATH = process.env.DB_PATH ?? join(ROOT, "data", "app.db");
const SEED = join(ROOT, "public", "seed", "state.json");
const DIST = join(ROOT, "dist");
const PORT = process.env.PORT ?? "7902";

const problems: string[] = [];
const say = (ok: boolean, label: string, detail: string) => {
  console.log(`  ${ok ? "OK  " : "MISS"} ${label.padEnd(28)} ${detail}`);
  if (!ok) problems.push(label);
};

console.log("\n  next-baking-app · what is present on this machine\n");

// 1) the tracked seed snapshot (this is what carries your catalogue through git)
const seed = readSeedFile(SEED);
if (seed.error) {
  say(false, "seed snapshot", seed.error);
} else {
  const rows = seedRecords(seed.file!);
  const count = rows.records?.length ?? 0;
  say(count > 0, "seed snapshot", `${count} row(s), generated ${seed.file?.generated_at ?? "?"}`);
}

// 2) this machine's hub database — read-only here, because a diagnostic must never create or change data
let dbTotal = 0;
try {
  if (!existsSync(DB_PATH)) throw new Error("does not exist yet — `npm run bootstrap` builds it from the seed snapshot");
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const stats = hubStats(db);
  dbTotal = Object.values(stats).reduce((a, b) => a + b, 0);
  say(true, "hub database", `${DB_PATH} · ${dbTotal} live row(s)`);
  db.close();
} catch (error) {
  say(false, "hub database", String((error as Error)?.message ?? error));
}

// 3) a built frontend (the hub serves dist/)
say(existsSync(DIST), "static build", existsSync(DIST) ? DIST : "run npm run build");

// 4) node new enough for the built-in SQLite driver
say(Number(process.versions.node.split(".")[0]) >= 22, "node version", process.version);

console.log("");
if (!seed.file) {
  console.log("  next step   your catalogue is missing: run `npm run replicate -- http://<machine-with-the-hub>:7902`");
} else if (dbTotal === 0) {
  console.log("  next step   npm run bootstrap     # builds data/app.db from the committed snapshot");
} else if (!existsSync(DIST)) {
  console.log("  next step   npm run build && npm start");
} else {
  console.log("  next step   npm start             # UI + sync hub on :" + PORT);
}
console.log("  other devices point their Sync screen at http://<this-machine-ip>:" + PORT + "/api/sync\n");
