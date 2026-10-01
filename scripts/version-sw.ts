#!/usr/bin/env node
/**
 * Give the service worker a new cache version for this build.
 *
 * Without this, an installed PWA can keep serving the previous design: its cache name never changed, so the old
 * shell stayed authoritative until something else forced an update. Bumping the version on every build makes the
 * worker re-install, drop the previous cache (see `activate` in public/sw.js) and fetch the current pages instead.
 *
 * The version is the git commit when available, so two machines that deployed the same code agree on one cache,
 * and a timestamp otherwise. Run as part of `npm run build`.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SW = join(ROOT, "public", "sw.js");

let revision = "";
try {
  revision = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
} catch {
  revision = "";
}
const VERSION = `next-baking-${revision || new Date().toISOString().slice(0, 10)}`;

const source = readFileSync(SW, "utf8");
const updated = source.replace(/const VERSION = "[^"]*";/, `const VERSION = "${VERSION}";`);

if (updated === source) {
  console.error(`[sw-version] could not find the VERSION line in ${SW}`);
  process.exit(1);
}

writeFileSync(SW, updated);
console.log(`[sw-version] service worker cache version -> ${VERSION}`);
