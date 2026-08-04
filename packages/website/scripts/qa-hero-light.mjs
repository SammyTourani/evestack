import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
const outDir = process.argv[2] ?? "qa-shots";
await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({ args: ["--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light" });
await page.addInitScript(() => localStorage.setItem("theme", "light"));
await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
await page.waitForSelector("#hero canvas", { timeout: 8000 }).catch(() => {});
await page.waitForTimeout(2500);
await page.locator("#hero .sticky").screenshot({ path: `${outDir}/hero-light.png` });
// also the observability section in light (trace layer check)
await page.evaluate(() => document.getElementById("observability").scrollIntoView({ block: "center", behavior: "instant" }));
await page.waitForTimeout(1200);
await page.screenshot({ path: `${outDir}/observability-light.png` });
await browser.close();
console.log("done");
