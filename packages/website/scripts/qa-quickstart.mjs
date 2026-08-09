/* §9 quickstart QA: the pipeline and the receipt.

   Drives a real browser with real wheel scrolling (Lenis + once:true
   reveals ignore synthetic jumps) and asserts the section's whole contract:

     1. armed REST state just above the trigger line: stations show numbers,
        the receipt is ghost-dim, spine segments collapsed;
     2. entering the viewport plays the choreography SEQUENTIALLY — station 1
        lands green while station 4 is still a number, the spine fills, every
        receipt row reaches full ink and every ✓ lands ok-green;
     3. whole-row copy: command rows, the curl block and the llms.txt row
        put exactly their payloads (never the $ prompt) on the clipboard;
     4. reduced-motion and no-JS render the settled truth immediately;
     5. light theme + mobile (no horizontal page scroll) + zero console
        errors throughout.

   Usage: node scripts/qa-quickstart.mjs [outdir] [url]
   Screenshots land in outdir (default /tmp/qa-quickstart). */
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const OUT = process.argv[2] ?? "/tmp/qa-quickstart";
const URL = process.argv[3] ?? "http://localhost:3000";
mkdirSync(OUT, { recursive: true });

const failures = [];
const ok = (name) => console.log(`  ✓ ${name}`);
const fail = (name, detail) => {
  failures.push(`${name}: ${detail}`);
  console.log(`  ✗ ${name} — ${detail}`);
};
const assert = (cond, name, detail) => (cond ? ok(name) : fail(name, detail));

const browser = await chromium.launch({
  args: ["--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist"],
});

/* wheel the page until #quickstart's top crosses `line` (fraction of vh) */
async function wheelTo(page, line) {
  await page.mouse.move(700, 450);
  for (let i = 0; i < 80; i++) {
    const top = await page.evaluate(
      () => document.getElementById("quickstart").getBoundingClientRect().top,
    );
    const vh = page.viewportSize().height;
    if (top <= vh * line) return top;
    await page.mouse.wheel(0, Math.min(650, Math.max(140, top - vh * line)));
    await page.waitForTimeout(110);
  }
  return page.evaluate(
    () => document.getElementById("quickstart").getBoundingClientRect().top,
  );
}

const collectErrors = (page, bucket) => {
  page.on("pageerror", (e) => bucket.push(e.message));
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() !== "error") return;
    if (t.includes("/_vercel/") || t.startsWith("Failed to load resource")) return;
    bucket.push(t);
  });
};

/* ── 1+2+3: the motion play-through, dark ─────────────────────────────── */
{
  const errors = [];
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await ctx.newPage();
  collectErrors(page, errors);
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1800); // choreography chunk settles

  /* rest state: park with the section just below the trigger line
     (IO rootMargin bottom is -22%, so anything above 0.78vh is still calm) */
  await wheelTo(page, 0.96);
  await page.waitForTimeout(350);
  const rest = await page.evaluate(() => {
    const rail = document.querySelector(".qs");
    const num = rail.querySelector("[data-qs-num]");
    const check = rail.querySelector("[data-qs-check]");
    const seg = rail.querySelector("[data-qs-seg]");
    const row = document.querySelector(".qsp [data-qs-row]");
    return {
      armed: rail.hasAttribute("data-armed"),
      live: rail.hasAttribute("data-live"),
      numOp: +getComputedStyle(num).opacity,
      checkOp: +getComputedStyle(check).opacity,
      segTransform: getComputedStyle(seg).transform,
      rowOp: +getComputedStyle(row).opacity,
    };
  });
  assert(rest.armed && !rest.live, "armed but not live above the fold", JSON.stringify(rest));
  assert(rest.numOp > 0.9 && rest.checkOp < 0.1, "stations rest as numbers", `num ${rest.numOp} check ${rest.checkOp}`);
  assert(/matrix\(1, 0, 0, 0/.test(rest.segTransform), "spine collapsed at rest", rest.segTransform);
  assert(rest.rowOp < 0.45, "receipt rows ghost-dim at rest", `opacity ${rest.rowOp}`);
  await page.screenshot({ path: `${OUT}/1-rest.png` });

  /* enter → sequential play: station 1 must land while station 4 rests.
     Wheel until the RAIL itself (the observed element, below the heading)
     is well inside the IO line. */
  await wheelTo(page, 0.3);
  await page.waitForFunction(
    () => {
      const checks = document.querySelectorAll(".qs [data-qs-check]");
      return +getComputedStyle(checks[0]).opacity > 0.5;
    },
    undefined,
    { timeout: 6000, polling: 50 },
  );
  const midway = await page.evaluate(() => {
    const checks = document.querySelectorAll(".qs [data-qs-check]");
    return {
      first: +getComputedStyle(checks[0]).opacity,
      last: +getComputedStyle(checks[3]).opacity,
      ping: getComputedStyle(document.querySelector(".qs [data-qs-ping]")).animationName,
    };
  });
  assert(midway.first > 0.5 && midway.last < 0.5, "stations land in sequence", JSON.stringify(midway));
  assert(midway.ping === "qs-ping", "station ping armed", midway.ping);
  await page.screenshot({ path: `${OUT}/2-midplay.png` });

  /* settled: everything at full ink, spine drawn, ✓s ok-green */
  await page.waitForTimeout(4200);
  const settled = await page.evaluate(() => {
    const okColor = getComputedStyle(document.documentElement).getPropertyValue("--ds-ok").trim();
    const rows = [...document.querySelectorAll(".qsp [data-qs-row]")];
    const oks = [...document.querySelectorAll(".qsp [data-qs-ok]")];
    const segs = [...document.querySelectorAll(".qs [data-qs-seg]")];
    const checks = [...document.querySelectorAll(".qs [data-qs-check]")];
    const rcpts = [...document.querySelectorAll(".qs [data-qs-rcpt]")];
    const hex = (c) => {
      const m = c.match(/\d+/g).map(Number);
      return `#${m.slice(0, 3).map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    };
    return {
      okColor,
      rowsDim: rows.filter((r) => +getComputedStyle(r).opacity < 0.99).length,
      badOks: oks.filter((o) => hex(getComputedStyle(o).color) !== okColor.toLowerCase()).length,
      /* settled = the armed scaleY(0) override no longer applies: computed
         transform is either "none" (base state) or an identity matrix */
      segsOpen: segs.filter((s) => {
        const t = getComputedStyle(s).transform;
        return t === "none" || /matrix\(1, 0, 0, 1/.test(t);
      }).length,
      checksOn: checks.filter((c) => +getComputedStyle(c).opacity > 0.9).length,
      rcptsOn: rcpts.filter((r) => +getComputedStyle(r).opacity > 0.9).length,
      rowCount: rows.length,
      segs: segs.length,
      /* every step must be the same shape: a one-line receipt. A wrapped
         receipt makes its step taller than its neighbours, which is what
         made the old per-step spine segments look uneven. */
      rcptLines: rcpts.reduce((n, r) => n + r.getClientRects().length, 0),
    };
  });
  assert(settled.rowsDim === 0, "all receipt rows at full ink", `${settled.rowsDim}/${settled.rowCount} dim`);
  assert(settled.badOks === 0, "every ✓ is ok-green", `${settled.badOks} off-color`);
  /* one continuous spine, not one segment per step — per-step segments came
     out different lengths because the steps are different heights */
  assert(settled.segs === 1, "exactly one spine", `${settled.segs}`);
  assert(settled.segsOpen === 1, "spine fully drawn", `${settled.segsOpen}/${settled.segs}`);
  assert(settled.rcptLines === 4, "every receipt fits one line", `${settled.rcptLines} line-boxes across 4 receipts`);

  /* Geometry the design depends on: the spine runs dot-centre to dot-centre
     (a tail past the final ✓ reads as unfinished), and the receipt centres
     on the rail. Both are measured, so a copy change that moves a station
     fails here rather than shipping crooked. */
  const geo = await page.evaluate(() => {
    const s = document.getElementById("quickstart");
    const rail = s.querySelector(".qs").getBoundingClientRect();
    const panel = s.querySelector(".qsp").getBoundingClientRect();
    const track = s.querySelector(".qs > span").getBoundingClientRect();
    const mid = (el) => el.top + el.height / 2;
    const dots = [...s.querySelectorAll("[data-qs-dot]")].map((d) => mid(d.getBoundingClientRect()));
    return {
      headGap: Math.abs(track.top - dots[0]),
      tailGap: Math.abs(track.bottom - dots[dots.length - 1]),
      midGap: Math.abs(mid(rail) - mid(panel)),
    };
  });
  assert(geo.headGap <= 1.5, "spine starts on the first station", `${geo.headGap.toFixed(1)}px off`);
  assert(geo.tailGap <= 1.5, "spine ends on the last station, no tail", `${geo.tailGap.toFixed(1)}px off`);
  assert(geo.midGap <= 1.5, "receipt is centred on the rail", `${geo.midGap.toFixed(1)}px off`);
  assert(settled.checksOn === 4, "all four stations ✓", `${settled.checksOn}`);
  assert(settled.rcptsOn === 4, "all four receipt lines visible", `${settled.rcptsOn}`);
  await page.screenshot({ path: `${OUT}/3-settled.png` });

  /* copy affordances — scoped to the section (the hero and closing CTA
     carry their own "npx evestack create" copy buttons) */
  const qs = page.locator("#quickstart");
  await qs.getByRole("button", { name: 'Copy "npx evestack create"' }).click();
  let clip = await page.evaluate(() => navigator.clipboard.readText());
  assert(clip === "npx evestack create", "command row copies its payload", JSON.stringify(clip));

  await qs.getByRole("button", { name: 'Copy "docker compose up -d postgres"' }).click();
  clip = await page.evaluate(() => navigator.clipboard.readText());
  assert(clip === "docker compose up -d postgres", "compose row copies", JSON.stringify(clip));

  await qs.getByRole("button", { name: 'Copy "https://evestack.vercel.app/llms.txt"' }).click();
  clip = await page.evaluate(() => navigator.clipboard.readText());
  assert(clip === "https://evestack.vercel.app/llms.txt", "llms.txt row copies", JSON.stringify(clip));

  assert(errors.length === 0, "no console errors (motion pass)", errors.join(" | "));
  await ctx.close();
}

/* ── 4a: reduced motion = settled truth, instantly ────────────────────── */
{
  const errors = [];
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
    colorScheme: "dark",
  });
  const page = await ctx.newPage();
  collectErrors(page, errors);
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    const y = document.getElementById("quickstart").getBoundingClientRect().top + window.scrollY - 80;
    window.scrollTo({ top: y, behavior: "instant" });
  });
  await page.waitForTimeout(400);
  const rm = await page.evaluate(() => {
    const rail = document.querySelector(".qs");
    return {
      armed: rail.hasAttribute("data-armed"),
      checkOp: +getComputedStyle(rail.querySelector("[data-qs-check]")).opacity,
      rowOp: +getComputedStyle(document.querySelector(".qsp [data-qs-row]")).opacity,
    };
  });
  assert(!rm.armed, "reduced motion never arms", JSON.stringify(rm));
  assert(rm.checkOp > 0.9 && rm.rowOp > 0.99, "reduced motion shows settled truth", JSON.stringify(rm));
  assert(errors.length === 0, "no console errors (reduced motion)", errors.join(" | "));
  await ctx.close();
}

/* ── 4b: no-JS = fully readable ───────────────────────────────────────── */
{
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    javaScriptEnabled: false,
    colorScheme: "dark",
  });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  const nojs = await page.evaluate(() => {
    const rail = document.querySelector(".qs");
    const rows = [...document.querySelectorAll(".qsp [data-qs-row]")];
    return {
      hasRail: !!rail,
      armed: rail?.hasAttribute("data-armed"),
      checkOp: rail ? +getComputedStyle(rail.querySelector("[data-qs-check]")).opacity : 0,
      dimRows: rows.filter((r) => +getComputedStyle(r).opacity < 0.99).length,
      commandText: document.querySelector(".qs button")?.textContent?.trim(),
    };
  });
  assert(nojs.hasRail && !nojs.armed, "no-JS renders unarmed", JSON.stringify(nojs));
  assert(nojs.checkOp > 0.9 && nojs.dimRows === 0, "no-JS shows settled truth", JSON.stringify(nojs));
  assert(
    (nojs.commandText ?? "").includes("npx evestack create"),
    "no-JS shows the commands",
    JSON.stringify(nojs.commandText),
  );
  await ctx.close();
}

/* ── 5: light theme screenshot ────────────────────────────────────────── */
{
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: "light",
  });
  const page = await ctx.newPage();
  /* Playwright's colorScheme does NOT flip next-themes — set the stored theme */
  await page.addInitScript(() => localStorage.setItem("theme", "light"));
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1800);
  await wheelTo(page, 0.5);
  await page.waitForTimeout(5200);
  const light = await page.evaluate(() => ({
    isLight: !document.documentElement.classList.contains("dark"),
    okColor: getComputedStyle(document.documentElement).getPropertyValue("--ds-ok").trim(),
  }));
  assert(light.isLight, "light theme active", JSON.stringify(light));
  assert(light.okColor === "#0f766e", "light ok token in play", light.okColor);
  await page.screenshot({ path: `${OUT}/4-light.png` });
  await ctx.close();
}

/* ── 6: mobile — stacked layout, no horizontal page scroll ────────────── */
{
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
    hasTouch: true,
  });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const y = document.getElementById("quickstart").getBoundingClientRect().top + window.scrollY - 60;
    window.scrollTo({ top: y, behavior: "instant" });
  });
  await page.waitForTimeout(4800); // rail IO fires on jump; give it the full cascade
  const mob = await page.evaluate(() => {
    /* The page carries a pre-existing ~126px scrollWidth overflow from the
       hero's absolutely-positioned annotations — not this section's to fix.
       Assert the quickstart CONTRIBUTES nothing: hiding it must not change
       the page's scroll width. */
    const sw = () => document.scrollingElement.scrollWidth;
    const withQs = sw();
    document.getElementById("quickstart").style.display = "none";
    const withoutQs = sw();
    document.getElementById("quickstart").style.display = "";
    return {
      contribution: withQs - withoutQs,
      panelScrolls: (() => {
        const p = document.querySelector(".qsp .overflow-x-auto");
        return p ? p.scrollWidth > p.clientWidth : false;
      })(),
    };
  });
  assert(mob.contribution === 0, "quickstart adds no horizontal overflow on mobile", `${mob.contribution}px`);
  ok(`receipt panel ${mob.panelScrolls ? "scrolls internally" : "fits"} on mobile`);
  await page.screenshot({ path: `${OUT}/5-mobile.png`, fullPage: false });
  /* the receipt sits below the rail on mobile — capture it too */
  await page.evaluate(() => {
    const p = document.querySelector(".qsp");
    window.scrollTo({ top: p.getBoundingClientRect().top + window.scrollY - 40, behavior: "instant" });
  });
  await page.waitForTimeout(4200);
  await page.screenshot({ path: `${OUT}/6-mobile-receipt.png` });
  await ctx.close();
}

await browser.close();

console.log();
if (failures.length) {
  console.log(`${failures.length} check(s) failed:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`All checks passed. Screenshots in ${OUT}`);
