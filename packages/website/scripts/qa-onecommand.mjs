/* QA for the DashboardDemo v2: height-glide tab switches (no jumps),
   auto-rotating tabs (stops on user click), live chat animation, live
   integration connects. Runs against the dev server on :3000. */
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const outDir = "qa-shots/onecommand";
await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({
  args: ["--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
});
const shoot = (name) =>
  page.screenshot({ path: `${outDir}/${name}.png` }).then(() => console.log("captured", name));
const activeTab = () =>
  page.evaluate(() => document.querySelector("[role='tab'][aria-selected='true']").textContent);

await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
await page.evaluate(() =>
  document.getElementById("one-command").scrollIntoView({ block: "center", behavior: "instant" }),
);
await page.waitForTimeout(2500);
await shoot("sessions-initial");
console.log("tab at 2.5s:", await activeTab());

/* ── auto-rotate: by ~19s the tour should be on Chat, mid-animation ── */
await page.waitForTimeout(17000);
const tabAt20 = await activeTab();
console.log("tab at ~20s:", tabAt20, tabAt20 === "Chat" ? "(auto-rotated ✓)" : "(CHECK!)");
await page.waitForTimeout(2600); // thinking dots for exchange 1 → streaming
await shoot("chat-mid-animation");
await page.waitForTimeout(6000); // second exchange underway
await shoot("chat-late");

/* ── keep waiting: Integrations should arrive on its own ── */
await page.waitForTimeout(6000);
const tabAt34 = await activeTab();
console.log("tab at ~34s:", tabAt34, tabAt34 === "Integrations" ? "(auto-rotated ✓)" : "(CHECK!)");
await page.waitForTimeout(1400); // mid-connect
await shoot("integrations-connecting");
await page.waitForTimeout(3500); // all connected
await shoot("integrations-connected");

/* ── height glide: manual switch, sample container height mid-flight ── */
const heights = await page.evaluate(async () => {
  const buttons = [...document.querySelectorAll("[role='tab']")];
  const box = document.querySelector("[role='tabpanel']").parentElement;
  const sample = [];
  buttons.find((b) => b.textContent === "Sessions").click();
  const t0 = performance.now();
  await new Promise((r) => {
    const tick = () => {
      sample.push({ t: Math.round(performance.now() - t0), h: Math.round(box.getBoundingClientRect().height) });
      if (performance.now() - t0 < 650) requestAnimationFrame(tick);
      else r();
    };
    tick();
  });
  return sample.filter((_, i) => i % 6 === 0);
});
console.log("height glide samples (Sessions←Integrations):", JSON.stringify(heights));

/* ── manual click must stop the auto-tour ── */
const tabNow = await activeTab();
await page.waitForTimeout(17000); // > any dwell
const tabLater = await activeTab();
console.log(
  "after manual click:",
  tabNow,
  "→",
  tabLater,
  tabNow === tabLater ? "(auto stopped ✓)" : "(CHECK: auto still driving!)",
);
await shoot("after-manual-click");

/* ── reduced motion: everything settled, no auto-rotate ── */
const rm = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
  reducedMotion: "reduce",
});
await rm.goto("http://localhost:3000", { waitUntil: "networkidle" });
await rm.evaluate(() =>
  document.getElementById("one-command").scrollIntoView({ block: "center", behavior: "instant" }),
);
await rm.waitForTimeout(800);
const rmChat = await rm.evaluate(() => {
  document.querySelectorAll("[role='tab']")[1].click();
  return new Promise((r) =>
    setTimeout(() => r(document.getElementById(document.querySelector("[role='tab'][aria-selected='true']").getAttribute("aria-controls")).textContent.includes("Infrastructure: $0.00")), 400),
  );
});
console.log("reduced-motion chat settled:", rmChat ? "full convo ✓" : "CHECK!");
await rm.close();

await browser.close();
console.log("done →", outDir);
