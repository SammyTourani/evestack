import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
const outDir = process.argv[2] ?? "qa-shots";
await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({ args: ["--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "dark" });
await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
await page.waitForTimeout(1800);
for (const [id, name, settle] of [["architecture", "beams", 1000], ["integrations", "logos", 800], ["code", "code-cards", 900], ["compare", "table", 1400]]) {
  await page.evaluate((s) => document.getElementById(s).scrollIntoView({ block: "center", behavior: "instant" }), id);
  await page.waitForTimeout(settle);
  await page.screenshot({ path: `${outDir}/${name}.png` });
  console.log("captured", name);
}
await browser.close();
