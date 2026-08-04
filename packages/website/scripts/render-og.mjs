/* Renders the static OG card (1200×630) from og-template.html. */
import { chromium } from "@playwright/test";

const tpl = new URL("./og-template.html", import.meta.url).href;
const out = new URL("../app/opengraph-image.png", import.meta.url).pathname;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.goto(tpl);
await page.waitForTimeout(200);
await page.screenshot({ path: out });
await browser.close();
console.log("wrote", out);
