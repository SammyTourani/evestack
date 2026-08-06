/* Visual QA sweep for the /docs route: several pages, both themes, desktop
   and mobile, plus the design tokens actually in use — so a mismatch with the
   landing page shows up as numbers, not vibes.
   Usage: node scripts/qa-docs-visual.mjs <outDir> <exportDir|url> */
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { readFile, stat, mkdir } from "node:fs/promises";
import path from "node:path";

const OUT = process.argv[2] ?? ".";
const TARGET = process.argv[3] ?? "https://evestack.vercel.app";
const PREFIX = ""; // served from the domain root on Vercel
await mkdir(OUT, { recursive: true });

const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".webp": "image/webp", ".avif": "image/avif", ".txt": "text/plain", ".woff2": "font/woff2",
};

let BASE = TARGET;
let server;
if (!TARGET.startsWith("http")) {
  server = createServer(async (req, res) => {
    let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (rel.startsWith(PREFIX)) rel = rel.slice(PREFIX.length);
    for (const c of [rel, `${rel}.html`, path.join(rel, "index.html")]) {
      const file = path.join(TARGET, c);
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
}

const browser = await chromium.launch();

async function shoot(label, urlPath, theme, width, height, full = false) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.addInitScript((t) => localStorage.setItem("theme", t), theme);
  const page = await ctx.newPage();
  await page.goto(`${BASE}${urlPath}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/${label}.png`, fullPage: full });
  const tokens = await page.evaluate(() => {
    const cs = (el) => (el ? getComputedStyle(el) : null);
    const body = cs(document.body);
    const h1 = cs(document.querySelector("h1"));
    const aside = cs(document.querySelector("aside"));
    const code = cs(document.querySelector("pre") ?? document.querySelector("code"));
    const link = cs(document.querySelector("article a, main a"));
    return {
      bodyBg: body?.backgroundColor,
      bodyColor: body?.color,
      h1Size: h1?.fontSize, h1Weight: h1?.fontWeight, h1Tracking: h1?.letterSpacing,
      h1Font: h1?.fontFamily?.split(",")[0],
      asideBg: aside?.backgroundColor,
      asideBorder: aside?.borderRightColor ?? aside?.borderColor,
      codeBg: code?.backgroundColor,
      codeFont: code?.fontFamily?.split(",")[0],
      linkColor: link?.color,
      contentWidth: document.querySelector("article")?.getBoundingClientRect().width,
    };
  });
  await ctx.close();
  return tokens;
}

const results = {};
results["docs-dark"] = await shoot("docs-index-dark", "/docs", "dark", 1440, 900);
results["docs-light"] = await shoot("docs-index-light", "/docs", "light", 1440, 900);
results["obs-dark"] = await shoot("docs-observability-dark", "/docs/observability", "dark", 1440, 900);
results["selfhost-dark"] = await shoot("docs-selfhosting-dark", "/docs/self-hosting", "dark", 1440, 900);
await shoot("docs-mobile-dark", "/docs", "dark", 390, 844);
/* the landing page, same theme, for a side-by-side token comparison */
results["landing-dark"] = await shoot("landing-dark", "/", "dark", 1440, 900);

await browser.close();
server?.close();

for (const [k, v] of Object.entries(results)) {
  console.log(`\n[${k}]`);
  for (const [tk, tv] of Object.entries(v)) console.log(`  ${tk}: ${tv}`);
}
console.log(`\nscreenshots → ${OUT}`);
