import { test, expect } from "@playwright/test";
import { site } from "@/lib/copy";

/* @vercel/analytics and @vercel/speed-insights inject <script src="/_vercel/…">
   tags that exist only inside Vercel's runtime. This suite now starts its own
   server (playwright.config.ts), so those paths fall through to the 404 page and
   the browser logs a failed request plus a MIME-type refusal — four console
   errors that say nothing about this codebase.

   Filtered by path, not by loosening the assertion: a genuinely broken script on
   the page must still fail the suite. */
const VERCEL_RUNTIME_ONLY = "/_vercel/";

test.describe("evestack landing page", () => {
  test("renders every section with no console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
      const text = msg.text();
      if (msg.type() !== "error") return;
      // Chromium's text for a failed subresource carries no URL, so the
      // generic line is dropped alongside the attributable one.
      if (text.includes(VERCEL_RUNTIME_ONLY) || text.startsWith("Failed to load resource")) return;
      errors.push(text);
    });

    await page.goto("/");
    /* NINE sections, in the order a visitor meets them. Was twelve: `stats`
       was deleted, `control` merged into `observability`, and `code` merged
       into `architecture` (see app/page.tsx for why each one moved). The list
       is asserted in order so a future re-shuffle has to come through here
       rather than happening by accident. */
    for (const id of [
      "hero",
      "one-command",
      "features",
      "observability",
      "integrations",
      "architecture",
      "compare",
      "get-started",
    ]) {
      await expect(page.locator(`#${id}`)).toBeAttached();
    }
    // …and the merged-away ones are genuinely gone, not just unlinked.
    for (const id of ["stats", "control", "code", "quickstart"]) {
      await expect(page.locator(`#${id}`), `#${id} should be merged away`).toHaveCount(0);
    }
    // Asserted against lib/copy.ts, not a copy of the words. The headline is
    // re-tuned often, and a duplicated string here fails the build every time
    // for a reason that has nothing to do with the site being broken. What is
    // worth holding is structural: the h1 renders the canonical tagline.
    await expect(page.getByRole("heading", { level: 1 })).toContainText(site.tagline);
    expect(errors).toEqual([]);
  });

  test("no em dashes anywhere a visitor can read", async ({ page }) => {
    /* Sammy's rule, and it is a readability rule rather than a style one: an
       em dash is where a sentence gets a subordinate clause bolted on, and
       this page's copy problem was almost entirely bolted-on clauses. Pinning
       it in a test is the only way it stays true, because the character is
       invisible in review and every one of us types it by reflex.

       Scoped to rendered text, so code samples and the hero's ASCII glyph
       field are out of scope by construction. */
    await page.goto("/");
    const offenders = await page.evaluate(() => {
      const skip = new Set(["SCRIPT", "STYLE", "CODE", "PRE", "CANVAS"]);
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const found: string[] = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n.textContent ?? "";
        if (!text.includes("—")) continue;
        let el = n.parentElement;
        let inSkipped = false;
        while (el) {
          if (skip.has(el.tagName)) { inSkipped = true; break; }
          el = el.parentElement;
        }
        if (!inSkipped) found.push(text.trim().slice(0, 90));
      }
      return found;
    });
    expect(offenders, `em dash in rendered copy: ${offenders.join(" | ")}`).toEqual([]);
  });

  test("the hero says what it is, and that it is open source", async ({ page }) => {
    /* Both facts still have to be above the fold; only where they live moved.
       The eyebrow strip and the separate why line were cut on 2026-08-11 for
       stacking four text blocks above the buttons, so "open source" is now
       carried by the subhead itself. This asserts the FACTS rather than the
       elements, so the next layout change does not have to come through here
       unless it actually drops one. */
    await page.goto("/");
    const hero = page.locator("#hero");
    await expect(hero.getByRole("heading", { level: 1 })).toContainText("Run AI agents");
    await expect(hero.locator('[data-hero="sub"]')).toContainText(/open source/i);
    // …and the two cut elements stay cut.
    await expect(hero.locator('[data-hero="eyebrow"]')).toHaveCount(0);
    await expect(hero.locator('[data-hero="why"]')).toHaveCount(0);
  });

  test("the whole terminal types, and settles with one caret on the last line", async ({ page }) => {
    /* Was: line one typed, the other eight faded in as a cascade. The failure
       this guards is that regressing to a fade still LOOKS animated in a
       screenshot, so the assertions are about the mechanism: a line caught
       mid-type has an inline pixel width, and exactly one caret is lit while
       that is happening. */
    await page.goto("/");

    /* Watch for the typing marker with a MutationObserver installed BEFORE any
       scrolling, rather than polling for it afterwards. Polling raced the
       animation and lost on CI: a slower machine spends longer in the scroll
       loop, the terminal passes its trigger unobserved, and by the first
       assertion it has either finished or never started (the choreography
       skips the replay when it initialises with the terminal already on
       screen). Recording every state change removes the race entirely. */
    await page.addInitScript(() => {
      const w = window as unknown as { __typed?: boolean; __maxLit?: number };
      w.__typed = false;
      w.__maxLit = 0;
      /* Sampled every frame, and installed by addInitScript so it is running
         before any of the page's own script is.

         A MutationObserver was the first attempt and it lost the same race it
         was meant to fix: `data-typing` is stamped when the lazy choreography
         chunk sets up, which can land before a post-goto page.evaluate has
         installed anything, and an observer cannot see a mutation that already
         happened. A frame sampler has no such ordering requirement. */
      const tick = () => {
        if (document.querySelector("[data-term][data-typing]")) w.__typed = true;
        w.__maxLit = Math.max(
          w.__maxLit ?? 0,
          document.querySelectorAll(".terminal-cursor[data-on]").length,
        );
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.reload();

    await page.mouse.move(700, 450);
    const top = await page.evaluate(() => (document.querySelector("#one-command") as HTMLElement).offsetTop);
    while ((await page.evaluate(() => window.scrollY)) < top - 260) {
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(30);
    }

    const observed = await page.evaluate(() => {
      const w = window as unknown as { __typed?: boolean; __maxLit?: number };
      return { typed: w.__typed, maxLit: w.__maxLit };
    });
    expect(observed.typed, "the terminal entered its typing state").toBe(true);
    expect(observed.maxLit, "never more than one caret lit at a time").toBeLessThanOrEqual(1);

    // Settled: marker gone, every width handed back to CSS, caret on the last
    // line. The widths matter: a leftover inline width is not responsive.
    await expect(page.locator("[data-term][data-typing]")).toHaveCount(0, { timeout: 20_000 });
    const settled = await page.evaluate(() => {
      const shown = [...document.querySelectorAll<HTMLElement>(".terminal-cursor")].map(
        (c) => getComputedStyle(c).display !== "none",
      );
      return {
        inlineWidths: [...document.querySelectorAll<HTMLElement>("[data-term-text]")].filter(
          (e) => e.style.width,
        ).length,
        shownCount: shown.filter(Boolean).length,
        lastIsShown: shown[shown.length - 1] === true,
      };
    });
    expect(settled.inlineWidths, "no inline widths left behind").toBe(0);
    expect(settled.shownCount, "one caret at rest").toBe(1);
    expect(settled.lastIsShown, "and it is on the last line").toBe(true);
  });

  test("the terminal wears real macOS traffic lights", async ({ page }) => {
    await page.goto("/");
    const dots = await page.locator("[data-terminal] figcaption span span").evaluateAll((els) =>
      els.map((e) => getComputedStyle(e).backgroundColor),
    );
    expect(dots).toEqual(["rgb(255, 95, 87)", "rgb(254, 188, 46)", "rgb(40, 200, 64)"]);
  });

  test("the dashboard demo opens on Chat", async ({ page }) => {
    /* Sessions is a table and was the first thing a visitor met. Chat is a
       conversation with an agent, which is the product in one glance. */
    await page.goto("/");
    /* Scroll to it first, which is both what a visitor does and what makes
       this deterministic. The demo lives inside [data-terminal-result], which
       the choreography hides with autoAlpha (visibility: hidden) until it is
       reached, and a role query does not match hidden elements. Asserting
       straight after goto raced the lazy chunk: before it loaded the tabs were
       queryable, after it they were not. */
    await page.mouse.move(700, 450);
    const top = await page.evaluate(
      () => (document.querySelector("#one-command") as HTMLElement).offsetTop,
    );
    while ((await page.evaluate(() => window.scrollY)) < top) {
      await page.mouse.wheel(0, 500);
      await page.waitForTimeout(30);
    }

    const tabs = page.getByRole("tab");
    await expect(tabs.first()).toHaveText("Chat");
    await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
    await expect(tabs.nth(1)).toHaveText("Sessions");
    await expect(tabs.nth(2)).toHaveText("Integrations");
  });

  test("command pill copies to clipboard", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/");
    await page
      .getByRole("button", { name: 'Copy "npx evestack create"' })
      .first()
      .click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toBe("npx evestack create");
  });

  test("reduced motion renders full content, no canvas", async ({ browser }) => {
    const ctx = await browser.newContext({
      reducedMotion: "reduce",
      colorScheme: "dark",
    });
    const page = await ctx.newPage();
    await page.goto("/");
    await page.waitForTimeout(1500);
    // the 3D stage must fall back to the poster (no WebGL canvas); the glyph
    // field canvas is allowed — it renders one static frame under reduced motion
    expect(await page.locator("[data-hero-stage] canvas").count()).toBe(0);
    expect(await page.locator("[data-glyph-field] canvas").count()).toBe(1);
    // content fully visible without animation
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator("#compare table")).toBeAttached();
    await ctx.close();
  });

  test("theme switcher flips to light", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "light", exact: true }).click();
    await expect(page.locator("html")).toHaveClass(/light/);
  });

  test("wheel scrolling works immediately after load", async ({ page }) => {
    // Regression: Lenis must never arm smoothWheel (which preventDefaults
    // wheel events) before its raf driver exists — the page would freeze.
    await page.goto("/");
    await page.mouse.move(700, 450);
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(400);
    const early = await page.evaluate(() => window.scrollY);
    expect(early).toBeGreaterThan(0);
    // and again after the choreography chunk has settled (smoothed path)
    await page.waitForTimeout(1500);
    await page.mouse.wheel(0, 800);
    await page.waitForTimeout(700);
    const later = await page.evaluate(() => window.scrollY);
    expect(later).toBeGreaterThan(early);
  });

  test("hero copy is legible in the first frame, never animated in", async ({ page }) => {
    /* There is no hero entrance any more, on purpose: the headline, sub and
       CTAs are server-rendered and a GSAP intro used to hide them and replay
       them over ~1.6s, so a refresh flashed an empty hero.

       The test this replaced waited 2600ms and then checked opacity once,
       which passes whether or not an entrance exists — it could not fail if
       someone reintroduced the hide-and-replay. Sampling across the window
       the old entrance occupied is the assertion that actually holds. */
    await page.goto("/", { waitUntil: "commit" });
    const readCopy = () =>
      page.evaluate(() => {
        const op = (sel: string) => {
          const el = document.querySelector(sel);
          return el ? getComputedStyle(el).opacity : null;
        };
        return {
          h1: op("h1"),
          sub: op("[data-hero='sub']"),
          ctas: [...(document.querySelector("[data-hero='ctas']")?.children ?? [])].map(
            (c) => getComputedStyle(c).opacity,
          ),
        };
      });

    await page.locator("h1").waitFor({ state: "attached" });
    for (let i = 0; i < 14; i++) {
      const { h1, sub, ctas } = await readCopy();
      expect(h1, `h1 opacity at sample ${i}`).toBe("1");
      expect(sub, `sub opacity at sample ${i}`).toBe("1");
      expect(ctas, `cta opacities at sample ${i}`).toEqual(["1", "1", "1"]);
      await page.waitForTimeout(200);
    }

    // No leftover inline tween state on any of it.
    const inline = await page.evaluate(() =>
      [
        document.querySelector("h1"),
        document.querySelector("[data-hero='sub']"),
        ...(document.querySelector("[data-hero='ctas']")?.children ?? []),
      ].map((c) => c?.getAttribute("style") ?? ""),
    );
    for (const style of inline) {
      expect(style).not.toContain("visibility");
      expect(style).not.toContain("opacity");
    }
  });

  test("no-JS page is fully readable", async ({ browser }) => {
    const ctx = await browser.newContext({ javaScriptEnabled: false });
    const page = await ctx.newPage();
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator("#compare table")).toBeVisible();
    await expect(page.locator("[data-terminal-line]").first()).toBeVisible();
    await ctx.close();
  });
});
