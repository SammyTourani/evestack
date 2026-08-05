/* The sessions table must never show ruled-but-empty rows.
 *
 * A hidden SessionRow keeps its height and its border and only drops to
 * opacity 0, so a stalled reveal looks exactly like a table of blank lines.
 * Checking the panel's own opacity does NOT catch this — that was the miss.
 * This walks the page down at a visitor's pace and, from the first frame the
 * table is on screen, requires every row to be opaque AND to carry text.
 *
 *   node scripts/qa-dashboard-rows.mjs [baseURL]
 */
import { chromium, webkit } from "@playwright/test";

const BASE = process.argv[2] ?? "http://localhost:3000";
const OUT = process.env.QA_SHOT_DIR ?? null;
const fail = [];
const ok = (n, d = "") => console.log(`  PASS  ${n}${d ? `\n        ${d}` : ""}`);
const bad = (n, d) => { fail.push(n); console.log(`  FAIL  ${n}\n        ${d}`); };

/* A real function, not a string: page.evaluate() on a string evaluates it as
   an expression, so a "() => {...}" literal comes back as a Function and every
   assertion silently reads undefined. */
const SAMPLE = () => {
  const region = document.querySelector('[aria-label="Demo dashboard sessions"]');
  if (!region) return null;
  const box = region.getBoundingClientRect();
  const onScreen = box.top < window.innerHeight && box.bottom > 0;
  const rows = [...region.querySelectorAll("button[aria-expanded]")].map((b) => ({
    opacity: +getComputedStyle(b).opacity,
    text: (b.textContent || "").trim().length,
  }));
  return {
    onScreen,
    visibleFraction:
      Math.max(0, Math.min(box.bottom, window.innerHeight) - Math.max(box.top, 0)) / box.height,
    total: rows.length,
    faded: rows.filter((r) => r.opacity < 0.95).length,
    blank: rows.filter((r) => r.text === 0).length,
  };
};

async function run(engine, label) {
  console.log(`\n${label}`);
  const browser = await engine.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForTimeout(1200);

  let firstSeen = null;      // first sample where the table is on screen
  let worstFaded = 0, worstBlank = 0, samples = 0, total = 0;

  for (let i = 0; i < 200; i++) {
    await page.mouse.wheel(0, 160);
    await page.waitForTimeout(45);
    const s = await page.evaluate(SAMPLE);
    if (!s || !s.onScreen) { if (firstSeen) break; else continue; }
    total = s.total;
    if (!firstSeen) {
      firstSeen = s;
      if (OUT) await page.locator('[aria-label="Demo dashboard sessions"]').screenshot({ path: `${OUT}/rows-first-${label.split(" ")[0].toLowerCase()}.png` });
    }
    samples++;
    worstFaded = Math.max(worstFaded, s.faded);
    worstBlank = Math.max(worstBlank, s.blank);
    if (s.visibleFraction > 0.98 && samples > 40) break;
  }

  if (!firstSeen) { bad(`${label}: table found`, "never entered the viewport"); await browser.close(); return; }

  if (total > 0) ok(`table has ${total} rows`);
  else bad("table has rows", "found 0 row buttons");

  if (firstSeen.faded === 0 && firstSeen.blank === 0)
    ok(`every row is painted the FIRST frame the table is on screen (${total} rows)`);
  else
    bad("every row is painted the first frame the table is on screen",
        `${firstSeen.faded} faded, ${firstSeen.blank} blank of ${total} — these are the empty ruled lines`);

  if (worstFaded === 0 && worstBlank === 0)
    ok(`no row ever goes faded or blank while scrolling (${samples} samples)`);
  else
    bad("no row ever goes faded or blank while scrolling",
        `worst: ${worstFaded} faded, ${worstBlank} blank across ${samples} samples`);

  // Partial visibility used to stall the reveal: park the table half off-screen.
  await page.evaluate(() => {
    const r = document.querySelector('[aria-label="Demo dashboard sessions"]');
    window.scrollTo({ top: window.scrollY + r.getBoundingClientRect().top - window.innerHeight * 0.85, behavior: "instant" });
  });
  await page.waitForTimeout(900);
  const partial = await page.evaluate(SAMPLE);
  if (partial.faded === 0 && partial.blank === 0)
    ok(`fully painted when only ${(partial.visibleFraction * 100).toFixed(0)}% of the table is on screen`);
  else
    bad("fully painted when barely on screen",
        `${partial.faded} faded, ${partial.blank} blank at ${(partial.visibleFraction * 100).toFixed(0)}% visible`);

  await browser.close();
}

await run(chromium, "Chromium");
await run(webkit, "WebKit (Safari engine)");

console.log(fail.length ? `\n${fail.length} FAILED\n` : "\nall green\n");
process.exit(fail.length ? 1 : 0);
