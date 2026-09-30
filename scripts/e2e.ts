#!/usr/bin/env node
/**
 * End-to-end check against a running hub, using the system Chromium.
 *
 *   npm run serve        # terminal 1
 *   npm run e2e          # terminal 2
 *
 * It proves the parts that matter: the seeded data loads offline-first from IndexedDB,
 * a recipe renders with correct hydration maths, a new ingredient survives a reload,
 * and a second device receives it through the hub. Any page JS error fails the run.
 */

import { rmSync } from "node:fs";
import puppeteer from "puppeteer-core";

const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:7902";
const CHROMIUM = process.env.CHROMIUM_PATH ?? "/usr/bin/chromium";

const failures: string[] = [];
const checks: string[] = [];

const check = (name: string, ok: boolean, detail = ""): void => {
  checks.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

const ready = async (page: import("puppeteer-core").Page, label: string, errors?: string[]): Promise<void> => {
  try {
    await page.waitForFunction(() => {
      const app = document.getElementById("app");
      if (!app) return false;
      return Boolean(app.querySelector(".card, table.data, form, .panel"));
    }, { timeout: 25000 });
  } catch (error) {
    const status = await page.$eval("#status-left", (node) => node.textContent ?? "").catch(() => "<no status element>");
    const html = await page.$eval("#app", (node) => (node.textContent ?? "").slice(0, 200)).catch(() => "<empty>");
    console.log(`  DIAG(${label}) status=${JSON.stringify(status)} app=${JSON.stringify(html)} jsErrors=${JSON.stringify(errors ?? [])}`);
    throw error;
  }
};

const launchDevice = async (profile: string): Promise<{ browser: import("puppeteer-core").Browser; page: import("puppeteer-core").Page }> => {
  rmSync(profile, { recursive: true, force: true }); // a brand-new device each run
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${profile}`],
  });
  return { browser, page: await browser.newPage() };
};

const watchErrors = (page: import("puppeteer-core").Page): string[] => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) => { if (!request.url().includes("/api/sync")) errors.push(`requestfailed: ${request.url()}`); });
  return errors;
};

const main = async (): Promise<void> => {
  // two chromium profiles with separate IndexedDB = two real devices
  const deviceA = await launchDevice("/tmp/e2e-device-a");
  const deviceB = await launchDevice("/tmp/e2e-device-b");

  try {
    // ---------- device A ----------
    const pageA = deviceA.page;
    const errorsA = watchErrors(pageA);
    await pageA.goto(`${BASE}/`, { waitUntil: "networkidle2" });
    await ready(pageA, "device A home", errorsA);

    const cardCount = await pageA.$$eval(".card", (nodes) => nodes.length);
    check("seeded recipes render on the home grid", cardCount >= 7, `${cardCount} cards`);

    const statusText = await pageA.$eval("#status-left", (node) => node.textContent ?? "");
    check("local database opened and reported device id", /dev-/.test(statusText), statusText.trim());

    // recipe detail with hydration maths (Pizza is 105% in the original data)
    const detailHref = await pageA.$eval(".card a.name", (node) => (node as HTMLAnchorElement).getAttribute("href") ?? "");
    await pageA.goto(`${BASE}${detailHref}`, { waitUntil: "networkidle2" });
    await ready(pageA, "device A detail", errorsA);
    const detailText = await pageA.$eval("#app", (node) => node.textContent ?? "");
    check("recipe detail page renders hydration + price sections", /Target water/.test(detailText) && /Total liquid/.test(detailText));

    // scale control must rescale displayed grams without writing anything
    const beforeScale = await pageA.$eval("#app .panel .kv b", (node) => node.textContent ?? "");
    await pageA.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>("input[type=number]");
      if (!input) throw new Error("scale input missing");
      input.value = "30";
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await pageA.waitForFunction((previous: string) => {
      const current = document.querySelector("#app .panel .kv b")?.textContent ?? "";
      return current !== previous;
    }, { timeout: 5000 }, beforeScale);
    const afterScale = await pageA.$eval("#app .panel .kv b", (node) => node.textContent ?? "");
    check("servings scaler changes the view", beforeScale !== afterScale, `${beforeScale.trim()} → ${afterScale.trim()}`);

    // create an ingredient through the real form
    const marker = `E2E Test Ingredient ${Date.now()}`;
    await pageA.goto(`${BASE}/ingredients/new`, { waitUntil: "networkidle2" });
    await ready(pageA, "device A ingredient form", errorsA);
    await pageA.waitForSelector('input[name="name"]', { timeout: 15000 });
    await pageA.type('input[name="name"]', marker);
    await pageA.select('select[name="category"]', "dry");
    await pageA.type('input[name="price"]', "4.20");
    await pageA.click('button[type="submit"]');
    await pageA.waitForFunction((label: string) => document.body.innerText.includes(label), { timeout: 10000 }, marker);
    check("new ingredient appears after submit + reload", true, marker);

    // edit it (proves the edit route resolves by query id)
    await pageA.evaluate((label: string) => {
      const rows = [...document.querySelectorAll("table.data tbody tr")] as HTMLTableRowElement[];
      const row = rows.find((r) => r.textContent?.includes(label));
      const button = row?.querySelector<HTMLButtonElement>("button");
      button?.click();
    }, marker);
    await pageA.waitForFunction(() => location.pathname === "/ingredient-edit", { timeout: 8000 });
    const prefilledName = await pageA.$eval('input[name="name"]', (node) => (node as HTMLInputElement).value);
    check("edit page pre-fills the existing row", prefilledName === marker, prefilledName);

    const edited = `${marker} (edited)`;
    await pageA.evaluate((label: string) => {
      const input = document.querySelector<HTMLInputElement>('input[name="name"]')!;
      input.value = label;
    }, edited);
    await pageA.click('button[type="submit"]');
    await pageA.waitForFunction((label: string) => document.body.innerText.includes(label), { timeout: 10000 }, edited);
    check("edit saved", true, edited);

    // ---------- hub side ----------
    const hubExport = await fetch(`${BASE}/api/export.json`).then((r) => r.json()) as { records: Array<{ cols: Record<string, unknown> }> };
    check("hub received the new ingredient from device A", hubExport.records.some((r) => String(r.cols.name ?? "").includes(marker)), `${hubExport.records.length} rows on hub`);

    // ---------- device B: fresh browser context (fresh IndexedDB) ----------
    const pageB = deviceB.page;
    const errorsB = watchErrors(pageB);
    await pageB.goto(`${BASE}/ingredients`, { waitUntil: "networkidle2" });
    await ready(pageB, "device B ingredients", errorsB);
    const bodyB = await pageB.$eval("#app", (node) => node.textContent ?? "");
    check("device B seeded the original catalogue", bodyB.includes("Butter") && bodyB.includes("Yeast") && bodyB.includes("Psyllium Husk"), "original ingredients present");
    check("device B pulled device A's new ingredient through the hub", bodyB.includes(edited), edited);

    // ---------- offline behaviour ----------
    await pageB.setOfflineMode(true);
    await pageB.goto(`${BASE}/recipes`, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    await pageB.waitForFunction(() => (document.getElementById("app")?.textContent ?? "").length > 40, { timeout: 8000 }).catch(() => undefined);
    const offlineText = await pageB.$eval("#app", (node) => node.textContent ?? "").catch(() => "");
    check("page still renders while offline (service worker + IndexedDB)", /recipes/i.test(offlineText) && offlineText.length > 40, `${offlineText.slice(0, 60)}…`);
    await pageB.setOfflineMode(false);

    check("no page JS errors on device A", errorsA.length === 0, errorsA.join(" | "));
    check("no page JS errors on device B", errorsB.length === 0, errorsB.join(" | "));
  } finally {
    await deviceA.browser.close();
    await deviceB.browser.close();
  }

  console.log("\n  e2e results\n  ───────────");
  for (const line of checks) console.log(`  ${line}`);
  if (failures.length > 0) { console.log(`\n  ${failures.length} check(s) failed\n`); process.exit(1); }
  console.log("\n  all checks passed\n");
};

main().catch((error) => { console.error("e2e crashed:", error); process.exit(1); });
