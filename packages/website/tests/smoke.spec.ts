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
    for (const id of [
      "hero",
      "one-command",
      "compare",
      "code",
      "features",
      "architecture",
      "observability",
      "stats",
      "control",
      "integrations",
      "quickstart",
      "get-started",
    ]) {
      await expect(page.locator(`#${id}`)).toBeAttached();
    }
    // Asserted against lib/copy.ts, not a copy of the words. The headline is
    // re-tuned often, and a duplicated string here fails the build every time
    // for a reason that has nothing to do with the site being broken. What is
    // worth holding is structural: the h1 renders the canonical tagline.
    await expect(page.getByRole("heading", { level: 1 })).toContainText(site.tagline);
    expect(errors).toEqual([]);
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
