import { test, expect } from "@playwright/test";

test.describe("evestack landing page", () => {
  test("renders every section with no console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
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
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "The open replacement",
    );
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
    expect(await page.locator("#hero canvas").count()).toBe(0);
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
