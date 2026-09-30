#!/usr/bin/env node
/**
 * End-to-end check against a running hub, driving the real UI in two isolated Chromium
 * profiles (= two devices with separate IndexedDB stores).
 *
 *   npm run serve        # terminal 1
 *   npm run e2e          # terminal 2
 *
 * Covers: seeded data loads, recipe maths + servings scaler, create → edit → propagate to a
 * second device through the hub, delete propagation (tombstones), offline rendering, and
 * "no page JS errors anywhere". The test cleans up its own data at the end.
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

type Page = import("puppeteer-core").Page;

const launchDevice = async (profile: string): Promise<{ browser: import("puppeteer-core").Browser; page: Page }> => {
  rmSync(profile, { recursive: true, force: true }); // brand-new device each run
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${profile}`],
  });
  const page = await browser.newPage();
  return { browser, page };
};

const watchErrors = (page: Page): string[] => {
  const errors: string[] = [];
  page.on("pageerror", (error: unknown) => errors.push(`pageerror: ${String((error as Error)?.message ?? error)}`));
  page.on("requestfailed", (request) => { if (!request.url().includes("/api/sync")) errors.push(`requestfailed: ${request.url()}`); });
  page.on("dialog", async (dialog) => { await dialog.accept(); }); // confirm() dialogs in the UI
  return errors;
};

/** Wait until a view has actually rendered (the app renders after opening IndexedDB). */
const ready = async (page: Page, label: string, errors?: string[]): Promise<void> => {
  try {
    await page.waitForFunction(() => Boolean(document.querySelector("#app .card, #app table.data, #app form, #app .panel")), { timeout: 25000 });
  } catch (error) {
    const status = await page.$eval("#status-left", (n) => n.textContent ?? "").catch(() => "<none>");
    const text = await page.$eval("#app", (n) => (n.textContent ?? "").slice(0, 160)).catch(() => "<empty>");
    console.log(`  DIAG(${label}) status=${JSON.stringify(status)} app=${JSON.stringify(text)} jsErrors=${JSON.stringify(errors ?? [])} (${String((error as Error).message)})`);
    throw error;
  }
};

const bodyText = (page: Page): Promise<string> => page.$eval("#app", (node) => node.textContent ?? "");

/** Click an action button inside the table row whose text contains `label`. */
const clickRowAction = async (page: Page, label: string, buttonIndex = 0): Promise<void> => {
  const clicked = await page.evaluate((needle: string, index: number) => {
    const rows = [...document.querySelectorAll("table.data tbody tr")] as HTMLTableRowElement[];
    const row = rows.find((r) => r.textContent?.includes(needle));
    const buttons = row ? [...row.querySelectorAll<HTMLButtonElement>("button")] : [];
    const button = buttons[index];
    if (!button) return false;
    button.click();
    return true;
  }, label, buttonIndex);
  if (!clicked) throw new Error(`could not find a table row containing "${label}" (button ${buttonIndex})`);
};

/** Retry an interaction a few times: the app may re-render while a background sync lands. */
const settleTry = async <T>(label: string, action: () => Promise<T>, attempts = 5): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      const message = String((error as Error)?.message ?? error);
      if (!/detached|not found|no element/i.test(message)) break;
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }
  throw new Error(`${label}: ${String((lastError as Error)?.message ?? lastError)}`);
};

/** Type into a field deterministically (clear first, dispatch change so listeners react). */
const setValue = async (page: Page, selector: string, value: string): Promise<void> => {
  await settleTry(`set ${selector}`, () => page.evaluate((sel: string, val: string) => {
    const node = document.querySelector(sel) as HTMLInputElement | HTMLSelectElement | null;
    if (!node) throw new Error(`field not found: ${sel}`);
    node.value = val;
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  }, selector, value));
};

/** Force a synchronous sync through the Sync page so assertions are deterministic. */
const forceSync = async (page: Page): Promise<string> => {
  await page.goto(`${BASE}/settings`, { waitUntil: "networkidle2" });
  await ready(page, "settings");
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button")] as HTMLButtonElement[];
    buttons.find((b) => b.textContent?.trim() === "Sync now")?.click();
  });
  await page.waitForFunction(() => /pushed \d+ row\(s\), applied \d+/.test(document.body.innerText), { timeout: 20000 });
  return page.$eval("#app", (node) => (node.textContent ?? "").match(/pushed \d+ row\(s\), applied \d+ row\(s\) from [^\s]+/)?.[0] ?? "no sync summary");
};

/** Tombstone anything the test created so repeated runs start from the same data. */
const removeMarkerFromHub = async (needle: string): Promise<string> => {
  const hub = await fetch(`${BASE}/api/export.json`).then((res) => res.json()) as {
    records: Array<{ table: string; pk: string; cols: Record<string, unknown>; updated_at: number; origin: string; deleted?: boolean }>;
  };
  const rows = hub.records.filter((row) => !row.deleted && row.table === "ingredients" && String(row.cols.name ?? "").includes(needle));
  if (rows.length === 0) return "nothing to clean";
  const changes = rows.map((row) => ({ ...row, updated_at: Date.now(), deleted: true, origin: "e2e-cleaner" }));
  const res = await fetch(`${BASE}/api/sync`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceId: "e2e-cleaner", since: 0, changes }) });
  if (!res.ok) return `hub refused cleanup (${res.status})`;
  const outcome = (await res.json()) as { applied: number; rejected: number };
  return `tombstoned ${outcome.applied} row(s), rejected ${outcome.rejected}`;
};

const main = async (): Promise<void> => {
  const deviceA = await launchDevice("/tmp/e2e-device-a");
  const deviceB = await launchDevice("/tmp/e2e-device-b");
  const pageA = deviceA.page;
  const pageB = deviceB.page;
  const errorsA = watchErrors(pageA);
  const errorsB = watchErrors(pageB);

  let step = "startup";
  const marker = `E2E Ingredient ${Date.now()}`;

  try {
        step = "device A read";
    // ---------- device A: read the seeded catalogue ----------
    await pageA.goto(`${BASE}/`, { waitUntil: "networkidle2" });
    await ready(pageA, "device A home", errorsA);

    const cardCount = await pageA.$$eval(".card", (nodes) => nodes.length);
    check("seeded recipes render on the home grid", cardCount >= 7, `${cardCount} cards`);

    const statusText = await pageA.$eval("#status-left", (n) => n.textContent ?? "");
    check("local database opened with a per-device id", /dev-/.test(statusText), statusText.trim());

    // recipe detail + hydration maths + servings scaler (read-only view transform)
    const href = await pageA.$eval(".card a.name", (n) => (n as HTMLAnchorElement).getAttribute("href") ?? "/");
    await pageA.goto(`${BASE}${href}`, { waitUntil: "networkidle2" });
    await ready(pageA, "device A recipe detail", errorsA);
    const detail = await bodyText(pageA);
    check("recipe detail shows hydration + price sections", /Target water/.test(detail) && /Total liquid/.test(detail) && /Per serving/.test(detail));

    const before = await pageA.$eval("#app .panel .kv b", (n) => n.textContent ?? "");
    await pageA.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>("input[type=number]");
      if (!input) throw new Error("scale input missing");
      input.value = "30";
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await pageA.waitForFunction((previous: string) => (document.querySelector("#app .panel .kv b")?.textContent ?? "") !== previous, { timeout: 6000 }, before);
    const after = await pageA.$eval("#app .panel .kv b", (n) => n.textContent ?? "");
    check("servings scaler rescales the view without writing", before !== after, `${before.trim()} → ${after.trim()}`);

        step = "legacy data reaches the UI";
    // Categories and main-liquid rows exist in your original database — they must show up here.
    await pageA.goto(`${BASE}/`, { waitUntil: "networkidle2" });
    await ready(pageA, "device A home (again)", errorsA);
    const chips = await pageA.$$eval(".card .chip", (nodes) => nodes.map((n) => (n.textContent ?? "").trim()));
    check("recipe categories from the original database are shown", chips.length > 0, `chips on cards: ${chips.join(", ") || "none"}`);

    const cardLinks = await pageA.$$eval(".card a.name", (nodes) => nodes.map((n) => n.getAttribute("href") ?? "/"));
    let liquidRecipe = "";
    for (const href of cardLinks) {
      await pageA.goto(`${BASE}${href}`, { waitUntil: "networkidle2" });
      await ready(pageA, `detail ${href}`, errorsA);
      const text = await bodyText(pageA);
      if (/Main liquids to weigh out/.test(text)) { liquidRecipe = href; break; }
    }
    check("main-liquid rows from the original database drive the water maths", liquidRecipe !== "", `shown on ${liquidRecipe}`);

        step = "device A create/edit";
    // ---------- device A: create + edit ----------
    await pageA.goto(`${BASE}/ingredients/new`, { waitUntil: "networkidle2" });
    await ready(pageA, "device A ingredient form", errorsA);
    await setValue(pageA, 'input[name="name"]', marker);
    await setValue(pageA, 'select[name="category"]', "hybrid");
    await pageA.waitForFunction(() => (document.querySelector<HTMLElement>('input[name="water_percent"]')?.closest("div") as HTMLElement | null)?.style.display !== "none", { timeout: 6000 });
    await setValue(pageA, 'input[name="water_percent"]', "85");
    await setValue(pageA, 'input[name="price"]', "4.20");
    await settleTry("submit new ingredient", () => pageA.click('button[type="submit"]'));
    await pageA.waitForFunction((label: string) => document.body.innerText.includes(label), { timeout: 15000 }, marker);
    check("created ingredient appears after submit", true, marker);

    await settleTry("open edit form", () => clickRowAction(pageA, marker, 0)); // "edit"
    await pageA.waitForFunction(() => location.pathname === "/ingredient-edit", { timeout: 10000 });
    const prefilled = await settleTry("read prefilled name", () => pageA.$eval('input[name="name"]', (n) => (n as HTMLInputElement).value));
    const prefillWater = await settleTry("read prefilled water", () => pageA.$eval('input[name="water_percent"]', (n) => (n as HTMLInputElement).value));
    check("edit route pre-fills stored values (incl. hybrid water)", prefilled === marker && prefillWater === "85", `name=${prefilled} water=${prefillWater}`);

    const edited = `${marker} (edited)`;
    await setValue(pageA, 'input[name="name"]', edited);
    await settleTry("submit edit", () => pageA.click('button[type="submit"]'));
    await pageA.waitForFunction((label: string) => document.body.innerText.includes(label), { timeout: 15000 }, edited);
    check("edit saved", true, edited);

        step = "hub export";
    // ---------- hub ----------
    const hubExport = await fetch(`${BASE}/api/export.json`).then((r) => r.json()) as { records: Array<{ cols: Record<string, unknown>; deleted: boolean }> };
    check("hub holds device A's edited row", hubExport.records.some((r) => String(r.cols.name ?? "") === edited && !r.deleted), `${hubExport.records.length} records on hub`);

        step = "device B pull";
    // ---------- device B: fresh device pulls it through the hub ----------
    await pageB.goto(`${BASE}/ingredients`, { waitUntil: "networkidle2" });
    await ready(pageB, "device B ingredients", errorsB);
    const seededB = await bodyText(pageB);
    check("fresh device seeded the original catalogue", ["Butter", "Yeast", "Psyllium Husk"].every((n) => seededB.includes(n)), "original ingredients present");

    const syncSummary = await forceSync(pageB);
    await pageB.goto(`${BASE}/ingredients`, { waitUntil: "networkidle2" });
    await ready(pageB, "device B after sync", errorsB);
    const bodyAfterSync = await bodyText(pageB);
    check("second device received another device's create+edit", bodyAfterSync.includes(edited), syncSummary);

        step = "delete propagation";
    // ---------- device A deletes, device B must forget it too ----------
    await pageB.goto(`${BASE}/ingredients`, { waitUntil: "networkidle2" });
    await ready(pageB, "device B for delete source", errorsB);
    // delete from device A (the device that created it)
    await pageA.goto(`${BASE}/ingredients`, { waitUntil: "networkidle2" });
    await ready(pageA, "device A for delete", errorsA);
    await clickRowAction(pageA, edited, 2); // "delete" (third action button)
    await pageA.waitForFunction((label: string) => !document.body.innerText.includes(label), { timeout: 15000 }, edited);
    check("delete removes the row locally (confirm dialog accepted)", true, edited);

    // Device A has to reach the hub before device B can hear about the deletion.
    const syncOut = await forceSync(pageA);
    const syncBack = await forceSync(pageB);
    await pageB.goto(`${BASE}/ingredients`, { waitUntil: "networkidle2" });
    await ready(pageB, "device B after delete sync", errorsB);
    const bodyFinal = await bodyText(pageB);
    check("delete replicated as a tombstone (row stays deleted)", !bodyFinal.includes(edited), `A: ${syncOut} | B: ${syncBack}`);

        step = "cleanup";
    // Leave the hub exactly as we found it.
    console.log("  INFO hub cleanup:", await removeMarkerFromHub(marker));

        step = "offline render";
    // ---------- offline behaviour ----------
    await pageB.setOfflineMode(true);
    await pageB.goto(`${BASE}/recipes`, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    await pageB.waitForFunction(() => (document.getElementById("app")?.textContent ?? "").length > 60, { timeout: 10000 }).catch(() => undefined);
    const offline = await bodyText(pageB).catch(() => "");
    check("pages + data still available while offline", /recipes/i.test(offline) && offline.length > 60, `${offline.slice(0, 50)}…`);
    await pageB.setOfflineMode(false);
  } catch (error) {
    check(`e2e run completed (failed during: ${step})`, false, String((error as Error)?.message ?? error));
  } finally {
    await deviceA.browser.close();
    await deviceB.browser.close();
  }

  check("no page JS errors on device A", errorsA.length === 0, errorsA.join(" | "));
  check("no page JS errors on device B", errorsB.length === 0, errorsB.join(" | "));

  console.log("\n  e2e results\n  ───────────");
  for (const line of checks) console.log(`  ${line}`);
  if (failures.length > 0) { console.log(`\n  ${failures.length} check(s) failed\n`); process.exit(1); }
  console.log("\n  all checks passed\n");
};

main().catch((error) => { console.error("e2e crashed:", error); process.exit(1); });
