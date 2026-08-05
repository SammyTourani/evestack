/* QA for the hero glyph field (eve.dev ASCII imprint port).
   Contract: glyphs frame the hero but NEVER sit under the headline/CTAs/3D
   center; they flicker autonomously; hover paints + decays; ink follows theme;
   the field fades out on scroll; reduced motion gets one static frame.
   Runs against the dev server on :3000. */
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const outDir = "qa-shots/glyph-field";
await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({
  args: ["--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist"],
});

/* count painted (non-transparent) pixels inside a CSS-px rect of the glyph canvas */
const regionCount = (page, rect) =>
  page.evaluate((r) => {
    const canvas = document.querySelector("[data-glyph-field] canvas");
    if (!canvas) return { error: "no canvas" };
    const ctx = canvas.getContext("2d");
    const dpr = canvas.width / canvas.clientWidth;
    const img = ctx.getImageData(
      Math.round(r.x * dpr),
      Math.round(r.y * dpr),
      Math.max(1, Math.round(r.w * dpr)),
      Math.max(1, Math.round(r.h * dpr)),
    );
    let painted = 0;
    let rSum = 0,
      gSum = 0,
      bSum = 0;
    for (let i = 3; i < img.data.length; i += 4) {
      if (img.data[i] > 12) {
        painted++;
        rSum += img.data[i - 3];
        gSum += img.data[i - 2];
        bSum += img.data[i - 1];
      }
    }
    const n = Math.max(painted, 1);
    return { painted, avg: [Math.round(rSum / n), Math.round(gSum / n), Math.round(bSum / n)] };
  }, rect);

const run = async (scheme) => {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: scheme,
  });
  // the site is dark-first (defaultTheme="dark"); next-themes persists to localStorage
  await page.addInitScript((t) => localStorage.setItem("theme", t), scheme);
  await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
  console.log(
    `\nhtml.dark class: ${await page.evaluate(() => document.documentElement.classList.contains("dark"))} (${scheme} requested)`,
  );
  await page.waitForTimeout(3000); // entrance choreography + glyph reveal
  await page.screenshot({ path: `${outDir}/hero-${scheme}.png` });
  console.log(`\n=== ${scheme} theme ===`);

  // 1. exclusion contract: zero painted pixels under h1 + CTA row, plenty in corners
  const boxes = await page.evaluate(() => {
    const g = (sel) => {
      const el = document.querySelector(sel);
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    };
    return { h1: g("#hero-heading"), ctas: g("[data-hero='ctas']") };
  });
  const h1Hits = await regionCount(page, boxes.h1);
  const ctaHits = await regionCount(page, boxes.ctas);
  const tl = await regionCount(page, { x: 20, y: 70, w: 320, h: 200 });
  const tr = await regionCount(page, { x: 1100, y: 70, w: 320, h: 200 });
  console.log("under h1:", h1Hits.painted, "| under CTAs:", ctaHits.painted, "(want 0/0)");
  console.log("top-left corner:", tl.painted, "| top-right:", tr.painted, "(want thousands)");
  console.log("ink avg RGB in corner:", tl.avg, scheme === "dark" ? "(want light)" : "(want dark)");

  // 2. autonomous flicker: corner pixels must change with no interaction
  const sig = () =>
    page.evaluate(() => {
      const c = document.querySelector("[data-glyph-field] canvas");
      const ctx = c.getContext("2d");
      const img = ctx.getImageData(0, 0, Math.min(800, c.width), Math.min(500, c.height));
      let h = 0;
      for (let i = 3; i < img.data.length; i += 4 * 97) h = (h * 31 + img.data[i]) | 0;
      return h;
    });
  const s1 = await sig();
  await page.waitForTimeout(1600);
  const s2 = await sig();
  console.log("flicker (signature changed over 1.6s):", s1 !== s2 ? "✓" : "✗ STATIC");

  if (scheme === "dark") {
    // 3. hover paint: sweep the top-left cluster, expect painted growth, then decay
    const before = await regionCount(page, { x: 40, y: 80, w: 300, h: 180 });
    await page.mouse.move(340, 260);
    for (let i = 0; i <= 24; i++) {
      await page.mouse.move(60 + i * 11, 110 + (i % 5) * 28);
      await page.waitForTimeout(45);
    }
    await page.waitForTimeout(250);
    const during = await regionCount(page, { x: 40, y: 80, w: 300, h: 180 });
    await page.screenshot({ path: `${outDir}/hover-paint.png` });
    await page.evaluate(() =>
      document.documentElement.dispatchEvent(new PointerEvent("pointerleave")),
    );
    await page.waitForTimeout(4500);
    const after = await regionCount(page, { x: 40, y: 80, w: 300, h: 180 });
    console.log(
      `hover paint px: before ${before.painted} → during ${during.painted} → +4.5s ${after.painted}`,
      during.painted > before.painted * 1.15 ? "(grows ✓)" : "(CHECK growth)",
      after.painted < during.painted * 0.75 ? "(decays ✓)" : "(CHECK decay)",
    );

    // 4. scroll fade: at 0.6×vh the canvas should be mostly faded
    await page.evaluate(() => window.scrollTo({ top: window.innerHeight * 0.6, behavior: "instant" }));
    await page.waitForTimeout(400);
    const op = await page.evaluate(
      () => +getComputedStyle(document.querySelector("[data-glyph-field] canvas")).opacity,
    );
    console.log("opacity at 0.6vh scroll:", op, op < 0.35 ? "(fades ✓)" : "(CHECK fade)");
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));

    // 5. frame cost while the field runs
    const frames = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const deltas = [];
          let last = performance.now();
          const tick = (now) => {
            deltas.push(now - last);
            last = now;
            if (deltas.length < 120) requestAnimationFrame(tick);
            else resolve(deltas);
          };
          requestAnimationFrame(tick);
        }),
    );
    const sorted = [...frames].sort((a, b) => a - b);
    console.log(
      "frame ms — median:",
      sorted[60].toFixed(1),
      "p95:",
      sorted[113].toFixed(1),
      "max:",
      sorted[119].toFixed(1),
    );
  }
  await page.close();
};

await run("dark");
await run("light");

/* 6. reduced motion: static frame, no flicker */
const rm = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  colorScheme: "dark",
  reducedMotion: "reduce",
});
await rm.goto("http://localhost:3000", { waitUntil: "networkidle" });
await rm.waitForTimeout(1500);
const rmSig = () =>
  rm.evaluate(() => {
    const c = document.querySelector("[data-glyph-field] canvas");
    if (!c) return null;
    const ctx = c.getContext("2d");
    const img = ctx.getImageData(0, 0, Math.min(800, c.width), Math.min(500, c.height));
    let h = 0,
      painted = 0;
    for (let i = 3; i < img.data.length; i += 4 * 97) {
      h = (h * 31 + img.data[i]) | 0;
      if (img.data[i] > 12) painted++;
    }
    return { h, painted };
  });
const r1 = await rmSig();
await rm.waitForTimeout(1500);
const r2 = await rmSig();
console.log(
  "\nreduced motion — painted:",
  r1?.painted,
  "| static:",
  r1 && r2 && r1.h === r2.h ? "✓" : "✗ ANIMATING",
);
await rm.close();

/* 7. mobile: content column must stay clear */
const mob = await browser.newPage({
  viewport: { width: 375, height: 812 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
});
await mob.goto("http://localhost:3000", { waitUntil: "networkidle" });
await mob.waitForTimeout(3000);
await mob.screenshot({ path: `${outDir}/hero-mobile.png` });
const mobH1 = await mob.evaluate(() => {
  const b = document.querySelector("#hero-heading").getBoundingClientRect();
  return { x: b.x, y: b.y, w: b.width, h: b.height };
});
const mobHits = await regionCount(mob, mobH1);
console.log("mobile under h1:", mobHits.painted, "(want 0)");
await mob.close();

await browser.close();
console.log("\ndone — shots in", outDir);
