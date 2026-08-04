/* Visual QA captures: full-page + per-section screenshots, dark + light,
   desktop + mobile. Usage: node scripts/qa-shots.mjs [outDir] [baseUrl] */
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const outDir = process.argv[2] ?? "qa-shots";
const baseUrl = process.argv[3] ?? "http://localhost:3000";
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();

const configs = [
  { name: "desktop-dark", width: 1440, height: 900, theme: "dark" },
  { name: "desktop-light", width: 1440, height: 900, theme: "light" },
  { name: "mobile-dark", width: 375, height: 812, theme: "dark" },
];

for (const cfg of configs) {
  const page = await browser.newPage({
    viewport: { width: cfg.width, height: cfg.height },
    deviceScaleFactor: 2,
    colorScheme: cfg.theme === "dark" ? "dark" : "light",
  });
  await page.addInitScript((theme) => {
    localStorage.setItem("theme", theme);
  }, cfg.theme);
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${outDir}/${cfg.name}-full.png`, fullPage: true });
  await page.close();
  console.log(`captured ${cfg.name}`);
}

await browser.close();
console.log("done");
