/* Hero cutoff QA: screenshot the dark hero at rest and numerically sample
   luminance across the canvas box edge. A visible "cutoff box" shows as a
   luminance step exactly at the boundary; the fix should read ~0 step.
   Usage: node scripts/qa-hero-cutoff.mjs [outDir] [baseUrl] */
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
page.on("pageerror", (err) => console.log("PAGE EXCEPTION:", err.message));

await page.goto(baseUrl, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);
await page.waitForSelector("#hero canvas", { timeout: 8000 }).catch(() => {});
await page.waitForTimeout(2600); // assemble + poster crossfade settle

// Canvas box rect in CSS px (viewport coords)
const box = await page.evaluate(() => {
  const el = document.querySelector("[data-hero-stage]");
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
console.log("stage box:", JSON.stringify(box));

const shot = `${outDir}/hero-cutoff-dark.png`;
await page.screenshot({ path: shot });

// Reload the screenshot into a 2D canvas and sample luminance straddles.
const png = await page.screenshot();
const samples = await page.evaluate(
  async ({ b64, box, dpr }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const lum = (x, y) => {
      const d = ctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data;
      return (d[0] + d[1] + d[2]) / 3;
    };
    // Average a short strip inside vs outside each edge (6px in from the
    // boundary on both sides), at several positions along the edge.
    const strip = (edge) => {
      let inside = 0;
      let outside = 0;
      const N = 9;
      for (let i = 1; i <= N; i++) {
        const t = i / (N + 1);
        if (edge === "top" || edge === "bottom") {
          const x = box.x + box.w * t;
          const y = edge === "top" ? box.y : box.y + box.h;
          const s = edge === "top" ? 1 : -1;
          inside += lum(x, y + s * 6);
          outside += lum(x, y - s * 6);
        } else {
          const y = box.y + box.h * t;
          const x = edge === "left" ? box.x : box.x + box.w;
          const s = edge === "left" ? 1 : -1;
          inside += lum(x + s * 6, y);
          outside += lum(x - s * 6, y);
        }
      }
      return { inside: +(inside / N).toFixed(2), outside: +(outside / N).toFixed(2) };
    };
    return {
      top: strip("top"),
      bottom: strip("bottom"),
      left: strip("left"),
      right: strip("right"),
    };
  },
  { b64: png.toString("base64"), box, dpr: 2 },
);

for (const [edge, s] of Object.entries(samples)) {
  const step = +(s.inside - s.outside).toFixed(2);
  console.log(
    `${edge.padEnd(6)} inside=${s.inside} outside=${s.outside} step=${step} ${Math.abs(step) > 1.5 ? "◀ VISIBLE SEAM" : "ok"}`,
  );
}

await browser.close();
