import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
const outDir = process.argv[2] ?? "qa-shots";
await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({ args: ["--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "dark" });
await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await page.evaluate(() => document.getElementById("one-command").scrollIntoView({ block: "start", behavior: "instant" }));
await page.waitForTimeout(4500); // rows stream + live row counts up
await page.screenshot({ path: `${outDir}/demo-live.png` });
// click the first expandable row
const row = page.locator("#one-command [aria-expanded]").first();
await row.click();
await page.waitForTimeout(600);
await page.screenshot({ path: `${outDir}/demo-expanded.png` });
console.log("done");
await browser.close();
