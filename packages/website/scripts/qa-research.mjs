/* QA for the research-round upgrades: terminal cadence, parked approval gate,
   beam draw-in + pings, decode reveals, zero-CLS count-ups, engraved CTA,
   bento dim, demo progress hairline. Dark = full pass w/ approve; light =
   spot-checks w/ deny. */
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const outDir = process.argv[2] ?? "qa-shots/research";
await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({
  args: ["--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist"],
});

const shoot = async (page, name) => {
  await page.screenshot({ path: `${outDir}/${name}.png` });
  console.log("captured", name);
};
const goTo = async (page, id) => {
  await page.evaluate(
    (s) => document.getElementById(s).scrollIntoView({ block: "center", behavior: "instant" }),
    id,
  );
};

/* ── dark pass ── */
const dark = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
});
await dark.goto("http://localhost:3000", { waitUntil: "networkidle" });
await dark.waitForTimeout(1800);

// terminal: mid-cascade, then settled (with demo running below)
await goTo(dark, "one-command");
await dark.waitForTimeout(1600);
await shoot(dark, "terminal-mid");
await dark.waitForTimeout(4500);
await shoot(dark, "demo-progress-mid");
await dark.waitForTimeout(9000);
await shoot(dark, "terminal-demo-settled");

// beams: mid-draw, then pings/settled
await goTo(dark, "architecture");
await dark.waitForTimeout(500);
await shoot(dark, "beams-mid-draw");
await dark.waitForTimeout(2500);
await shoot(dark, "beams-settled");

// code cards decode
await goTo(dark, "code");
await dark.waitForTimeout(400);
await shoot(dark, "code-decode-mid");
await dark.waitForTimeout(1600);
await shoot(dark, "code-settled");

// stats count-up (mid + settled)
await goTo(dark, "stats");
await dark.waitForTimeout(350);
await shoot(dark, "stats-mid");
await dark.waitForTimeout(1500);
await shoot(dark, "stats-settled");

// approval: parked → approve → executed
await goTo(dark, "control");
await dark.waitForTimeout(1800);
await shoot(dark, "approval-parked");
await dark.click("[data-approval-approve]");
await dark.waitForTimeout(1200);
await shoot(dark, "approval-mid");
await dark.waitForTimeout(2800);
await shoot(dark, "approval-executed");

// bento sibling dim on hover
await goTo(dark, "features");
await dark.waitForTimeout(1400);
await dark.hover("[data-bento] > li:nth-child(2)");
await dark.waitForTimeout(600);
await shoot(dark, "bento-dim");

// engraved closing CTA
await goTo(dark, "get-started");
await dark.waitForTimeout(1600);
await shoot(dark, "cta-engraved-dark");
await dark.close();

/* ── light pass ── */
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
await light.waitForTimeout(1200);

await goTo(light, "architecture");
await light.waitForTimeout(2200);
await shoot(light, "beams-light");

await goTo(light, "control");
await light.waitForTimeout(1800);
await shoot(light, "approval-parked-light");
await light.click("[data-approval-deny]");
await light.waitForTimeout(1200);
await shoot(light, "approval-denied-light");

await goTo(light, "get-started");
await light.waitForTimeout(1600);
await shoot(light, "cta-engraved-light");
await light.close();

await browser.close();
console.log("done →", outDir);
