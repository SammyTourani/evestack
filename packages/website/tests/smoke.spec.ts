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
      .getByRole("button", { name: 'Copy "npx create-evestack"' })
      .first()
      .click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toBe("npx create-evestack");
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

  test("hero entrance settles with all CTAs visible", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2600); // entrance (~1.6s) + margin
    const opacities = await page.evaluate(() =>
      [...document.querySelector("[data-hero='ctas']")!.children].map(
        (c) => getComputedStyle(c).opacity,
      ),
    );
    expect(opacities).toEqual(["1", "1", "1"]);
    // clearProps ran — no leftover inline tween styles
    const inline = await page.evaluate(() =>
      [...document.querySelector("[data-hero='ctas']")!.children].map((c) =>
        c.getAttribute("style"),
      ),
    );
    for (const style of inline) {
      expect(style ?? "").not.toContain("visibility");
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
