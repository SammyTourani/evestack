/* Terminal reveal QA (§3 one-command): proves the card enters the viewport
   EMPTY (hidden state applied at choreography setup, not at trigger time),
   the type-in/cascade/dashboard reveal still plays, mid-page loads never end
   with permanently hidden content, and reduced motion never hides anything.
   Usage: node scripts/qa-terminal-reveal.mjs [outDir] [baseUrl] */
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const outDir = process.argv[2] ?? "qa-shots/terminal-reveal";
const baseUrl = process.argv[3] ?? "http://localhost:3000";
await mkdir(outDir, { recursive: true });

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

/* page-context probe: opacities + prompt char visibility */
const probe = () => {
  const lines = [...document.querySelectorAll("[data-terminal-line]")].map(
    (el) => +getComputedStyle(el).opacity,
  );
  const result = document.querySelector("[data-terminal-result]");
  const prompt = document.querySelector("[data-terminal-prompt]");
  const charEls = prompt ? [...prompt.querySelectorAll("div")] : [];
  const term = document.querySelector("[data-terminal]");
  const rect = term?.getBoundingClientRect();
  const cursor = term?.querySelector(".terminal-cursor");
  const cRect = cursor?.getBoundingClientRect();
  const pRect = prompt?.getBoundingClientRect();
  return {
    lines,
    resultOpacity: result ? +getComputedStyle(result).opacity : null,
    charCount: charEls.length,
    visibleChars: charEls.filter((c) => getComputedStyle(c).visibility !== "hidden").length,
    promptVisibility: prompt ? getComputedStyle(prompt).visibility : null,
    promptText: prompt?.textContent ?? "",
    cursorOpacity: cursor ? +getComputedStyle(cursor).opacity : null,
    cursorVisibility: cursor ? getComputedStyle(cursor).visibility : null,
    cursorGap: cRect && pRect ? cRect.left - pRect.right : null,
    termTop: rect?.top ?? Infinity,
    vh: window.innerHeight,
    scrollY: window.scrollY,
  };
};

const browser = await chromium.launch({
  args: ["--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist"],
});

const newPage = async (ctxOpts = {}) => {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    colorScheme: "dark",
    ...ctxOpts,
  });
  await context.addInitScript((t) => localStorage.setItem("theme", t), "dark");
  const page = await context.newPage();
  page.on("pageerror", (err) => console.log("PAGE EXCEPTION:", err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log("CONSOLE ERROR:", msg.text());
  });
  return { context, page };
};

/* sample the cursor's computed opacity over a window — its CSS blink is
   1s step-end, so a revealed cursor must hit BOTH 1 and 0 across ~1.3s */
const sampleCursor = async (page, ms = 1300) => {
  const t0 = Date.now();
  let max = -1;
  let min = 2;
  let vis = null;
  while (Date.now() - t0 < ms) {
    const s = await page.evaluate(() => {
      const c = document.querySelector("[data-terminal] .terminal-cursor");
      return c ? { o: +getComputedStyle(c).opacity, v: getComputedStyle(c).visibility } : null;
    });
    if (s) {
      max = Math.max(max, s.o);
      min = Math.min(min, s.o);
      vis = s.v;
    }
    await page.waitForTimeout(90);
  }
  return { max, min, vis };
};

const settle = async (page, timeout = 10_000) => {
  /* wait until every line AND the dashboard reach opacity 1 */
  const t0 = Date.now();
  for (;;) {
    const p = await page.evaluate(probe);
    const done =
      p.lines.length > 0 &&
      p.lines.every((o) => o >= 0.99) &&
      (p.resultOpacity == null || p.resultOpacity >= 0.99);
    if (done) return { ok: true, ms: Date.now() - t0, p };
    if (Date.now() - t0 > timeout) return { ok: false, ms: Date.now() - t0, p };
    await page.waitForTimeout(150);
  }
};

/* ── 1 + 2 · FRESH SCROLL-IN, then THE REVEAL ─────────────────────── */
{
  const { context, page } = await newPage();
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);

  /* readiness: the fix applies hides at choreography setup, so at the top
     of the page the (off-screen) lines must go to opacity 0 */
  const armed = await page
    .waitForFunction(
      () => {
        const l = document.querySelector("[data-terminal-line]");
        return l && +getComputedStyle(l).opacity === 0;
      },
      { timeout: 10_000 },
    )
    .then(() => true)
    .catch(() => false);
  check("1. choreography armed at load (lines pre-hidden while off-screen)", armed);

  /* scroll toward the section in 120px steps */
  let entry = null;
  for (let y = 0; y < 12_000; y += 120) {
    await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" }), y);
    await page.waitForTimeout(150);
    const p = await page.evaluate(probe);
    if (p.termTop < p.vh) {
      entry = p;
      break;
    }
  }
  check("1. reached card entry", !!entry, entry ? `termTop=${Math.round(entry.termTop)}px, vh=${entry.vh}, trigger line=${Math.round(entry.vh * 0.7)}px` : "never entered viewport");
  if (entry) {
    check(
      "1. every [data-terminal-line] opacity 0 at first entry",
      entry.lines.length > 0 && entry.lines.every((o) => o === 0),
      `lines=[${entry.lines.join(",")}] (${entry.lines.length} lines)`,
    );
    check(
      "1. prompt chars split & hidden at first entry",
      entry.charCount > 0 && entry.visibleChars === 0,
      `${entry.visibleChars}/${entry.charCount} chars visible`,
    );
    check(
      "1. dashboard demo hidden at first entry",
      entry.resultOpacity === 0,
      `result opacity=${entry.resultOpacity}`,
    );
    check(
      "1. cursor hidden at first entry",
      entry.cursorOpacity === 0 && entry.cursorVisibility === "hidden",
      `opacity=${entry.cursorOpacity}, visibility=${entry.cursorVisibility}`,
    );
    await page.screenshot({ path: `${outDir}/1-first-entry.png` });
  }

  /* 2 · keep scrolling until card sits ~50% viewport, watch the reveal */
  await page.evaluate(() => {
    const t = document.querySelector("[data-terminal]");
    const y = window.scrollY + t.getBoundingClientRect().top - window.innerHeight * 0.5;
    window.scrollTo({ top: y, behavior: "instant" });
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${outDir}/2-typing.png` });
  const midType = await page.evaluate(probe);
  if (midType.visibleChars < midType.charCount) {
    check(
      "2. cursor still hidden mid-typing",
      midType.cursorOpacity === 0 && midType.cursorVisibility === "hidden",
      `${midType.visibleChars}/${midType.charCount} chars typed, cursor opacity=${midType.cursorOpacity}, visibility=${midType.cursorVisibility}`,
    );
  } else {
    check("2. cursor still hidden mid-typing", false, "typing already finished at +400ms probe");
  }
  /* the moment typing completes, the cursor must land at the line's end */
  const typed = await page
    .waitForFunction(
      () => {
        const p = document.querySelector("[data-terminal-prompt]");
        const cs = p ? [...p.querySelectorAll("div")] : [];
        return cs.length > 0 && cs.every((c) => getComputedStyle(c).visibility !== "hidden");
      },
      { timeout: 8000 },
    )
    .then(() => true)
    .catch(() => false);
  const landed = await page
    .waitForFunction(
      () => {
        const c = document.querySelector("[data-terminal] .terminal-cursor");
        return (
          c && getComputedStyle(c).visibility === "visible" && +getComputedStyle(c).opacity === 1
        );
      },
      { timeout: 3000 },
    )
    .then(() => true)
    .catch(() => false);
  await page.screenshot({ path: `${outDir}/2-cursor-landed.png` });
  const landedProbe = await page.evaluate(probe);
  check("2. cursor appears once typing completes", typed && landed, `typed=${typed}, landed=${landed}`);
  check(
    "2. cursor sits at the end of the finished command",
    landedProbe.cursorGap !== null && landedProbe.cursorGap >= 0 && landedProbe.cursorGap <= 14,
    `gap after prompt=${landedProbe.cursorGap?.toFixed(1)}px`,
  );
  const blink = await sampleCursor(page);
  check(
    "2. cursor blinks after landing (opacity hits 1 and 0)",
    blink.vis === "visible" && blink.max === 1 && blink.min === 0,
    `sampled max=${blink.max}, min=${blink.min}, visibility=${blink.vis}`,
  );
  await page.screenshot({ path: `${outDir}/2-cascade-early.png` });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${outDir}/2-cascade-late.png` });
  const fin = await settle(page);
  await page.screenshot({ path: `${outDir}/2-final.png` });
  check(
    "2. typing began after trigger (some chars visible mid-reveal)",
    midType.visibleChars > 0 || fin.p.visibleChars === fin.p.charCount,
    `${midType.visibleChars}/${midType.charCount} chars at +400ms`,
  );
  check(
    "2. final state fully revealed",
    fin.ok,
    `all lines=[${fin.p.lines.join(",")}], result=${fin.p.resultOpacity}, settled in ${fin.ms}ms`,
  );
  await context.close();
}

/* ── 3 · MID-PAGE LOAD (anchor/reload past the section) ───────────── */
{
  const { context, page } = await newPage();
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  /* DOM parsed (so #code exists and the body has height) but hydration +
     fonts — and therefore choreography/trigger init — haven't run yet */
  await page.evaluate(() =>
    window.scrollTo(0, document.querySelector("#code")?.offsetTop ?? 6000),
  );
  await page.waitForTimeout(2000);
  const past = await settle(page, 6000);
  check(
    "3. mid-page load: content visible while parked past the section",
    past.ok,
    `scrollY=${Math.round(past.p.scrollY)}, termTop=${Math.round(past.p.termTop)}, lines=[${past.p.lines.join(",")}], result=${past.p.resultOpacity} after ${past.ms}ms`,
  );
  /* scroll back up to the section — must still be fully visible */
  await page.evaluate(() => {
    const t = document.querySelector("[data-terminal]");
    window.scrollTo(0, window.scrollY + t.getBoundingClientRect().top - window.innerHeight * 0.4);
  });
  await page.waitForTimeout(600);
  const back = await settle(page, 6000);
  check(
    "3. mid-page load: section fully visible when scrolled back to it",
    back.ok && back.p.visibleChars === back.p.charCount,
    `lines=[${back.p.lines.join(",")}], chars ${back.p.visibleChars}/${back.p.charCount}, result=${back.p.resultOpacity}`,
  );
  const skipBlink = await sampleCursor(page);
  check(
    "3. mid-page load: cursor visible and blinking (never hidden)",
    skipBlink.vis === "visible" && skipBlink.max === 1,
    `sampled max=${skipBlink.max}, min=${skipBlink.min}, visibility=${skipBlink.vis}`,
  );
  /* re-center for the shot — late image decodes can shift offsets */
  await page.evaluate(() =>
    document.querySelector("[data-terminal]").scrollIntoView({ block: "center", behavior: "instant" }),
  );
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${outDir}/3-midpage-load.png` });
  await context.close();
}

/* ── 4 · REDUCED MOTION: nothing is ever hidden ───────────────────── */
{
  const { context, page } = await newPage({ reducedMotion: "reduce" });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000); // give any (wrong) hide code time to run
  await page.evaluate(() => {
    const t = document.querySelector("[data-terminal]");
    window.scrollTo(0, window.scrollY + t.getBoundingClientRect().top - window.innerHeight * 0.4);
  });
  await page.waitForTimeout(400);
  const rm = await page.evaluate(probe);
  check(
    "4. reduced motion: all lines fully visible immediately",
    rm.lines.length > 0 && rm.lines.every((o) => o === 1),
    `lines=[${rm.lines.join(",")}]`,
  );
  check(
    "4. reduced motion: prompt intact (no SplitText, visible)",
    rm.charCount === 0 && rm.promptVisibility === "visible" && rm.promptText.length > 0,
    `chars=${rm.charCount}, visibility=${rm.promptVisibility}, text="${rm.promptText}"`,
  );
  check("4. reduced motion: dashboard visible", rm.resultOpacity === 1, `result=${rm.resultOpacity}`);
  check(
    "4. reduced motion: cursor solid (blink disabled by CSS, never hidden)",
    rm.cursorOpacity === 1 && rm.cursorVisibility === "visible",
    `opacity=${rm.cursorOpacity}, visibility=${rm.cursorVisibility}`,
  );
  await page.screenshot({ path: `${outDir}/4-reduced-motion.png` });
  await context.close();
}

await browser.close();
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
