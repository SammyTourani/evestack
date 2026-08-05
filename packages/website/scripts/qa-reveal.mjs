/* Two reported glitches, asserted by scrolling the page the way a visitor does.
 *
 *   1. The closing headline is painted through background-clip:text. A line
 *      reveal re-wrapped it and it rendered as a hollow outline first.
 *   2. The dashboard under the terminal was the last beat of the terminal's
 *      typing timeline, so it appeared on a ~2.4s timer rather than when its
 *      space came into view.
 */
import { chromium } from "@playwright/test";

const BASE = process.argv[2] ?? "http://localhost:3000";
const fail = [];
const ok = (n, d = "") => console.log(`  PASS  ${n}${d ? `\n        ${d}` : ""}`);
const bad = (n, d) => { fail.push(n); console.log(`  FAIL  ${n}\n        ${d}`); };

const browser = await chromium.launch({ args: ["--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(BASE, { waitUntil: "load" });
await page.waitForTimeout(1500);

/* ── 1. Closing headline is never split, never hollow ───────────────── */
// Scroll to it at a human pace and sample the whole way down.
const worst = { splitLines: 0, transparentChildren: 0 };
for (let i = 0; i < 60; i++) {
  await page.mouse.wheel(0, 700);
  await page.waitForTimeout(60);
  const s = await page.evaluate(() => {
    const h = document.querySelector("#closing-heading");
    if (!h) return null;
    // SplitText injects wrapper divs; the settled heading has only text nodes.
    const kids = [...h.children];
    return {
      splitLines: kids.filter((c) => (c.className || "").toString().includes("split")).length,
      elementChildren: kids.length,
      // The gradient must be painting: background-image set, colour transparent.
      bg: getComputedStyle(h).backgroundImage !== "none",
      inView: h.getBoundingClientRect().top < window.innerHeight && h.getBoundingClientRect().bottom > 0,
    };
  });
  if (!s) continue;
  worst.splitLines = Math.max(worst.splitLines, s.splitLines);
  if (s.inView && !s.bg) worst.transparentChildren++;
}
if (worst.splitLines === 0) ok("closing headline is never line-split (0 split wrappers across 60 samples)");
else bad("closing headline is never line-split", `saw ${worst.splitLines} split wrappers — the hollow-outline frame is back`);
if (worst.transparentChildren === 0) ok("closing headline keeps its gradient while on screen");
else bad("closing headline keeps its gradient", `${worst.transparentChildren} samples with no background-image`);

/* ── 2. Dashboard reveals on its own scroll position, not a timer ───── */
const page2 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page2.goto(BASE, { waitUntil: "load" });
await page2.waitForTimeout(1500);

// Creep down until the dashboard's top edge enters the viewport, then measure
// how long it takes to become visible from THAT moment.
let enteredAt = null;
let visibleAt = null;
for (let i = 0; i < 220; i++) {
  await page2.mouse.wheel(0, 120);
  await page2.waitForTimeout(40);
  const s = await page2.evaluate(() => {
    const r = document.querySelector("[data-terminal-result]");
    if (!r) return null;
    const box = r.getBoundingClientRect();
    return { top: box.top, vh: window.innerHeight, opacity: +getComputedStyle(r).opacity, t: performance.now() };
  });
  if (!s) break;
  if (enteredAt === null && s.top < s.vh) enteredAt = s.t;
  if (enteredAt !== null && visibleAt === null && s.opacity > 0.95) { visibleAt = s.t; break; }
}
if (visibleAt !== null) {
  const delay = Math.round(visibleAt - enteredAt);
  if (delay <= 900) ok(`dashboard visible ${delay}ms after its box entered the viewport`, "was ~2400ms on the terminal's typing timeline");
  else bad("dashboard reveals with its own space", `took ${delay}ms after entering the viewport — still on a timer`);
} else {
  bad("dashboard reveals with its own space", "never reached full opacity while scrolling to it");
}

/* ── 3. It must not depend on the terminal having typed ─────────────── */
// Jump straight past the terminal so its timeline never plays, and require the
// dashboard to still show up.
const page3 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page3.goto(BASE, { waitUntil: "load" });
await page3.waitForTimeout(1200);
await page3.evaluate(() => {
  const r = document.querySelector("[data-terminal-result]");
  window.scrollTo({ top: window.scrollY + r.getBoundingClientRect().top - window.innerHeight * 0.5, behavior: "instant" });
});
await page3.waitForTimeout(1400);
const jumped = await page3.evaluate(() => +getComputedStyle(document.querySelector("[data-terminal-result]")).opacity);
if (jumped > 0.95) ok(`dashboard visible after jumping straight to it (opacity ${jumped})`);
else bad("dashboard visible after jumping straight to it", `opacity ${jumped} — still coupled to the terminal timeline`);

await browser.close();
console.log(fail.length ? `\n${fail.length} FAILED\n` : "\nall green\n");
process.exit(fail.length ? 1 : 0);
