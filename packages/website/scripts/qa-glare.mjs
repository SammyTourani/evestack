/* Frame-by-frame glare verification: capture the slab rim at key scrub states
   (rest → unglyph → explode → settled bars) so the glint can be judged at
   every geometry the scroll produces. Runs against :3000. */
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const outDir = "qa-shots/glare";
await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({
  args: ["--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist"],
});

const run = async (scheme, states) => {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: scheme,
  });
  await page.addInitScript((t) => localStorage.setItem("theme", t), scheme);
  await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
  await page.waitForTimeout(3500); // canvas ready + entrance settled
  for (const [name, y] of states) {
    await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" }), y);
    await page.waitForTimeout(900); // scrub + damp settle
    await page.screenshot({
      path: `${outDir}/${scheme}-${name}.png`,
      clip: { x: 340, y: 90, width: 760, height: 660 },
    });
    console.log("captured", scheme, name, "at scrollY", y);
  }
  await page.close();
};

/* hero = 220vh → sticky scroll range 120vh = 1080px at 900 viewport */
await run("dark", [
  ["p00-rest", 0],
  ["p30-unglyph", 320],
  ["p55-explode", 590],
  ["p80-bars", 860],
]);
await run("light", [
  ["p00-rest", 0],
  ["p80-bars", 860],
]);
await browser.close();
console.log("done —", outDir);
