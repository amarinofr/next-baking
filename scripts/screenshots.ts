#!/usr/bin/env node
/**
 * Visual snapshots: drives the real UI and writes PNGs so design changes can actually be looked at.
 *
 *   npm run serve                       # hub + built app on :7902 (or point E2E_BASE elsewhere)
 *   npm run shots                       # writes /tmp/ui-shots/*.png
 *
 * Screens captured: recipe grid, recipes table, recipe detail (+ scaled), ingredients, flour mixes,
 * mix editor, the two big forms, sync screen, and the main screens at phone width.
 */

import puppeteer from "puppeteer-core";
import { mkdirSync, rmSync } from "node:fs";

const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:7902";
const OUT = process.env.SHOTS_DIR ?? "/tmp/ui-shots";
const PROFILE = "/tmp/e2e-shots";

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
rmSync(PROFILE, { recursive: true, force: true });

const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${PROFILE}`],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });

const settle = (ms = 1100): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const click = async (selector: string): Promise<void> => {
  await page.evaluate((sel: string) => { const node = document.querySelector(sel); if (node) node.dispatchEvent(new MouseEvent("click", { bubbles: true })); }, selector);
};
const pathIs = (regex: RegExp) => page.waitForFunction((source: string) => new RegExp(source).test(location.pathname), { timeout: 20000, polling: 200 }, regex.source);

const shot = async (name: string): Promise<void> => { await page.screenshot({ path: `${OUT}/${name}.png` }); console.log(`  ${OUT}/${name}.png`); };

try {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle2" });
  await page.waitForFunction(() => document.querySelectorAll("table.data tbody tr").length > 0, { timeout: 25000 });
  await settle(1400);
  await shot("01-recipe-index");

  // the old grid route alias still resolves to the same index
  await page.goto(`${BASE}/recipes`, { waitUntil: "networkidle2" });
  await pathIs(/^\/recipes$/); await settle(900);
  await shot("02-recipe-index-alias");

  await click("table.data tbody tr td.dim");            // whole row is clickable
  await pathIs(/^\/recipes\/[^/]+$/); await settle(1300);
  await shot("03-recipe-detail");

  await page.evaluate(() => { const input = document.querySelector("#scale-input") as HTMLInputElement | null; if (input) { input.value = "6"; input.dispatchEvent(new Event("input", { bubbles: true })); } });
  await settle(700);
  await shot("04-recipe-detail-scaled");

  await click('nav.tabs [data-tab="ingredients"]');
  await pathIs(/^\/ingredients$/); await settle(900);
  await shot("05-ingredients");

  await click('nav.tabs [data-tab="mixes"]');
  await pathIs(/^\/mixes$/); await settle(900);
  await shot("06-mixes");

  await click("table.data tbody tr td.dim");
  await pathIs(/^\/mixes\/[^/]+\/edit$/); await settle(900);
  await shot("07-mix-editor");

  await page.goto(`${BASE}/settings`, { waitUntil: "networkidle2" });
  await settle(900);
  await shot("08-settings");

  await page.goto(`${BASE}/recipes/new`, { waitUntil: "networkidle2" });
  await pathIs(/^\/recipes\/new$/); await settle(1000);
  await shot("09-recipe-form");

  await page.goto(`${BASE}/ingredients/new`, { waitUntil: "networkidle2" });
  await pathIs(/^\/ingredients\/new$/); await settle(1000);
  await shot("10-ingredient-form");

  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(`${BASE}/`, { waitUntil: "networkidle2" });
  await settle(1200);
  await shot("09-phone-index");

  await click("table.data tbody tr td.dim");
  await pathIs(/^\/recipes\/[^/]+$/); await settle(1200);
  await shot("10-phone-recipe");

  await click('nav.tabs [data-tab="ingredients"]');
  await pathIs(/^\/ingredients$/); await settle(900);
  await shot("11-phone-ingredients");

  await click('nav.tabs [data-tab="mixes"]');
  await pathIs(/^\/mixes$/); await settle(900);
  await shot("12-phone-mixes");

  await page.goto(`${BASE}/settings`, { waitUntil: "networkidle2" });
  await settle(900);
  await shot("13-phone-settings");
} finally {
  await browser.close();
}
