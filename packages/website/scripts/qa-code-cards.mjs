/* Code-walkthrough card QA: each of the three #code cards must show its whole
   excerpt inside the box — no internal scrolling on either axis, no comment
   lines — at desktop (1600) and mobile (390) widths.
   Usage: node scripts/qa-code-cards.mjs [outDir] [baseUrl] */
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const outDir = process.argv[2] ?? "qa-shots";
const baseUrl = process.argv[3] ?? "http://localhost:3000";
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();
let failures = 0;

function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const runs = [
  { tag: "dark-1600", width: 1600, theme: "dark" },
  { tag: "light-1600", width: 1600, theme: "light" },
  { tag: "dark-390", width: 390, theme: "dark" },
];

for (const { tag, width, theme } of runs) {
  const page = await browser.newPage({
    viewport: { width, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: theme,
  });
  page.on("pageerror", (err) => console.log("PAGE EXCEPTION:", err.message));
  await page.addInitScript((t) => localStorage.setItem("theme", t), theme);
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.locator("#code").scrollIntoViewIfNeeded();
  await page.waitForTimeout(2000); // reveal animations

  const cards = await page.evaluate(() =>
    [...document.querySelectorAll("#code figure")].map((f) => {
      const sc = f.querySelector(".code-scroll");
      const lines = sc.innerText.replace(/\n+$/, "").split("\n");
      return {
        filename: f.querySelector("figcaption span span")?.textContent ?? "?",
        lineCount: lines.length,
        commentLines: lines
          .map((l) => l.trim())
          .filter((t) => t.startsWith("//") || t.startsWith("#")),
        scrollH: sc.scrollHeight,
        clientH: sc.clientHeight,
        scrollW: sc.scrollWidth,
        clientW: sc.clientWidth,
        cardH: f.clientHeight,
      };
    }),
  );

  check(`${tag}: three cards`, cards.length === 3, `found ${cards.length}`);
  for (const c of cards) {
    const id = `${tag} ${c.filename}`;
    console.log(
      `      ${id}: ${c.lineCount} lines, card ${c.cardH}px, ` +
        `scroll ${c.scrollW}x${c.scrollH} in ${c.clientW}x${c.clientH}`,
    );
    check(`${id}: no vertical scroll`, c.scrollH <= c.clientH + 2);
    check(`${id}: no horizontal scroll`, c.scrollW <= c.clientW + 2);
    check(
      `${id}: no comment lines`,
      c.commentLines.length === 0,
      c.commentLines.join(" | "),
    );
  }
  const heights = [...new Set(cards.map((c) => c.cardH))];
  check(`${tag}: equal card heights`, heights.length === 1, heights.join(","));

  await page.locator("#code").screenshot({ path: `${outDir}/code-${tag}.png` });
  console.log(`captured ${outDir}/code-${tag}.png`);
  await page.close();
}

await browser.close();
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
