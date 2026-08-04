/* Captures REAL dashboard UI from :4000 (seeded Postgres) for the landing
   page — dark + light via prefers-color-scheme emulation, 2x. Outputs raw
   PNGs to public/screenshots/raw/; optimize-images.mjs bakes AVIF/WebP. */
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const outDir = new URL("../assets/screenshots-raw/", import.meta.url).pathname;
await mkdir(outDir, { recursive: true });

const dashboardUrl = process.env.DASHBOARD_URL ?? "http://localhost:4000";
const browser = await chromium.launch();

// find a session with a deep span tree
const health = await (await fetch(`${dashboardUrl}/api/health`)).json();
const sessionId = health.recentSessions?.[0]?.id;
console.log("session for detail capture:", sessionId);

for (const scheme of ["dark", "light"]) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: scheme,
  });
  await page.goto(dashboardUrl, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${outDir}/sessions-${scheme}.png` });
  if (sessionId) {
    await page.goto(`${dashboardUrl}/sessions/${sessionId}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${outDir}/session-detail-${scheme}.png` });
  }
  await page.close();
  console.log(`captured ${scheme}`);
}

await browser.close();
console.log("done");
