/* Glare continuity probe: at full explosion, sample luminance along each
   bar's top edge (max over a small vertical window per column). A healthy
   rim is CONTINUOUS — bright middle, no corner-dots-with-dead-center.
   Reports per-bar middle-mean vs corner-max and flags hollow rims.
   Usage: node scripts/qa-hero-glare.mjs [label] */
import { chromium } from "@playwright/test";

const label = process.argv[2] ?? "run";
const browser = await chromium.launch({
  args: ["--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
});
await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);
await page.waitForSelector("#hero canvas", { timeout: 8000 }).catch(() => {});
await page.waitForTimeout(2600);
const { top, range } = await page.evaluate(() => {
  const h = document.getElementById("hero");
  return { top: h.offsetTop, range: h.offsetHeight - window.innerHeight };
});
await page.evaluate((y) => window.scrollTo({ top: y, behavior: "instant" }), top + range);
await page.waitForTimeout(1200); // scrub settles + landing flash decays

const box = await page.evaluate(() => {
  const r = document.querySelector("[data-hero-stage]").getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});

const png = await page.screenshot();
const ROW_TOP = [20.2, 40.1, 59.9, 79.8]; // row centers, % of stage box
const NAMES = ["dashboard", "agent", "postgres", "sandbox"];

const report = await page.evaluate(
  async ({ b64, box, ROW_TOP }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const dpr = 2;
    const pxPerUnit = ((box.h * (460 / 580)) / 2 / 2.197) * (580 / 460); // 230px@full → scaled
    // simpler: inner half-height px = box.h * (230/580)
    const halfViewPx = box.h * (230 / 580);
    const u2px = halfViewPx / 2.197;
    const barHalfH = 0.426 * u2px;
    const barHalfW = 1.86 * u2px;
    const cx = box.x + box.w / 2;
    const out = [];
    for (let r = 0; r < 4; r++) {
      const rowCenterY = box.y + (ROW_TOP[r] / 100) * box.h;
      const rimY = rowCenterY - barHalfH;
      const cols = [];
      for (let i = 0; i <= 36; i++) {
        const x = cx - barHalfW + (i / 36) * 2 * barHalfW;
        let maxL = 0;
        for (let dy = -14; dy <= 10; dy += 2) {
          const d = ctx.getImageData(
            Math.round((x) * dpr),
            Math.round((rimY + dy) * dpr),
            1,
            1,
          ).data;
          maxL = Math.max(maxL, (d[0] + d[1] + d[2]) / 3);
        }
        cols.push(maxL);
      }
      const middle = cols.slice(6, 31);
      const midMean = middle.reduce((a, b) => a + b, 0) / middle.length;
      const midMin = Math.min(...middle);
      const cornerMax = Math.max(...cols.slice(0, 5), ...cols.slice(32));
      out.push({
        midMean: +midMean.toFixed(1),
        midMin: +midMin.toFixed(1),
        cornerMax: +cornerMax.toFixed(1),
      });
    }
    return out;
  },
  { b64: png.toString("base64"), box, ROW_TOP },
);

console.log(`glare continuity [${label}] — per-bar top-edge rim:`);
report.forEach((r, i) => {
  const hollow = r.cornerMax > 60 && r.midMean < r.cornerMax * 0.35;
  console.log(
    `${NAMES[i].padEnd(10)} midMean=${String(r.midMean).padStart(6)}  midMin=${String(r.midMin).padStart(6)}  cornerMax=${String(r.cornerMax).padStart(6)}  ${hollow ? "◀ HOLLOW RIM (corner dots)" : "ok"}`,
  );
});
await browser.close();
