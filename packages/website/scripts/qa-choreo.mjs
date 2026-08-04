/* Choreography QA: step through scroll positions and capture keyframes.
   Usage: node scripts/qa-choreo.mjs [outDir] [baseUrl] */
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
page.on("console", (msg) => {
  if (msg.type() === "error") console.log("CONSOLE ERROR:", msg.text());
});

await page.goto(baseUrl, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);
await page.waitForSelector("#hero canvas", { timeout: 8000 }).catch(() => {});
await page.waitForTimeout(2200); // assemble settles

// Hero disassembly keyframes: scroll fraction of the 190vh hero range
const heroRange = await page.evaluate(() => {
  const hero = document.getElementById("hero");
  return hero.offsetHeight - window.innerHeight;
});
for (const frac of [0, 0.3, 0.55, 0.8, 1]) {
  await page.evaluate((y) => window.scrollTo({ top: y, behavior: "instant" }), heroRange * frac);
  await page.waitForTimeout(700); // let scrub + damping settle
  await page.screenshot({ path: `${outDir}/disassembly-${String(frac).replace(".", "_")}.png` });
  console.log("captured disassembly", frac);
}

// Terminal section mid-animation + settled
await page.evaluate(() => {
  document.getElementById("one-command").scrollIntoView({ block: "center", behavior: "instant" });
});
await page.waitForTimeout(600);
await page.screenshot({ path: `${outDir}/terminal-typing.png` });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${outDir}/terminal-done.png` });
console.log("captured terminal");

// Observability with trace particles revealed
await page.evaluate(() => {
  document.getElementById("observability").scrollIntoView({ block: "center", behavior: "instant" });
});
await page.waitForTimeout(1200);
await page.screenshot({ path: `${outDir}/observability-traces.png` });
console.log("captured observability");

// Architecture beams
await page.evaluate(() => {
  document.getElementById("architecture").scrollIntoView({ block: "center", behavior: "instant" });
});
await page.waitForTimeout(800);
await page.screenshot({ path: `${outDir}/architecture-beams.png` });
console.log("captured architecture");

// Control plane approval loop mid-state
await page.evaluate(() => {
  document.getElementById("control").scrollIntoView({ block: "center", behavior: "instant" });
});
await page.waitForTimeout(1800);
await page.screenshot({ path: `${outDir}/control-loop.png` });
console.log("captured control");

await browser.close();
console.log("done");
