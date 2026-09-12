/* Regenerates app/opengraph-image.png (1200x630) — the card every X, LinkedIn,
   Slack and Discord share renders. It is a baked PNG, so nothing in the build
   catches it drifting from lib/copy.ts.

   REBUILT 2026-08-09. The previous generator (og-template.html + render-og.mjs)
   was deleted at some point and the baked PNG went stale in TWO ways at once,
   both live on the shared card:
     - tagline: "The whole eve stack. On your own machine."  (superseded)
     - command: "$ npx create-evestack"                      (superseded by
       `npx evestack create` in PR #37 — the front door)

   The strings below are READ FROM lib/copy.ts, not retyped, so this can never
   drift again. Re-run after any copy change:
       node scripts/render-og.mjs
       node scripts/render-og.mjs --check    # exit 1 if the PNG is stale

   The mark is ▚ (U+259A, upper-left + lower-right quadrants) drawn as SVG, in
   the film's blue. It is drawn rather than typed for the same reason the film
   draws it: a block-drawing codepoint is exactly what a subsetted font drops.
   The quadrants TOUCH — inset, they read as two disconnected dots. */

import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const OUT = resolve(ROOT, "app/opengraph-image.png");
const ALT = resolve(ROOT, "app/opengraph-image.alt.txt");
const check = process.argv.includes("--check");

/* ---- strings, read from the single source of truth ---------------------- */
const copySrc = readFileSync(resolve(ROOT, "lib/copy.ts"), "utf8");
const pick = (key) => {
  const m = copySrc.match(new RegExp(`^\\s*${key}:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "m"));
  if (!m) throw new Error(`render-og: could not read \`${key}\` from lib/copy.ts`);
  return m[1].replace(/\\"/g, '"');
};
const NAME = pick("name");
const TAGLINE = pick("tagline");
const COMMAND = pick("command");

/* ---- fonts, inlined so the page needs no network ------------------------ */
const font = (p) => {
  const f = resolve(ROOT, "node_modules/geist", p);
  if (!existsSync(f)) throw new Error(`render-og: missing font ${f}`);
  return readFileSync(f).toString("base64");
};
const SANS = font("dist/fonts/geist-sans/Geist-Medium.woff2");
const MONO = font("dist/fonts/geist-mono/GeistMono-Regular.woff2");

const BLUE = "#0B84F3";
const html = `<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:G;src:url(data:font/woff2;base64,${SANS}) format('woff2');font-weight:500}
@font-face{font-family:GM;src:url(data:font/woff2;base64,${MONO}) format('woff2');font-weight:400}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1200px;height:630px;background:#000;overflow:hidden}
.card{position:relative;width:1200px;height:630px;font-family:G,sans-serif;-webkit-font-smoothing:antialiased}
/* the soft teal/blue wash, offset right like the original */
.glow{position:absolute;left:300px;top:60px;width:760px;height:430px;border-radius:50%;
  background:radial-gradient(50% 50% at 50% 50%,rgba(11,132,243,.30) 0%,rgba(0,128,128,.16) 45%,transparent 72%);
  filter:blur(46px)}
.frame{position:absolute;left:48px;top:44px;width:1104px;height:542px;border:1px solid #262626}
.vrule{position:absolute;left:600px;top:44px;width:1px;height:542px;background:#262626}
.hrule{position:absolute;left:48px;top:332px;width:1104px;height:1px;background:#262626}
.body{position:absolute;left:128px;top:118px;width:940px}
.name{font-size:78px;line-height:1;letter-spacing:-3.4px;color:#EDEDED;margin-top:34px}
.tag{font-size:30px;line-height:1;letter-spacing:-.7px;color:#8F8F8F;margin-top:34px}
.row{position:absolute;left:128px;top:455px;width:944px;display:flex;align-items:center;justify-content:space-between}
.pill{display:inline-flex;align-items:center;height:58px;padding:0 30px;border:1px solid #333;
  border-radius:999px;font-family:GM,monospace;font-size:25px;letter-spacing:-.4px;color:#EDEDED;
  background:rgba(255,255,255,.02)}
.pill .d{color:#7A7A7A;margin-right:14px}
.meta{font-family:GM,monospace;font-size:19px;letter-spacing:2.1px;color:#7A7A7A}
</style>
<div class="card">
  <div class="glow"></div>
  <div class="frame"></div><div class="vrule"></div><div class="hrule"></div>
  <div class="body">
    <svg width="76" height="76" viewBox="0 0 2 2" fill="${BLUE}" aria-hidden="true">
      <rect x="0" y="0" width="1" height="1" rx=".13"/><rect x="1" y="1" width="1" height="1" rx=".13"/>
    </svg>
    <div class="name">${NAME}</div>
    <div class="tag">${TAGLINE}</div>
  </div>
  <div class="row">
    <div class="pill"><span class="d">$</span>${COMMAND}</div>
    <div class="meta">OPEN SOURCE · APACHE-2.0</div>
  </div>
</div>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);

/* Guard the one failure the old card had no way to catch: text overflowing its
   column, or the pill colliding with the right-hand meta line. */
const fits = await page.evaluate(() => {
  const r = (s) => document.querySelector(s).getBoundingClientRect();
  return {
    tagRight: Math.round(r(".tag").right),
    pillRight: Math.round(r(".pill").right),
    metaLeft: Math.round(r(".meta").left),
    nameRight: Math.round(r(".name").right),
  };
});
const problems = [];
if (fits.tagRight > 1152) problems.push(`tagline overflows the frame (right=${fits.tagRight} > 1152)`);
if (fits.nameRight > 1152) problems.push(`name overflows the frame (right=${fits.nameRight} > 1152)`);
if (fits.pillRight + 32 > fits.metaLeft)
  problems.push(`pill collides with the meta line (pill right=${fits.pillRight}, meta left=${fits.metaLeft})`);
if (problems.length) {
  await browser.close();
  console.error("render-og: layout check FAILED\n  - " + problems.join("\n  - "));
  process.exit(1);
}

const buf = await page.screenshot({ type: "png" });
await browser.close();

if (check) {
  const same = existsSync(OUT) && Buffer.compare(buf, readFileSync(OUT)) === 0;
  console.log(same ? "render-og: up to date" : "render-og: STALE — run `node scripts/render-og.mjs`");
  process.exit(same ? 0 : 1);
}

writeFileSync(OUT, buf);
/* The alt text carries the tagline VERBATIM. It used to be
   `TAGLINE.toLowerCase().replace(/\.$/, "")`, which had two faults and shipped
   both: lowercasing the whole string turns "Run AI agents" into "run ai
   agents", and stripping the final period without restoring one runs the next
   sentence straight into it — "on your own machine Install with". A screen
   reader reads this line aloud. */
writeFileSync(ALT, `${NAME}: ${TAGLINE} Install with \`${COMMAND}\`. Open source, Apache-2.0.\n`);
console.log(`render-og: wrote ${OUT} (${(buf.length / 1024).toFixed(0)} kB)`);
console.log(`  tagline  ${TAGLINE}`);
console.log(`  command  $ ${COMMAND}`);
console.log(`  layout   tag→${fits.tagRight}  pill→${fits.pillRight}  meta←${fits.metaLeft}`);
