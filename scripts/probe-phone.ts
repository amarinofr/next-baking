#!/usr/bin/env node
/**
 * Phone-origin probe: load the app the way a phone actually loads it — over a LAN address, which is NOT a secure
 * context — and report what the browser refuses to do.
 *
 *   npm run serve                                   # hub on :7902
 *   BASE=http://192.168.0.39:7902 node scripts/probe-phone.ts
 *
 * localhost is a special case: IndexedDB and the service worker are allowed there even over plain http. A phone
 * reaching 192.168.0.x is an insecure origin, and browsers gate storage differently — this script shows whether the
 * local database opens, whether the worker registered, and whether any view got drawn at all.
 */

import puppeteer from "puppeteer-core";

const BASE = process.env.BASE ?? "http://127.0.0.1:7902";
const PROFILE = "/tmp/e2e-probe-phone";

const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${PROFILE}`],
});

const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

const problems: string[] = [];
page.on("console", (message) => { const text = message.text(); if (/error|denied|blocked|insecure|refused|fail/i.test(text)) problems.push(`console.${message.type()}: ${text}`); });
page.on("pageerror", (error) => problems.push(`pageerror: ${(error as Error)?.message ?? String(error)}`));
page.on("requestfailed", (request) => problems.push(`requestfailed: ${request.url()} (${request.failure()?.errorText ?? "?"})`));

try {
  await page.goto(`${BASE}/recipes`, { waitUntil: "networkidle2" });
  await new Promise((resolve) => setTimeout(resolve, 4000));

  const facts = await page.evaluate(async () => {
    const out: Record<string, unknown> = {
      base: location.origin,
      secureContext: window.isSecureContext,
      rowsDrawn: document.querySelectorAll("table.data tbody tr").length,
      bootSkeletonsLeft: document.querySelectorAll("#boot .skeleton").length,
      appTextStart: (document.querySelector("#app")?.textContent ?? "").replace(/\s+/g, " ").slice(0, 100),
      statusLine: document.querySelector("#status-left")?.textContent ?? "",
      notices: [...document.querySelectorAll("#app .notice, #toasts .toast")].map((node) => (node.textContent ?? "").trim()).slice(0, 4),
    };

    // does the browser allow IndexedDB here at all?
    try { out.existingDatabases = (await indexedDB.databases()).map((d) => d.name); } catch (error) { out.databasesError = String(error); }
    try {
      const request = indexedDB.open("probe-only");
      out.indexedDbOpen = await new Promise<string>((resolve) => {
        request.onsuccess = () => { indexedDB.deleteDatabase("probe-only"); resolve("allowed"); };
        request.onerror = () => resolve(`refused (${request.error?.name ?? "unknown"})`);
        request.onblocked = () => resolve("blocked");
      });
    } catch (error) { out.indexedDbOpen = `threw (${String(error)})`; }

    try { out.serviceWorkerRegistrations = (await navigator.serviceWorker?.getRegistrations?.())?.length ?? -1; } catch (error) { out.serviceWorkerError = String(error); }
    return out;
  });

  console.log(JSON.stringify(facts, null, 2));
  console.log(problems.length ? problems.join("\n") : "(no errors reported by the page)");
} finally {
  await browser.close();
}
