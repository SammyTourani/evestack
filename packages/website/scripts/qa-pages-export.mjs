/* Walks the deployed landing page: collects every failed request, checks
   all images decoded, and audits outbound links. Defaults to the live site;
   pass a preview URL to check a PR before merge. */
import { chromium } from "@playwright/test";

const URL = process.argv[3] ?? "https://evestack.vercel.app/";
const OUT = process.argv[2] ?? ".";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
const failures = [];
page.on("response", (r) => {
  if (r.status() >= 400) failures.push(`${r.status()} ${r.url()}`);
});
page.on("requestfailed", (r) => {
  const f = r.failure()?.errorText ?? "";
  if (!f.includes("ERR_ABORTED")) failures.push(`FAIL ${f} ${r.url()}`);
});
page.on("pageerror", (e) => failures.push(`pageerror: ${e.message}`));

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/pages-hero.png` });

/* walk the full page to trigger every lazy asset */
const height = await page.evaluate(() => document.body.scrollHeight);
for (let y = 0; y < height; y += 700) {
  await page.evaluate((v) => window.scrollTo(0, v), y);
  await page.waitForTimeout(250);
}
await page.waitForTimeout(2000);

/* Three buckets: decode-broken (fetched but empty), pending (lazy, never
   fetched — hidden tabs / marquee tail; verified by direct HTTP below),
   and ok. SVGs can report naturalWidth 0 while rendering fine, so the
   real gate is the HTTP sweep over every distinct src. */
const imgAudit = await page.evaluate(() =>
  [...document.querySelectorAll("img")].map((img) => ({
    src: img.getAttribute("src"),
    complete: img.complete,
    decoded: img.naturalWidth > 0 || img.getBoundingClientRect().width > 0,
  })),
);
const broken = imgAudit.filter((i) => i.complete && !i.decoded && !i.src?.endsWith(".svg"));
/* The site moved off GitHub Pages to the domain root, so the old /evestack/
   deploy prefix must appear nowhere — its presence means a stale hardcoded path. */
const stalePrefixed = imgAudit.filter((i) => i.src?.startsWith("/evestack/"));
const distinctSrcs = [...new Set(imgAudit.map((i) => i.src).filter((s) => s?.startsWith("/")))];
const http = await page.evaluate(async (srcs) => {
  const bad = [];
  for (const s of srcs) {
    const r = await fetch(s).catch(() => null);
    if (!r || r.status >= 400) bad.push(`${r ? r.status : "ERR"} ${s}`);
  }
  return bad;
}, distinctSrcs);

/* Collect absolute and root-relative hrefs WITHOUT excluding the retired
   /evestack prefix — that prefix is exactly what badInternal below has to be
   able to see. Filtering it out here would make that gate vacuously pass. */
const links = await page.evaluate(() =>
  [...document.querySelectorAll("a[href]")]
    .map((a) => a.getAttribute("href"))
    .filter((h) => h.startsWith("http") || h.startsWith("/")),
);
const badInternal = links.filter((h) => h.startsWith("/evestack"));
const staleGithub = links.filter((h) => h.includes("github.com/evestack"));
const realGithub = links.filter((h) => h.includes("github.com/SammyTourani/evestack")).length;

await page.screenshot({ path: `${OUT}/pages-bottom.png` });
console.log(
  `images: ${imgAudit.length} total, ${broken.length} decode-broken, ${stalePrefixed.length} stale-prefixed, ${distinctSrcs.length} distinct srcs HTTP-checked (${http.length} bad)`,
);
broken.slice(0, 5).forEach((b) => console.log(`  broken: ${b.src}`));
stalePrefixed.slice(0, 5).forEach((b) => console.log(`  stale-prefixed: ${b.src}`));
http.slice(0, 10).forEach((b) => console.log(`  http: ${b}`));
console.log(`links: ${realGithub} → SammyTourani/evestack, ${staleGithub.length} stale, ${badInternal.length} bad internal`);
console.log(`request failures: ${failures.length}`);
failures.slice(0, 10).forEach((f) => console.log(`  ${f}`));

await browser.close();
const pass =
  broken.length === 0 &&
  stalePrefixed.length === 0 &&
  http.length === 0 &&
  staleGithub.length === 0 &&
  badInternal.length === 0 &&
  realGithub >= 2 &&
  failures.length === 0;
console.log(pass ? "EXPORT PASS" : "EXPORT FAIL");
process.exit(pass ? 0 : 1);
