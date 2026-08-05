/* Dashboard live-feed QA: proves the Sessions loop converts its THREE
   permanent rows in place — staggered running→completed flips, 2–3 running
   concurrently, each ticking on its own clock — at a CONSTANT table size,
   settles on the exact demo-data values, then replays; and that the
   reduced-motion/SSR truth is the settled feed.
   Usage: node scripts/qa-dashboard-live.mjs [outDir] [baseUrl] */
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const outDir = process.argv[2] ?? "qa-shots";
const baseUrl = process.argv[3] ?? "http://localhost:3000";
await mkdir(outDir, { recursive: true });

/* settled truth — mirrors lib/demo-data.ts liveSessions, formatted like the UI */
const EXPECTED = [
  { title: "Deploy summary email to the team", in: "12,847", out: "2,164", cost: "$0.0034" },
  { title: "Summarize yesterday's error logs", in: "9,412", out: "1,876", cost: "$0.0027" },
  { title: "Draft release notes for v0.4.0", in: "11,038", out: "2,493", cost: "$0.0031" },
];

const failures = [];
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  if (!ok) failures.push(msg);
};
const toInt = (s) => parseInt(s.replace(/,/g, ""), 10);

const browser = await chromium.launch({
  args: ["--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist"],
});

const setup = async (page) => {
  page.on("pageerror", (err) => console.log("PAGE EXCEPTION:", err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log("CONSOLE ERROR:", msg.text());
  });
  await page.addInitScript((t) => localStorage.setItem("theme", t), "dark");
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  // center the demo, then park the mouse OFF it — hover pauses the loop
  await page.evaluate(() =>
    document
      .querySelector("#one-command [data-terminal-result]")
      .scrollIntoView({ block: "center", behavior: "instant" }),
  );
  await page.mouse.move(8, 8);
};

/* live rows only (panelId contains "-row-live-"); base rows never match */
const sample = (page) =>
  page.evaluate(() => {
    const btns = [...document.querySelectorAll('button[aria-controls*="-row-live-"]')];
    return {
      height: document.querySelector('[id$="-panel-Sessions"]')?.offsetHeight ?? -1,
      rows: btns.map((b) => {
        const c = b.children;
        return {
          title: c[0].textContent.trim(),
          status: c[1].textContent.trim(),
          in: c[4].textContent.trim(),
          out: c[5].textContent.trim(),
          cost: c[6].textContent.trim(),
        };
      }),
    };
  });

const matchesSettled = (rows) =>
  rows.length === EXPECTED.length &&
  rows.every((r) => r.status === "completed") &&
  EXPECTED.every((e) => {
    const r = rows.find((x) => x.title === e.title);
    return r && r.in === e.in && r.out === e.out && r.cost === e.cost;
  });

/* ── animated run ──────────────────────────────────────────────────── */
{
  const page = await browser.newPage({
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
  });
  await setup(page);
  // pin the Sessions tab (stops auto-rotation so we can watch ≥1.5 passes),
  // then get the cursor back OFF the demo so ticking isn't hover-paused,
  // and re-center the demo (the click can shift the scroll position under
  // the site's fixed header, which would ruin the screenshots)
  await page.getByRole("tab", { name: "Sessions" }).click();
  await page.mouse.move(8, 8);
  await page.evaluate(() =>
    document
      .querySelector("#one-command [data-terminal-result]")
      .scrollIntoView({ block: "center", behavior: "instant" }),
  );
  await page.waitForTimeout(250);
  const demo = page.locator("#one-command [data-terminal-result]");

  const samples = [];
  const heights = []; // panel offsetHeight AFTER the stream-in settles
  let maxConcurrent = 0;
  let shot2 = false;
  let shot3 = false;
  let settledShot = false;
  let seenRunning = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 26_000) {
    const t = Date.now() - t0;
    const { height, rows } = await sample(page);
    samples.push({ t, rows });
    if (t > 2500) heights.push(height); // stream-in done; must be constant now
    const running = rows.filter((r) => r.status === "running").length;
    if (running > 0) seenRunning = true;
    maxConcurrent = Math.max(maxConcurrent, running);
    if (running >= 2 && !shot2) {
      shot2 = true;
      await demo.screenshot({ path: `${outDir}/live-concurrent-2.png` });
      console.log("captured live-concurrent-2 at", t, "ms");
    }
    if (running >= 3 && !shot3) {
      shot3 = true;
      await demo.screenshot({ path: `${outDir}/live-concurrent-3.png` });
      console.log("captured live-concurrent-3 at", t, "ms");
    }
    if (!settledShot && seenRunning && matchesSettled(rows)) {
      settledShot = true;
      await demo.screenshot({ path: `${outDir}/live-settled.png` });
      console.log("captured live-settled at", t, "ms");
    }
    await page.waitForTimeout(400);
  }
  await page.close();

  // 0) the table NEVER grows: always exactly 3 live rows in the DOM
  check(
    samples.every((s) => s.rows.length === EXPECTED.length),
    `live row count is constant at ${EXPECTED.length} in all ${samples.length} samples`,
  );

  // 0b) constant panel height across ≥1.5 passes (the point of the redesign)
  const hMin = Math.min(...heights);
  const hMax = Math.max(...heights);
  check(
    hMax - hMin <= 2,
    `Sessions panel height constant: drift ${hMax - hMin}px over ${heights.length} samples (~${((samples[samples.length - 1].t - 2500) / 1000).toFixed(1)}s; min ${hMin}px, max ${hMax}px; need ≤2px)`,
  );

  // 1) concurrency
  check(maxConcurrent >= 2, `max concurrent running rows = ${maxConcurrent} (need ≥2)`);

  // 2) two concurrently-running rows tick DIFFERENT, INCREASING in-values
  let pairProof = null;
  outer: for (let i = 0; i < samples.length - 1 && !pairProof; i++) {
    const a = samples[i].rows.filter((r) => r.status === "running");
    if (a.length < 2) continue;
    for (let j = i + 1; j < samples.length; j++) {
      const b = samples[j].rows.filter((r) => r.status === "running");
      for (let x = 0; x < a.length; x++) {
        for (let y = x + 1; y < a.length; y++) {
          const bx = b.find((r) => r.title === a[x].title);
          const by = b.find((r) => r.title === a[y].title);
          if (!bx || !by) continue;
          if (
            toInt(a[x].in) !== toInt(a[y].in) &&
            toInt(bx.in) > toInt(a[x].in) &&
            toInt(by.in) > toInt(a[y].in)
          ) {
            pairProof = {
              rows: [a[x].title, a[y].title],
              from: [a[x].in, a[y].in],
              to: [bx.in, by.in],
              dtMs: samples[j].t - samples[i].t,
            };
            break outer;
          }
        }
      }
    }
  }
  check(
    !!pairProof,
    pairProof
      ? `concurrent rows tick independently: "${pairProof.rows[0]}" ${pairProof.from[0]}→${pairProof.to[0]}, "${pairProof.rows[1]}" ${pairProof.from[1]}→${pairProof.to[1]} over ${pairProof.dtMs}ms`
      : "no pair of concurrently-running rows with distinct, increasing in-values found",
  );

  // 3) conversion IN PLACE: a row goes running→completed while another row
  //    is still running in that same later sample
  let convProof = null;
  for (const e of EXPECTED) {
    const ranAt = samples.findIndex((s) =>
      s.rows.some((r) => r.title === e.title && r.status === "running"),
    );
    if (ranAt < 0) continue;
    const done = samples.findIndex(
      (s, k) =>
        k > ranAt &&
        s.rows.some((r) => r.title === e.title && r.status === "completed") &&
        s.rows.some((r) => r.title !== e.title && r.status === "running"),
    );
    if (done >= 0) {
      convProof = { title: e.title, ranAt: samples[ranAt].t, doneAt: samples[done].t };
      break;
    }
  }
  check(
    !!convProof,
    convProof
      ? `in-place conversion: "${convProof.title}" running at ${convProof.ranAt}ms → completed at ${convProof.doneAt}ms while another row still ran`
      : "no running→completed conversion observed alongside a still-running row",
  );

  // 4) the pass settles on the exact demo-data values (after running began)
  const firstRun = samples.findIndex((s) => s.rows.some((r) => r.status === "running"));
  const settledIdx =
    firstRun < 0 ? -1 : samples.findIndex((s, k) => k > firstRun && matchesSettled(s.rows));
  check(
    settledIdx >= 0,
    settledIdx >= 0
      ? `settled frame at ${samples[settledIdx].t}ms: all ${EXPECTED.length} live rows completed with exact demo-data In/Out/Cost`
      : "never observed the fully-settled frame",
  );

  // 5) the next pass begins: a settled row flips back to running
  if (settledIdx >= 0) {
    const rerun = samples
      .slice(settledIdx + 1)
      .some((s) => s.rows.some((r) => r.status === "running"));
    check(rerun, "next pass starts (a completed row flips back to running)");
  }
}

/* ── reduced-motion: the settled SSR truth, static ─────────────────── */
{
  const page = await browser.newPage({
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  await setup(page);
  await page.waitForTimeout(600);
  const a = await sample(page);
  await page.waitForTimeout(1200);
  const b = await sample(page);
  check(matchesSettled(a.rows), "reduced-motion renders the settled feed (all completed, full values)");
  check(JSON.stringify(a) === JSON.stringify(b), "reduced-motion feed is static across 1.2s");
  await page
    .locator("#one-command [data-terminal-result]")
    .screenshot({ path: `${outDir}/live-reduced-motion.png` });
  console.log("captured live-reduced-motion");
  await page.close();
}

await browser.close();
console.log(failures.length ? `\n${failures.length} FAILURE(S)` : "\nALL CHECKS PASSED");
process.exit(failures.length ? 1 : 0);
