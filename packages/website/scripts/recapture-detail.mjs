/* One-off: re-capture session detail against a token-rich session. */
import { chromium } from "@playwright/test";

const outDir = new URL("../assets/screenshots-raw/", import.meta.url).pathname;
const sessionId = process.argv[2] ?? "wrun_01KZ6BJVMJ232ZDG6A8J1FZF8A";
const browser = await chromium.launch();
for (const scheme of ["dark", "light"]) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: scheme,
  });
  await page.goto(`http://localhost:4000/sessions/${sessionId}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${outDir}/session-detail-${scheme}.png` });
  await page.close();
  console.log("recaptured", scheme);
}
await browser.close();
