#!/usr/bin/env node
/**
 * Rasterize public/icons/icon.svg into the PNG sizes the manifest asks for.
 * Done with the browser we already have (no extra image toolchain), so the icons stay in sync
 * with whatever the SVG looks like today.
 *
 *   npm run icons
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import puppeteer from "puppeteer-core";

const ROOT = resolve(import.meta.dirname, "..");
const SVG = readFileSync(`${ROOT}/public/icons/icon.svg`, "utf8");

const sizes = [192, 512];

const renderPng = async (size: number, maskable: boolean): Promise<Buffer> => {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    // maskable icons need the artwork inside a safe zone with the background filling the tile
    const padding = maskable ? Math.round(size * 0.18) : Math.round(size * 0.04);
    const inner = size - padding * 2;
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;background:${maskable ? "#f6efe3" : "transparent"}}
      body{display:flex;align-items:center;justify-content:center;width:${size}px;height:${size}px}
      svg{width:${inner}px;height:${inner}px;display:block}
    </style>${SVG}`, { waitUntil: "load" });
    const buffer = await page.screenshot({ clip: { x: 0, y: 0, width: size, height: size }, omitBackground: !maskable });
    return Buffer.from(buffer);
  } finally {
    await page.close();
  }
};

const browser = await puppeteer.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });

try {
  for (const size of sizes) {
    const normal = await renderPng(size, false);
    const out = `${ROOT}/public/icons/icon-${size}.png`;
    await BunWrite(out, normal);
    console.log(`  wrote icon-${size}.png (${normal.length} bytes)`);
  }
  const maskable = await renderPng(512, true);
  await BunWrite(`${ROOT}/public/icons/icon-512-maskable.png`, maskable);
  console.log(`  wrote icon-512-maskable.png (${maskable.length} bytes)`);
} finally {
  await browser.close();
}

/** Tiny helper so this script works on plain Node without extra dependencies. */
async function BunWrite(path: string, data: Buffer): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, data);
}
