/* Fallback-ladder QA: software WebGL (no GPU) and prefers-reduced-motion
   must both keep the poster and never mount a canvas. */
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const outDir = process.argv[2] ?? "qa-shots";
const baseUrl = process.argv[3] ?? "http://localhost:3000";
await mkdir(outDir, { recursive: true });

// 1 — no GPU: SwiftShader is a major performance caveat → probe fails → poster
{
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
  });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);
  const canvasCount = await page.locator("#hero canvas").count();
  console.log("no-gpu: canvas count =", canvasCount, canvasCount === 0 ? "(PASS)" : "(FAIL)");
  await page.locator("#hero .sticky").screenshot({ path: `${outDir}/fallback-nogpu.png` });
  await browser.close();
}

// 2 — reduced motion with GPU available: ladder rung 1 must still refuse
{
  const browser = await chromium.launch({
    args: ["--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist"],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);
  const canvasCount = await page.locator("#hero canvas").count();
  console.log("reduced-motion: canvas count =", canvasCount, canvasCount === 0 ? "(PASS)" : "(FAIL)");
  await browser.close();
}

console.log("done");
