/* Hero disassembly v2 QA: scrub keyframes + live-pulse proof.
   Usage: node scripts/qa-hero-v2.mjs [outDir] [baseUrl] */
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
  page.on("pageerror", (err) => console.log("PAGE EXCEPTION:", err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log("CONSOLE ERROR:", msg.text());
  });
  await page.addInitScript((t) => localStorage.setItem("theme", t), scheme);
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForSelector("#hero canvas", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(2600);

  // scrub start is where the section top hits the viewport top (below the
  // 64px header) — omit offsetTop and every frac lands ~0.05 early
  const { heroTop, heroRange } = await page.evaluate(() => {
    const hero = document.getElementById("hero");
    return { heroTop: hero.offsetTop, heroRange: hero.offsetHeight - window.innerHeight };
  });

  const fracs =
    scheme === "dark" ? [0.2, 0.42, 0.5, 0.58, 0.66, 0.75, 0.85, 1] : [0.42, 0.58, 0.75, 1];
  for (const frac of fracs) {
    await page.evaluate(
      (y) => window.scrollTo({ top: y, behavior: "instant" }),
      heroTop + heroRange * frac,
    );
    await page.waitForTimeout(700);
    const tag = String(frac).replace(".", "_");
    await page.screenshot({ path: `${outDir}/v2-${scheme}-${tag}.png` });
    console.log("captured", scheme, frac);
  }

  if (scheme === "dark") {
    // live-pulse proof: two captures ~1.7s apart at full explosion — the
    // pulses are clock-driven so their spine positions must differ.
    await page.waitForTimeout(1700);
    await page.screenshot({ path: `${outDir}/v2-dark-live-b.png` });
    console.log("captured dark live-b");
  }
  await page.close();
}
await browser.close();
