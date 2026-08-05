/* Verifies the Fumadocs /docs route as GitHub Pages will serve it: under the
   /evestack prefix, static, no server. Checks rendering, the upstream-link
   nav (the capability the platform was chosen for), and asset resolution.

   Serves out/ itself, because Pages resolves an extensionless /docs/x to
   x.html while a plain static server returns the directory of RSC payloads
   Next writes alongside it — testing against that would prove nothing.

   Usage: node scripts/qa-docs-export.mjs <outDir> [exportDir|liveUrl] */
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const OUT = process.argv[2] ?? ".";
const TARGET = process.argv[3] ?? "";
const PREFIX = "/evestack";

const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".webp": "image/webp", ".avif": "image/avif", ".txt": "text/plain",
  ".woff2": "font/woff2",
};

let BASE = TARGET;
let server;
if (!TARGET.startsWith("http")) {
  const root = TARGET || "out";
  server = createServer(async (req, res) => {
    let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (rel.startsWith(PREFIX)) rel = rel.slice(PREFIX.length);
    const candidates = [rel, `${rel}.html`, path.join(rel, "index.html")];
    for (const c of candidates) {
      const file = path.join(root, c);
      try {
        if (!(await stat(file)).isFile()) continue;
        res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
        res.end(await readFile(file));
        return;
      } catch {}
    }
    res.writeHead(404).end("not found");
  });
  await new Promise((r) => server.listen(0, r));
  BASE = `http://localhost:${server.address().port}${PREFIX}`;
  console.log(`serving ${root} at ${BASE}`);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const failures = [];
page.on("response", (r) => {
  if (r.status() >= 400) failures.push(`${r.status()} ${r.url()}`);
});
page.on("pageerror", (e) => failures.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") failures.push(`console: ${m.text()}`);
});

await page.goto(`${BASE}/docs`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

/* the page rendered real content, not an unstyled MDX dump */
const info = await page.evaluate(() => {
  const links = [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"));
  const body = document.body;
  return {
    h1: document.querySelector("h1")?.textContent?.trim(),
    // Mintlify components must have been mapped, not rendered as unknown tags
    unknownTags: [...document.querySelectorAll("*")]
      .map((e) => e.tagName.toLowerCase())
      .filter((t) => ["note", "warning", "cardgroup", "card", "steps", "step"].includes(t)),
    upstreamLinks: links.filter((h) => h?.includes("eve.dev")),
    internalDocLinks: links.filter((h) => h?.startsWith("/evestack/docs")).length,
    unprefixed: links.filter((h) => h?.startsWith("/") && !h.startsWith("/evestack")),
    styled: getComputedStyle(body).backgroundColor,
    fontFamily: getComputedStyle(document.querySelector("h1") ?? body).fontFamily,
  };
});

await page.screenshot({ path: `${OUT}/docs-introduction.png`, fullPage: false });

/* the sidebar must interleave upstream links with local pages */
await page.goto(`${BASE}/docs/upgrading`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);
const navText = await page.evaluate(() => {
  const aside = document.querySelector("aside") ?? document.body;
  return aside.innerText.replace(/\n+/g, " | ").slice(0, 400);
});
await page.screenshot({ path: `${OUT}/docs-upgrading.png` });

await browser.close();
server?.close();

console.log(`h1: ${info.h1}`);
console.log(`mintlify tags left unmapped: ${info.unknownTags.length ? info.unknownTags.join(",") : "none ✓"}`);
console.log(`upstream eve.dev links in nav: ${info.upstreamLinks.length} → ${info.upstreamLinks.slice(0, 3).join(", ")}`);
console.log(`internal /docs links: ${info.internalDocLinks}`);
console.log(`unprefixed internal links: ${info.unprefixed.length ? info.unprefixed.join(",") : "none ✓"}`);
console.log(`body bg: ${info.styled} | h1 font: ${info.fontFamily.split(",")[0]}`);
console.log(`sidebar: ${navText.slice(0, 240)}`);
console.log(`request failures: ${failures.length}`);
failures.slice(0, 8).forEach((f) => console.log(`  ${f}`));

const pass =
  !!info.h1 &&
  info.unknownTags.length === 0 &&
  info.upstreamLinks.length >= 4 &&
  info.unprefixed.length === 0 &&
  failures.length === 0;
console.log(pass ? "DOCS EXPORT PASS" : "DOCS EXPORT FAIL");
process.exit(pass ? 0 : 1);
