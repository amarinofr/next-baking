#!/usr/bin/env node
/**
 * Give the service worker a cache version that follows the actual bytes of this build.
 *
 * Without this, an installed PWA keeps serving the previous design: its cache name never changed, so the old shell
 * stayed authoritative until something else forced an update. Bumping the version whenever the app's own files change
 * makes the worker re-install, drop the previous cache (see `activate` in public/sw.js) and fetch the current pages.
 *
 * The version is `<git commit>-<hash of what ships>`: two machines that deployed the same code agree on one cache, and a
 * working tree that differs from the commit still gets its own — which is exactly what would otherwise silently serve a
 * stale build after an uncommitted change. Run as part of `npm run build`, before `astro build` copies public/ to dist/.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SW = join(ROOT, "public", "sw.js");

/** Everything that decides what the installed app looks like and knows. */
const SOURCES = ["src", "public", "server", "scripts", "package.json", "astro.config.ts"];

/** Deterministic hash over every shipped source file (the worker itself excluded: it cannot describe its own version). */
function fingerprint(): string {
  const hash = createHash("sha256");

  const walk = (path: string, relative: string) => {
    if (relative === "public/sw.js") return;
    const stats = statSync(path);

    if (stats.isDirectory()) {
      for (const entry of readdirSync(path).sort()) walk(join(path, entry), `${relative}/${entry}`);
      return;
    }

    hash.update(relative);
    hash.update(readFileSync(path));
  };

  for (const entry of SOURCES.sort()) {
    try {
      walk(join(ROOT, entry), entry);
    } catch {
      hash.update(`${entry}:missing`); // a deleted directory is itself a change worth caching for
    }
  }

  return hash.digest("hex").slice(0, 10);
}

let revision = "";
try {
  revision = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
} catch {
  revision = "";
}

const VERSION = `next-baking-${revision || "source"}-${fingerprint()}`;

const source = readFileSync(SW, "utf8");
const updated = source.replace(/const VERSION = "[^"]*";/, `const VERSION = "${VERSION}";`);

if (updated === source) {
  console.log(`[sw-version] already at ${VERSION} — no cache bump needed`);
  process.exit(0);
}

writeFileSync(SW, updated);
console.log(`[sw-version] service worker cache version -> ${VERSION}`);
