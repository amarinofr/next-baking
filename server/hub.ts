#!/usr/bin/env node
/**
 * Hub / launcher for next-baking-app.
 *
 * One process does two jobs:
 *   1. serves the built static frontend (so desktop, laptop and phone can open it over the LAN)
 *   2. serves the replication API backed by plain SQLite (data/app.db)
 *
 * The app itself does NOT need this process to work: every device keeps its own
 * IndexedDB copy. The hub is only how devices converge when they can reach each other.
 */

import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { applyChanges, countDanglingLinks, ensureSchema, getDeviceCursor, hubStats, importLegacyDb, readRecords, setDeviceCursor } from "../src/server/sqliteStore.ts";
import { seedDatabaseFromFile } from "../src/server/seedHub.ts";
import type { RowRecord } from "../src/domain/types.ts";

const ROOT = resolve(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");
const DATA_DIR = process.env.DATA_DIR ?? join(ROOT, "data");
const DB_PATH = process.env.DB_PATH ?? join(DATA_DIR, "app.db");
const PORT = Number(process.env.PORT ?? 7902);
const HOST = process.env.HOST ?? "0.0.0.0";

mkdirSync(DATA_DIR, { recursive: true });

/** IPv4 addresses this machine answers on — printed so you know what to type on the phone or laptop. */
const lanAddresses = (): string[] => Object.values(networkInterfaces())
  .flatMap((list) => list ?? [])
  .filter((info) => !info.internal && String(info.family) === "IPv4")
  .map((info) => info.address);

const db = new DatabaseSync(DB_PATH);
ensureSchema(db);

// First run: fill an empty hub with whatever this checkout carries — a legacy SQLite copy if you dropped one
// next to it, otherwise the tracked seed snapshot. A clone therefore starts with your catalogue instead of an
// empty app, and nothing here ever reaches into another project's live database.
{
  const stats = hubStats(db);
  const total = Object.values(stats).reduce((a, b) => a + b, 0);
  if (total === 0) {
    const candidate = process.env.LEGACY_DB ?? join(ROOT, "data", "app.db.import");
    if (existsSync(candidate)) {
      const imported = importLegacyDb(db, candidate);
      console.log(`[hub] imported ${imported} rows from ${candidate}`);
    } else {
      const seeded = seedDatabaseFromFile(db, join(ROOT, "public", "seed", "state.json"));
      console.log(seeded.applied > 0
        ? `[hub] created ${DB_PATH} and seeded ${seeded.applied} rows from public/seed/state.json`
        : `[hub] ${DB_PATH} is empty (${seeded.reason ?? "no seed available"}) — npm run bootstrap or npm run replicate -- http://<other-hub>:7902`);
    }
  } else {
    console.log(`[hub] database ready at ${DB_PATH}`, stats);
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2", ".map": "application/json",
};

const sendJson = (res: any, status: number, body: unknown) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
};

const readBody = (req: any): Promise<string> =>
  new Promise((resolveBody, rejectBody) => {
    let data = "";
    req.on("data", (chunk: Buffer) => { data += chunk.toString("utf8"); if (data.length > 8_000_000) rejectBody(new Error("body too large")); });
    req.on("end", () => resolveBody(data));
    req.on("error", rejectBody);
  });

const serveStatic = (req: any, res: any) => {
  const urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  let candidate = normalize(join(DIST, urlPath));
  if (!candidate.startsWith(DIST)) { res.writeHead(403).end("forbidden"); return; }

  const attempts: string[] = [];
  if (extname(candidate)) attempts.push(candidate);
  attempts.push(join(candidate, "index.html"), `${candidate}.html`, candidate);

  for (const path of attempts) {
    if (existsSync(path) && statSync(path).isFile()) {
      const body = readFileSync(path);
      res.writeHead(200, {
        "content-type": MIME[extname(path)] ?? "application/octet-stream",
        "content-length": body.length,
        "cache-control": path.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      });
      res.end(body);
      return;
    }
  }

  // In-app routes (/recipes/<id>, /ingredients/<id>/edit, …) have no file of their own:
  // serve the app shell and let the client router draw the right view. Missing *assets* still 404.
  const wantsPage = !extname(urlPath) || extname(urlPath) === ".html";
  const fallback = join(DIST, wantsPage ? "index.html" : "404.html");
  if (existsSync(fallback)) {
    const body = readFileSync(fallback);
    res.writeHead(wantsPage ? 200 : 404, { "content-type": MIME[".html"], "content-length": body.length, "cache-control": "no-cache" });
    res.end(body);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" }).end("Not found. Run `npm run build` first.");
};

const server = createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }

  const url = new URL(req.url ?? "/", "http://localhost");

  try {
    if (url.pathname === "/api/info") {
      const devices = db.prepare("SELECT device_id, cursor FROM sync_meta").all() as Array<{ device_id: string; cursor: number }>;
      sendJson(res, 200, { app: "next-baking-app hub", db: DB_PATH, tables: hubStats(db), dangling_links: countDanglingLinks(db), devices });
      return;
    }

    if (url.pathname === "/api/export.json") {
      const records = readRecords(db, 0);
      const payload = JSON.stringify({ generated_at: new Date().toISOString(), source: "hub", records }, null, 2);
      res.writeHead(200, { "content-type": "application/json", "content-disposition": 'attachment; filename="next-baking-snapshot.json"', "content-length": Buffer.byteLength(payload) });
      res.end(payload);
      return;
    }

    if (url.pathname === "/api/sync" && req.method === "POST") {
      const body = JSON.parse(await readBody(req)) as { deviceId?: string; since?: number; changes?: RowRecord[] };
      const deviceId = String(body.deviceId ?? "unknown");
      const since = Number(body.since ?? getDeviceCursor(db, deviceId));

      const incoming = Array.isArray(body.changes) ? body.changes : [];
      const result = applyChanges(db, incoming);

      const changes = readRecords(db, since);
      const cursor = changes.reduce((max, r) => Math.max(max, r.updated_at), since);
      setDeviceCursor(db, deviceId, cursor);

      sendJson(res, 200, { applied: result.applied, rejected: result.rejected, cursor, changes });
      return;
    }

    if (url.pathname.startsWith("/api/")) { sendJson(res, 404, { error: "unknown endpoint" }); return; }

    serveStatic(req, res);
  } catch (error) {
    const message = String((error as Error)?.stack ?? error);
    console.error("[hub] request failed:", message.split("\n").slice(0, 4).join(" | "));
    sendJson(res, 500, { error: String((error as Error)?.message ?? error) });
  }
});

server.listen(PORT, HOST, () => {
  const ips = (process.env.LAN_IPS ? process.env.LAN_IPS.split(",") : lanAddresses())
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4);

  console.log(`\n  next-baking-app hub`);
  console.log(`  ────────────────────────────────────────`);
  console.log(`  db     ${DB_PATH}`);
  console.log(`  listen http://${HOST}:${PORT}`);
  for (const ip of ips) console.log(`  other devices   http://${ip}:${PORT}   (open there → install as an app)`);
  if (ips.length === 0) console.log(`  other devices   set LAN_IPS=192.168.x.x to print the address your phone should use`);
  console.log(`\n  Ctrl+C to stop\n`);
});

const shutdown = () => { server.close(); db.close(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
