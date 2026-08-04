/* Hero 3D QA: capture the assembled scene, then terminal mode.
   Usage: node scripts/qa-hero.mjs [outDir] [baseUrl] */
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const outDir = process.argv[2] ?? "qa-shots";
const baseUrl = process.argv[3] ?? "http://localhost:3000";
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  args: ["--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
});

page.on("console", (msg) => {
  if (msg.type() === "error") console.log("PAGE ERROR:", msg.text());
});
page.on("pageerror", (err) => console.log("PAGE EXCEPTION:", err.message));

await page.goto(baseUrl, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);

const hasCanvas = await page
  .waitForSelector("#hero canvas", { timeout: 8000 })
  .then(() => true)
  .catch(() => false);
console.log("canvas mounted:", hasCanvas);

if (hasCanvas) {
  // let the assemble timeline finish + a few idle frames
  await page.waitForTimeout(2500);
}

await page.locator("#hero .sticky").screenshot({ path: `${outDir}/hero-dashboard.png` });

const gl = await page.evaluate(() => {
  const c = document.createElement("canvas");
  const g = c.getContext("webgl2");
  if (!g) return "no webgl2";
  const info = g.getExtension("WEBGL_debug_renderer_info");
  return info ? g.getParameter(info.UNMASKED_RENDERER_WEBGL) : "unknown";
});
console.log("webgl renderer:", gl);

await browser.close();
console.log("done");
