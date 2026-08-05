/* Verification for the empty→assemble hero narrative and the organic glyph
   boundaries: poster must never pre-paint for capable visitors; hover paint
   at every corner must dissolve along wobbled contours, never a straight cut. */
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const outDir = "qa-shots/organic";
await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({
  args: ["--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist"],
});

/* ── 1. first-paint narrative ── */
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
});
const posterOp = () =>
  page.evaluate(() => {
    const el = document.querySelector("[data-hero-poster]");
    return el ? getComputedStyle(el).opacity : "absent";
  });
await page.goto("http://localhost:3000", { waitUntil: "commit" });
const samples = [];
for (const [name, wait] of [["t03", 300], ["t09", 600], ["t18", 900], ["t32", 1400]]) {
  await page.waitForTimeout(wait);
  samples.push(`${name}:${await posterOp()}`);
  await page.screenshot({ path: `${outDir}/paint-${name}.png`, clip: { x: 360, y: 90, width: 720, height: 560 } });
}
console.log("poster opacity over load:", samples.join(" "), "(want 0 or absent throughout)");

/* ── 2. hover paint at all four corners ── */
await page.waitForTimeout(1500);
const corners = [
  ["top-left", 120, 150, { x: 0, y: 40, width: 420, height: 360 }],
  ["top-right", 1320, 150, { x: 1020, y: 40, width: 420, height: 360 }],
  ["bottom-left", 120, 780, { x: 0, y: 520, width: 420, height: 380 }],
  ["bottom-right", 1320, 780, { x: 1020, y: 520, width: 420, height: 380 }],
];
for (const [name, cx, cy, clip] of corners) {
  for (let i = 0; i <= 30; i++) {
    const a = i * 0.5;
    await page.mouse.move(cx + Math.cos(a) * (12 + i * 4), cy + Math.sin(a) * (10 + i * 3));
    await page.waitForTimeout(35);
  }
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${outDir}/hover-${name}.png`, clip });
  await page.waitForTimeout(2600);
}
await page.close();

/* ── 3. reduced motion still gets the poster ── */
const rm = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  colorScheme: "dark",
  reducedMotion: "reduce",
});
await rm.goto("http://localhost:3000", { waitUntil: "networkidle" });
await rm.waitForTimeout(1200);
const rmOp = await rm.evaluate(() => {
  const el = document.querySelector("[data-hero-poster]");
  return el ? getComputedStyle(el).opacity : "absent";
});
console.log("reduced-motion poster opacity:", rmOp, "(want 1)");
await rm.close();

await browser.close();
console.log("done —", outDir);
