/* QA for the rebuilt integrations section: hub firing sequence, colored
   marquee with seam-proof loop (no dead space at any viewport), hover
   beam lighting, both themes, wide + mobile. */
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const outDir = process.argv[2] ?? "qa-shots/integrations";
await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({
  args: ["--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist"],
});

const shoot = (page, name) =>
  page.screenshot({ path: `${outDir}/${name}.png` }).then(() => console.log("captured", name));
const goToIntegrations = (page) =>
  page.evaluate(() =>
    document.getElementById("integrations").scrollIntoView({ block: "center", behavior: "instant" }),
  );

/* dark, 1440 — firing sequence */
const dark = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
});
await dark.goto("http://localhost:3000", { waitUntil: "networkidle" });
await dark.waitForTimeout(1500);
await goToIntegrations(dark);
await dark.waitForTimeout(1100); // reveal + first beat firing (pulse in flight)
await shoot(dark, "hub-firing");
await dark.waitForTimeout(1400); // first label landed
await shoot(dark, "hub-label-1");
await dark.waitForTimeout(4200); // a later beat (github)
await shoot(dark, "hub-label-2");
await dark.waitForTimeout(12000); // sequence done → settled
await shoot(dark, "hub-settled");
// hover a tile → its beam lights. Dispatch the event directly — Playwright's
// actionability scrolling fights Lenis/smooth scroll-behavior.
await dark.evaluate(() => {
  document
    .querySelector("[data-hub-app='stripe']")
    .dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
});
await dark.waitForTimeout(500);
await shoot(dark, "hub-hover-beam");
await dark.close();

/* light, 1440 */
const light = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: "light",
});
await light.goto("http://localhost:3000", { waitUntil: "networkidle" });
await light.evaluate(() => {
  document.documentElement.classList.remove("dark");
  localStorage.setItem("theme", "light");
});
await light.waitForTimeout(1000);
await goToIntegrations(light);
await light.waitForTimeout(2800);
await shoot(light, "hub-light");
await light.close();

/* wide 1920 — the gap hunt: sample the marquee three times mid-loop */
const wide = await browser.newPage({
  viewport: { width: 1920, height: 700 },
  deviceScaleFactor: 1,
  colorScheme: "dark",
});
await wide.goto("http://localhost:3000#integrations", { waitUntil: "networkidle" });
await wide.evaluate(() =>
  document.querySelector("[aria-label='Supported integrations']").scrollIntoView({ block: "center", behavior: "instant" }),
);
for (const [i, delay] of [[1, 3000], [2, 9000], [3, 17000]]) {
  await wide.waitForTimeout(delay - (i === 1 ? 0 : [0, 3000, 9000][i - 1]));
  await shoot(wide, `marquee-wide-${i}`);
}
await wide.close();

/* mobile 375 */
const mobile = await browser.newPage({
  viewport: { width: 375, height: 812 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
});
await mobile.goto("http://localhost:3000", { waitUntil: "networkidle" });
await mobile.waitForTimeout(1200);
await goToIntegrations(mobile);
await mobile.waitForTimeout(2800);
await shoot(mobile, "hub-mobile");
await mobile.close();

await browser.close();
console.log("done →", outDir);
