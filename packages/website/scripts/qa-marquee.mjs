/* Marquee QA, run against WebKit because the bug this guards is WebKit-only.
 *
 * The row is four identical groups, each translating by -100% of its own
 * width + one gap. WebKit resolves that percentage ONCE at animation start and
 * never re-resolves it, so any group whose width changes after the animation
 * begins (lazy images landing) desyncs the hand-off and tears a visible gap in
 * the row. Chrome re-resolves and hides the bug entirely, which is why this
 * asserts on webkit.
 *
 *   node scripts/qa-marquee.mjs [baseURL]
 */
import { webkit, chromium } from "@playwright/test";

const BASE = process.argv[2] ?? "http://localhost:3000";
const fail = [];
const ok = (name) => console.log(`  PASS  ${name}`);
const bad = (name, detail) => {
  fail.push(name);
  console.log(`  FAIL  ${name}\n        ${detail}`);
};

async function run(engine, name) {
  console.log(`\n${name}`);
  const browser = await engine.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });

  // Reach the marquee the way a visitor does, so the lazy images fetch late.
  await page.evaluate(() =>
    document.getElementById("integrations")?.scrollIntoView({ block: "end", behavior: "instant" }),
  );

  const groups = page.locator('ul[aria-label="Supported integrations"] > li');
  await groups.first().waitFor();

  // 1. Every image actually loads, including the three duplicate groups that
  //    sit outside the viewport horizontally. WebKit never fired their
  //    lazy-load intersection, so they scrolled through the row blank.
  const before = await groups.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
  await page.waitForFunction(() => {
    const imgs = [...document.querySelectorAll('ul[aria-label="Supported integrations"] img')];
    return imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0);
  }, null, { timeout: 30_000 }).then(
    () => ok("every image in all four groups loads"),
    async () => {
      const n = await page.evaluate(() => {
        const imgs = [...document.querySelectorAll('ul[aria-label="Supported integrations"] img')];
        return `${imgs.filter((i) => i.complete && i.naturalWidth > 0).length}/${imgs.length}`;
      });
      bad("every image in all four groups loads", `only ${n} loaded — blank groups will scroll through the row`);
    },
  );
  const after = await groups.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));

  const drift = before.map((w, i) => Math.abs(w - after[i]));
  const worst = Math.max(...drift);
  if (worst <= 1) ok(`group width stable across image load (max drift ${worst.toFixed(2)}px)`);
  else bad("group width stable across image load", `drift per group: ${drift.map((d) => d.toFixed(1)).join(", ")}px — the percentage translate was resolved against the wrong width`);

  // 2. All four groups are identical, or the hand-off cannot be seamless.
  const spread = Math.max(...after) - Math.min(...after);
  if (spread <= 1) ok(`all four groups identical (${after[0].toFixed(1)}px, spread ${spread.toFixed(2)}px)`);
  else bad("all four groups identical", `widths: ${after.map((w) => w.toFixed(1)).join(", ")}`);

  // 3. No gap: sample the row over a full cycle and require the painted track
  //    to cover the container's left edge at every sample.
  const gaps = [];
  for (let i = 0; i < 24; i++) {
    const g = await page.evaluate(() => {
      const ul = document.querySelector('ul[aria-label="Supported integrations"]');
      const box = ul.parentElement.getBoundingClientRect();
      const lis = [...ul.children].map((li) => li.getBoundingClientRect());
      const left = Math.min(...lis.map((r) => r.left));
      const right = Math.max(...lis.map((r) => r.right));
      // Largest hole between consecutive groups, plus any uncovered edge.
      const sorted = lis.slice().sort((a, b) => a.left - b.left);
      let hole = 0;
      for (let j = 1; j < sorted.length; j++) {
        hole = Math.max(hole, sorted[j].left - sorted[j - 1].right);
      }
      return { leftGap: left - box.left, rightGap: box.right - right, hole };
    });
    gaps.push(g);
    await page.waitForTimeout(250);
  }
  const worstLeft = Math.max(...gaps.map((g) => g.leftGap));
  const worstHole = Math.max(...gaps.map((g) => g.hole));
  const GAP_PX = 72; // --marquee-gap: 4.5rem, the legitimate spacing between groups
  if (worstLeft <= 1) ok(`row always covers the left edge (worst ${worstLeft.toFixed(2)}px)`);
  else bad("row always covers the left edge", `worst left gap ${worstLeft.toFixed(1)}px — this is the reported blank-left glitch`);
  if (worstHole <= GAP_PX + 2) ok(`no hole between groups (worst ${worstHole.toFixed(1)}px, gap is ${GAP_PX}px)`);
  else bad("no hole between groups", `worst hole ${worstHole.toFixed(1)}px vs expected ${GAP_PX}px`);

  // 4. Hover must not stop it.
  const box = await groups.first().boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const x1 = await groups.first().evaluate((e) => e.getBoundingClientRect().left);
  await page.waitForTimeout(1200);
  const x2 = await groups.first().evaluate((e) => e.getBoundingClientRect().left);
  if (Math.abs(x2 - x1) > 1) ok(`keeps moving under the cursor (${(x1 - x2).toFixed(1)}px in 1.2s)`);
  else bad("keeps moving under the cursor", "row froze on hover");

  const state = await groups.first().evaluate((e) => getComputedStyle(e).animationPlayState);
  if (state === "running") ok("animation-play-state stays running while hovered");
  else bad("animation-play-state stays running while hovered", `got "${state}"`);

  await browser.close();
}

await run(webkit, "WebKit (Safari engine) — the browser the bug reproduces on");
await run(chromium, "Chromium — regression guard");

console.log(fail.length ? `\n${fail.length} FAILED\n` : "\nall green\n");
process.exit(fail.length ? 1 : 0);
