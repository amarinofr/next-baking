#!/usr/bin/env node
/**
 * End-to-end check against a running hub, driving the real UI in two isolated Chromium
 * profiles (= two devices, each with its own IndexedDB).
 *
 *   npm run serve        # terminal 1
 *   npm run e2e          # terminal 2
 *
 * Covers: seeded data, whole-row / whole-card clicking, in-app navigation without reloads,
 * the servings scaler writing nothing, categories coming through from the original database,
 * create → edit → auto-sync to another device, delete replication as tombstones, phone-width
 * layout with no horizontal overflow, and offline behaviour. It cleans its own test rows up.
 */

import { rmSync } from "node:fs";
import puppeteer from "puppeteer-core";

const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:7902";
const CHROMIUM = process.env.CHROMIUM_PATH ?? "/usr/bin/chromium";

const checks: string[] = [];
const failures: string[] = [];

const check = (name: string, ok: boolean, detail = ""): void => {
  checks.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

type Page = import("puppeteer-core").Page;

const launchDevice = async (profile: string): Promise<{ browser: import("puppeteer-core").Browser; page: Page }> => {
  rmSync(profile, { recursive: true, force: true }); // brand-new device each run
  const browser = await puppeteer.launch({ executablePath: CHROMIUM, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${profile}`] });
  const page = await browser.newPage();

  // Counts how many times the document actually loaded: proves in-app navigation avoided reloads.
  await page.evaluateOnNewDocument(() => { (window as any).__docLoads = ((window as any).__docLoads ?? 0) + 1; });

  page.on("pageerror", (error: unknown) => console.log(`  JS ERROR: ${String((error as Error)?.message ?? error)}`));
  page.on("requestfailed", (request) => { if (!request.url().includes("/api/sync")) console.log(`  REQUEST FAILED: ${request.url()}`); });
  page.on("dialog", async (dialog) => { await dialog.accept(); }); // confirm() dialogs used by delete actions
  return { browser, page };
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Retry an interaction: background sync can re-render a view mid-click. */
const settleTry = async <T>(label: string, action: () => Promise<T>, attempts = 5): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await action(); } catch (error) {
      lastError = error;
      if (!/detached|not found|no element|no node|no such row|no such card/i.test(String((error as Error)?.message ?? error))) break;
      await sleep(350 * attempt);
    }
  }
  throw new Error(`${label}: ${String((lastError as Error)?.message ?? lastError)}`);
};

const ready = async (page: Page, label: string): Promise<void> => {
  try {
    await page.waitForFunction(() => Boolean(document.querySelector("#app .card, #app table.data tbody tr, #app form, #app .panel")), { timeout: 25000, polling: 200 });
  } catch (error) {
    const status = await page.$eval("#status-left", (n) => n.textContent ?? "").catch(() => "<none>");
    const text = await page.$eval("#app", (n) => (n.textContent ?? "").slice(0, 180)).catch(() => "<empty>");
    console.log(`  DIAG(${label}) status=${JSON.stringify(status)} app=${JSON.stringify(text)} (${String((error as Error).message)})`);
    throw error;
  }
};

const bodyText = (page: Page): Promise<string> => page.$eval("#app", (node) => node.textContent ?? "");
const currentPath = (page: Page): Promise<string> => page.evaluate(() => location.pathname);
const documentLoads = (page: Page): Promise<number> => page.evaluate(() => Number((window as any).__docLoads ?? 0));

const setValue = async (page: Page, selector: string, value: string): Promise<void> => {
  await settleTry(`set ${selector}`, () => page.evaluate((sel: string, val: string) => {
    const node = document.querySelector(sel) as HTMLInputElement | HTMLSelectElement | null;
    if (!node) throw new Error(`field not found: ${sel}`);
    node.value = val;
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  }, selector, value));
};

/** Click the middle of a table row whose text contains `needle` — the whole row is clickable. */
const clickRow = async (page: Page, needle: string): Promise<void> => {
  await settleTry(`click row "${needle}"`, () => page.evaluate((text: string) => {
    const rows = [...document.querySelectorAll("table.data tbody tr")] as HTMLTableRowElement[];
    const row = rows.find((r) => (r.textContent ?? "").includes(text));
    if (!row) throw new Error("no such row");
    const target = row.querySelector("td.dim") ?? row.querySelectorAll("td")[1] ?? row;
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }, needle));
};

/** Click a grid card anywhere on it. */
const clickCard = async (page: Page, needle: string): Promise<void> => {
  await settleTry(`click card "${needle}"`, () => page.evaluate((text: string) => {
    const cards = [...document.querySelectorAll("article.card")] as HTMLElement[];
    const card = cards.find((c) => (c.textContent ?? "").includes(text));
    if (!card) throw new Error("no such card");
    card.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }, needle));
};

/** Click an action button inside the row containing `needle`. */
const clickAction = async (page: Page, needle: string, label: string): Promise<void> => {
  await settleTry(`click ${label} on "${needle}"`, () => page.evaluate((text: string, buttonLabel: string) => {
    const host = [...document.querySelectorAll("tr, article.card")].find((node) => (node.textContent ?? "").includes(text));
    const button = host ? [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === buttonLabel) : undefined;
    if (!button) throw new Error(`no "${buttonLabel}" button for that row`);
    button.click();
  }, needle, label));
};

const waitForPath = async (page: Page, matcher: RegExp, timeoutMs = 12000): Promise<string> => {
  try {
    await page.waitForFunction((source: string) => new RegExp(source).test(location.pathname), { timeout: timeoutMs, polling: 200 }, matcher.source);
  } catch (error) {
    const now = await page.evaluate(() => location.pathname).catch(() => "?");
    const app = await page.$eval("#app", (node) => (node.textContent ?? "").replace(/\s+/g, " ").slice(0, 140)).catch(() => "<empty>");
    const clicks = await page.evaluate(() => document.querySelectorAll("#app a, #app tr, #app article").length).catch(() => -1);
    console.log(`  DIAG(wait ${matcher} at ${now}) interactive nodes=${clicks} app=${JSON.stringify(app)}`);
    throw error;
  }
  return currentPath(page);
};

/** Poll something in the page until true (used for background auto-sync effects). */
const pollPage = async (page: Page, predicate: () => Promise<boolean>, timeoutMs: number, intervalMs = 1500): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await predicate()) return true; } catch { /* page may be mid-render */ }
    await sleep(intervalMs);
  }
  return false;
};

/** Wait until the view actually shows something (rendering is async after navigation). */
const bodyShows = async (page: Page, needle: string, timeoutMs = 10000): Promise<boolean> =>
  pollPage(page, async () => (await bodyText(page)).includes(needle), timeoutMs, 400);

const hubJson = async <T>(path: string): Promise<T> => (await fetch(`${BASE}${path}`)).json() as Promise<T>;

interface HubRow { table: string; pk: string; deleted?: boolean; cols: Record<string, unknown>; updated_at?: number; origin?: string }

const hubIngredientNames = async (): Promise<string[]> => {
  const data = await hubJson<{ records: HubRow[] }>("/api/export.json");
  return data.records.filter((row) => !row.deleted && row.table === "ingredients").map((row) => String(row.cols.name ?? ""));
};

/** Leave the hub as we found it. */
const removeMarkerFromHub = async (needle: string): Promise<string> => {
  const data = await hubJson<{ records: HubRow[] }>("/api/export.json");
  const rows = data.records.filter((row) => !row.deleted && row.table === "ingredients" && String(row.cols.name ?? "").includes(needle));
  if (rows.length === 0) return "nothing to clean";
  const changes = rows.map((row) => ({ ...row, updated_at: Date.now(), deleted: true, origin: "e2e-cleaner" }));
  const res = await fetch(`${BASE}/api/sync`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceId: "e2e-cleaner", since: 0, changes }) });
  if (!res.ok) return `hub refused cleanup (${res.status})`;
  const outcome = (await res.json()) as { applied: number };
  return `tombstoned ${outcome.applied} row(s)`;
};

const main = async (): Promise<void> => {
  let step = "startup";
  const marker = `E2E Ingredient ${Date.now()}`;
  const edited = `${marker} (edited)`;

  const deviceA = await launchDevice("/tmp/e2e-device-a");
  const deviceB = await launchDevice("/tmp/e2e-device-b");
  const A = deviceA.page;
  const B = deviceB.page;

  try {
    // ------------------------------------------------------------------ device A boots once
    step = "device A boot";
    await A.goto(`${BASE}/`, { waitUntil: "networkidle2" });
    await ready(A, "A home");

    const cards = await A.$$eval("article.card", (nodes) => nodes.map((n) => (n.textContent ?? "").trim()));
    check("seeded recipes render as cards", cards.length >= 7, `${cards.length} cards`);

    const footer = await A.$eval("#status-left", (n) => n.textContent ?? "");
    check("local database opened and counted", /recipes · .* mixes · \d+ ingredients/.test(footer), footer.trim());

    // whole-card click opens the recipe, without loading a new document
    step = "card click";
    await clickCard(A, (cards[0] ?? "").split("\n")[0] ?? "");
    const detailPath = await waitForPath(A, /^\/recipes\/[^/]+$/);
    await ready(A, "A recipe detail");
    const detailText = await bodyText(A);
    check("clicking anywhere on a card opens the recipe", detailPath.startsWith("/recipes/"), detailPath);
    check("recipe detail shows hydration + price sections", /Target water/.test(detailText) && /Total liquid/.test(detailText) && /Per Serving/.test(detailText));

    // servings scaler must not write anything to the store
    step = "servings scaler";
    const beforeValue = await A.$eval("#scale-input", (n) => (n as HTMLInputElement).value);
    await setValue(A, "#scale-input", "30");
    await pollPage(A, async () => (await bodyText(A)).includes("scaling ×"), 5000, 400);
    const pendingAfterScaling = await A.evaluate(async () => Number(((await (window as any).__baking.debug()).pendingSync)));
    check("scaling servings writes nothing to the database", pendingAfterScaling === 0, `input ${beforeValue} → 30, queued rows ${pendingAfterScaling}`);

    // categories from your original database are visible in the table view (still no reload)
    step = "categories + soft nav";
    await settleTry("back to the table view", () => A.evaluate(() => { document.querySelector<HTMLAnchorElement>('a[href="/recipes"]')?.click(); }));
    await waitForPath(A, /^\/recipes$/);
    const tableText = await bodyText(A);
    check("recipe categories come through from the original data", /Bread|Sweet bread|Pizza/.test(tableText), tableText.match(/Bread|Sweet bread|Pizza/g)?.slice(0, 3).join(", ") ?? "none");

    step = "table row click";
    const rowNames = await A.$$eval("table.data tbody tr td.name", (nodes) => nodes.map((n) => (n.textContent ?? "").trim()));
    let liquidRecipe = "";
    for (const name of rowNames) {
      await clickRow(A, name);
      await waitForPath(A, /^\/recipes\/[^/]+$/);
      if (/Main liquids/.test(await bodyText(A))) { liquidRecipe = name; break; }
      await settleTry("back to recipes list", () => A.evaluate(() => { document.querySelector<HTMLAnchorElement>('a[href="/recipes"]')?.click(); }));
      await waitForPath(A, /^\/recipes$/);
    }
    check("main-liquid rows drive the water maths", liquidRecipe !== "", `seen on "${liquidRecipe}"`);

    const loadsSoFar = await documentLoads(A);
    check("in-app navigation never reloaded the page", loadsSoFar === 1, `document loaded ${loadsSoFar} time(s)`);

    // ------------------------------------------------------------------ create on device A
    step = "create ingredient";
    await settleTry("open Ingredients tab", () => A.evaluate(() => { document.querySelector<HTMLAnchorElement>('nav.tabs [data-tab="ingredients"]')?.click(); }));
    await waitForPath(A, /^\/ingredients$/);
    await settleTry("open create form", () => A.evaluate(() => { document.querySelector<HTMLAnchorElement>('a[href="/ingredients/new"]')?.click(); }));
    await waitForPath(A, /^\/ingredients\/new$/);
    await ready(A, "A ingredient form");

    await setValue(A, 'input[name="name"]', marker);
    await setValue(A, 'select[name="category"]', "hybrid");
    await pollPage(A, async () => !(await A.$eval('input[name="water_percent"]', (n) => (n as HTMLElement).classList.contains("hidden"))), 5000, 300);
    await setValue(A, 'input[name="water_percent"]', "85");
    await setValue(A, 'input[name="price"]', "4.20");
    await settleTry("submit ingredient", () => A.evaluate(() => { document.querySelector<HTMLFormElement>("form")?.requestSubmit(); }));
    await waitForPath(A, /^\/ingredients$/);
    await ready(A, "A ingredients list");
    const createdVisible = await bodyShows(A, marker);
    check("creating an ingredient lands back on the list", createdVisible, marker);

    // ------------------------------------------------------------------ whole-row click opens the edit form
    step = "row click → edit form";
    await clickRow(A, marker);
    const editPath = await waitForPath(A, /^\/ingredients\/[^/]+\/edit$/);
    const prefilledName = await settleTry("read prefilled name", () => A.$eval('input[name="name"]', (n) => (n as HTMLInputElement).value));
    const prefilledWater = await settleTry("read prefilled water", () => A.$eval('input[name="water_percent"]', (n) => (n as HTMLInputElement).value));
    check("clicking a row opens its edit form pre-filled", prefilledName === marker && prefilledWater === "85", `${editPath} · water=${prefilledWater}`);

    await setValue(A, 'input[name="name"]', edited);
    await settleTry("submit edit", () => A.evaluate(() => { document.querySelector<HTMLFormElement>("form")?.requestSubmit(); }));
    await waitForPath(A, /^\/ingredients$/);
    const editedVisible = await bodyShows(A, edited);
    check("the edit is visible immediately", editedVisible, edited);

    // ------------------------------------------------------------------ auto-sync: hub then device B, no buttons pressed
    step = "auto-sync push to hub";
    const pushedAutomatically = await pollPage(A, async () => (await hubIngredientNames()).includes(edited), 25000, 1500);
    check("changes reach the hub by themselves (no manual sync)", pushedAutomatically, pushedAutomatically ? "seen on hub" : "hub never showed it");

    step = "device B boot + auto-sync pull";
    await B.goto(`${BASE}/ingredients`, { waitUntil: "networkidle2" });
    await ready(B, "B ingredients");
    const seededB = await bodyText(B);
    check("a fresh device seeds your existing catalogue", ["Butter", "Yeast", "Psyllium Husk"].every((n) => seededB.includes(n)), "original ingredients present");

    const pulledAutomatically = await pollPage(B, async () => (await bodyText(B)).includes(edited), 45000, 1500);
    check("another device picks it up automatically", pulledAutomatically, pulledAutomatically ? "device B shows the edited ingredient" : "device B never received it");

    // ------------------------------------------------------------------ delete replicates as a tombstone
    step = "delete + replication";
    await clickAction(A, edited, "delete");
    const goneLocally = await pollPage(A, async () => !(await bodyText(A)).includes(edited), 15000, 800);
    check("deleting removes the row at once", goneLocally, edited);

    const goneFromHub = await pollPage(A, async () => !(await hubIngredientNames()).includes(edited), 25000, 1500);
    check("the delete reaches the hub as a tombstone", goneFromHub, goneFromHub ? "hub no longer lists it live" : "still live on hub");

    const goneOnB = await pollPage(B, async () => !(await bodyText(B)).includes(edited), 45000, 1500);
    check("the other device forgets it too", goneOnB, goneOnB ? "device B no longer shows it" : "device B still shows it");

    // ------------------------------------------------------------------ mixes: totals shown, rows clickable
    step = "mixes screen";
    await settleTry("open Flour Mixes tab", () => A.evaluate(() => { document.querySelector<HTMLAnchorElement>('nav.tabs [data-tab="mixes"]')?.click(); }));
    await waitForPath(A, /^\/mixes$/);
    const mixText = await bodyText(A);
    check("flour mixes show their own total and cost per kg", /\d+(?:\.\d+)? ?g · €[\d.,]+\/kg/.test(mixText), mixText.match(/\d+(?:\.\d+)? ?g · €[\d.,]+\/kg/)?.[0] ?? "not found");

    const firstMix = await A.$eval("table.data tbody tr td.name", (n) => (n.textContent ?? "").trim());
    await clickRow(A, firstMix);
    const mixEditPath = await waitForPath(A, /^\/mixes\/[^/]+\/edit$/);
    const componentRows = await A.$$eval(".component-row", (nodes) => nodes.length);
    check("clicking a mix row opens its editor with components loaded", componentRows > 0, `${mixEditPath} · ${componentRows} component row(s)`);

    // ------------------------------------------------------------------ phone layout
    step = "phone layout";
    await B.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await B.goto(`${BASE}/`, { waitUntil: "networkidle2" });
    await ready(B, "B home at phone width");
    const overflow = await B.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
    const phoneCards = await B.$$eval("article.card", (nodes) => nodes.length);
    check("no horizontal overflow at phone width", overflow.scrollWidth <= overflow.innerWidth + 2, `scrollWidth ${overflow.scrollWidth} vs viewport ${overflow.innerWidth}`);
    check("recipe cards readable on a phone", phoneCards >= 7, `${phoneCards} cards`);

    // ------------------------------------------------------------------ offline keeps working
    step = "offline behaviour";
    await B.setOfflineMode(true);
    await settleTry("offline tab click", () => B.evaluate(() => { document.querySelector<HTMLAnchorElement>('nav.tabs [data-tab="ingredients"]')?.click(); }));
    const offlineOk = await pollPage(B, async () => /All Ingredients/.test(await bodyText(B)), 8000, 500);
    check("in-app navigation keeps working offline", offlineOk, offlineOk ? "list rendered with no network" : "nothing rendered");
    await B.setOfflineMode(false);

    step = "cleanup";
    console.log(`  INFO hub cleanup: ${await removeMarkerFromHub(marker)}`);

    const totalLoadsA = await documentLoads(A);
    check("the whole run stayed a single page load on device A", totalLoadsA === 1, `${totalLoadsA} document load(s), everything else in-app`);
  } catch (error) {
    check(`e2e run completed (failed during: ${step})`, false, String((error as Error)?.message ?? error));
  } finally {
    await deviceA.browser.close().catch(() => undefined);
    await deviceB.browser.close().catch(() => undefined);
  }

  console.log("");
  for (const line of checks) console.log(`  ${line}`);
  console.log("");
  if (failures.length === 0) console.log("  all checks passed\n");
  else { console.log(`  ${failures.length} check(s) failed\n`); process.exitCode = 1; }
};

void main();
