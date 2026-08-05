/* One-off QA for the hero polish round: badge removed, hover paint fades at
   the content mask (no straight cutoff), pink env glare at more pointer
   extremes. Runs against :3000. */
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const outDir = "qa-shots/hero-polish";
await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({
  args: ["--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
});
await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
await page.waitForTimeout(3500);

/* 1. badge gone */
const badgeCount = await page.evaluate(
  () => document.body.innerText.includes("APACHE-2.0"),
);
console.log("APACHE-2.0 badge present:", badgeCount, "(want false)");

/* 2. hover soft edge: sweep along the slab-core left boundary, then measure
   column-by-column painted density across the boundary — a hard cut shows a
   cliff, a fade shows a monotonic-ish ramp to zero. */
for (let i = 0; i <= 30; i++) {
  await page.mouse.move(300 + (i % 3) * 45, 260 + i * 10);
  await page.waitForTimeout(40);
}
await page.waitForTimeout(200);
const profile = await page.evaluate(() => {
  const c = document.querySelector("[data-glyph-field] canvas");
  const ctx = c.getContext("2d");
  const dpr = c.width / c.clientWidth;
  const cols = [];
  for (let x = 280; x <= 560; x += 20) {
    const img = ctx.getImageData(Math.round(x * dpr), Math.round(280 * dpr), Math.round(20 * dpr), Math.round(300 * dpr));
    let sum = 0;
    for (let i = 3; i < img.data.length; i += 4) sum += img.data[i];
    cols.push(Math.round(sum / 1000));
  }
  return cols;
});
console.log("paint alpha profile x=280→560 (20px cols):", profile.join(" "));
await page.screenshot({ path: `${outDir}/hover-boundary.png`, clip: { x: 200, y: 200, width: 500, height: 460 } });

/* 3. pink glare at extremes: sample slab-region hue with the pointer parked at
   four extremes; report how red-vs-blue the lit pixels skew. */
const slabTint = () =>
  page.evaluate(() => {
    const c = document.querySelector("[data-hero-stage] canvas");
    if (!c) return null;
    const g = document.createElement("canvas");
    g.width = 300;
    g.height = 240;
    const ctx = g.getContext("2d");
    // slab area ≈ central box of the stage canvas
    ctx.drawImage(c, c.width * 0.3, c.height * 0.25, c.width * 0.4, c.height * 0.55, 0, 0, 300, 240);
    const img = ctx.getImageData(0, 0, 300, 240).data;
    let r = 0, g2 = 0, b = 0, n = 0;
    for (let i = 0; i < img.length; i += 4) {
      const lum = img[i] + img[i + 1] + img[i + 2];
      if (lum > 60) {
        r += img[i];
        g2 += img[i + 1];
        b += img[i + 2];
        n++;
      }
    }
    if (!n) return { n: 0 };
    return { r: Math.round(r / n), g: Math.round(g2 / n), b: Math.round(b / n), n };
  });

const extremes = [
  ["bottom-right", 1380, 860],
  ["bottom-left", 60, 860],
  ["top-center", 720, 40],
  ["left-center", 40, 450],
];
for (const [name, x, y] of extremes) {
  await page.mouse.move(x, y, { steps: 12 });
  await page.waitForTimeout(1400); // damp settle
  const tint = await slabTint();
  console.log(`slab tint @ ${name}:`, JSON.stringify(tint), tint && tint.n ? (tint.r > tint.b ? "→ pink-leaning" : "→ blue-leaning") : "");
  await page.screenshot({ path: `${outDir}/extreme-${name}.png`, clip: { x: 430, y: 180, width: 580, height: 560 } });
}

await browser.close();
console.log("done —", outDir);
