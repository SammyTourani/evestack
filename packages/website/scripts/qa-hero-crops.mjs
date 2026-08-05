/* Tight crops of the hero crown glare (the user-reported cutoff area) in
   dark mode + full light-mode hero. Usage: node scripts/qa-hero-crops.mjs [outDir] */
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const outDir = process.argv[2] ?? "qa-shots";
const baseUrl = process.argv[3] ?? "http://localhost:3000";
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  args: ["--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist"],
});

for (const scheme of ["dark", "light"]) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: scheme,
  });
  await page.addInitScript((t) => localStorage.setItem("theme", t), scheme);
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForSelector("#hero canvas", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(2600);
  if (scheme === "dark") {
    await page.screenshot({
      path: `${outDir}/crown-glare-dark.png`,
      clip: { x: 420, y: 100, width: 760, height: 420 },
    });
  } else {
    await page.screenshot({ path: `${outDir}/hero-light.png` });
  }
  await page.close();
  console.log("captured", scheme);
}
await browser.close();
