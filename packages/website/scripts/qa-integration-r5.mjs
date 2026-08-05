/* Integration pass for the round-5 fixes (terminal empty-start, multi-row
   live feed, short code cards) — all three lanes together on the settled
   tree, walked like a real visitor. */
import { chromium } from "@playwright/test";

const OUT = process.argv[2] ?? ".";
const URL = "http://localhost:3000";

const browser = await chromium.launch();
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
await ctx.addInitScript((t) => localStorage.setItem("theme", t), "dark");
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text()}`);
});

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

/* 1 ── scroll toward #one-command like a reader; stop the moment the
   terminal card enters the viewport — it must be EMPTY. */
const termTop = await page.evaluate(() => {
  const el = document.querySelector("[data-terminal]");
  return el.getBoundingClientRect().top + window.scrollY;
});
let y = 0;
let entered = false;
while (y < termTop) {
  y += 120;
  await page.evaluate((v) => window.scrollTo(0, v), y);
  await page.waitForTimeout(120);
  const top = await page.evaluate(
    () => document.querySelector("[data-terminal]").getBoundingClientRect().top,
  );
  if (top < 900) {
    entered = true;
    break;
  }
}
if (!entered) throw new Error("never entered terminal viewport");
const linesAtEntry = await page.$$eval("[data-terminal-line]", (els) =>
  els.map((el) => getComputedStyle(el).opacity),
);
const emptyOK = linesAtEntry.every((o) => Number(o) === 0);
await page.screenshot({ path: `${OUT}/int-1-terminal-entry.png` });
console.log(`terminal entry: lines [${linesAtEntry}] → ${emptyOK ? "EMPTY ✓" : "VISIBLE ✗"}`);

/* 2 ── park the section center-screen; watch the live feed for its
   concurrency peak while the terminal types out. Mouse stays off the demo. */
await page.evaluate(() => {
  const el = document.querySelector("#one-command");
  window.scrollTo(0, el.offsetTop - 60);
});
await page.mouse.move(20, 20);
let maxConcurrent = 0;
let peakShot = false;
for (let i = 0; i < 45; i++) {
  await page.waitForTimeout(400);
  const running = await page.evaluate(
    () =>
      [...document.querySelectorAll("#one-command [class*=rounded-full]")].filter(
        (el) => el.textContent.trim() === "running",
      ).length,
  );
  if (running > maxConcurrent) maxConcurrent = running;
  if (running >= 3 && !peakShot) {
    peakShot = true;
    await page.screenshot({ path: `${OUT}/int-2-live-peak.png` });
  }
}
const termFinal = await page.$$eval("[data-terminal-line]", (els) =>
  els.map((el) => getComputedStyle(el).opacity),
);
const typedOK = termFinal.every((o) => Number(o) === 1);
await page.screenshot({ path: `${OUT}/int-3-onecommand-settled.png` });
console.log(`live feed: max concurrent running = ${maxConcurrent} (want ≥2)`);
console.log(`terminal typed out: [${termFinal}] → ${typedOK ? "✓" : "✗"}`);

/* 3 ── code cards: no internal scrolling either axis, at rest. */
await page.evaluate(() => {
  document.querySelector("#code").scrollIntoView({ block: "start" });
});
await page.waitForTimeout(2500);
const cards = await page.evaluate(() =>
  [...document.querySelectorAll("#code pre")].map((pre) => {
    const box = pre.closest("[class*=overflow]") ?? pre;
    return {
      sh: box.scrollHeight,
      ch: box.clientHeight,
      sw: box.scrollWidth,
      cw: box.clientWidth,
    };
  }),
);
const fitOK =
  cards.length === 3 && cards.every((c) => c.sh <= c.ch + 2 && c.sw <= c.cw + 2);
await page.screenshot({ path: `${OUT}/int-4-code-dark.png` });
console.log(
  `code cards: ${cards.map((c) => `${c.sw}x${c.sh} in ${c.cw}x${c.ch}`).join(" | ")} → ${fitOK ? "FIT ✓" : "OVERFLOW ✗"}`,
);
await ctx.close();

/* 4 ── light theme spot check of both sections */
const lctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
await lctx.addInitScript((t) => localStorage.setItem("theme", t), "light");
const lpage = await lctx.newPage();
lpage.on("pageerror", (e) => errors.push(`light pageerror: ${e.message}`));
await lpage.goto(URL, { waitUntil: "networkidle" });
await lpage.waitForSelector("#one-command", { state: "attached", timeout: 30000 });
await lpage.evaluate(() => {
  const el = document.querySelector("#one-command");
  window.scrollTo(0, el.offsetTop - 60);
});
await lpage.mouse.move(20, 20);
await lpage.waitForTimeout(9000);
await lpage.screenshot({ path: `${OUT}/int-5-onecommand-light.png` });
await lpage.evaluate(() => document.querySelector("#code").scrollIntoView());
await lpage.waitForTimeout(2000);
await lpage.screenshot({ path: `${OUT}/int-6-code-light.png` });
await lctx.close();
await browser.close();

console.log(`page errors: ${errors.length ? errors.join("\n") : "none"}`);
const pass = emptyOK && typedOK && maxConcurrent >= 2 && fitOK && errors.length === 0;
console.log(pass ? "INTEGRATION PASS" : "INTEGRATION FAIL");
process.exit(pass ? 0 : 1);
