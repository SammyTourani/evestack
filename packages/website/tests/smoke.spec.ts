import { test, expect } from "@playwright/test";

/* @vercel/analytics and @vercel/speed-insights inject <script src="/_vercel/…">
   tags that only exist inside Vercel's runtime. Served anywhere else — which
   now includes `pnpm preview`, since the site stopped being a static export —
   those paths fall through to the 404 page and the browser logs both a failed
   request and a MIME-type refusal. Four console errors that say nothing about
   this codebase. */
const VERCEL_RUNTIME_ONLY = "/_vercel/";

/* Chromium's console text for a failed subresource is just "Failed to load
   resource: …404…" with no URL in it, so a text filter wide enough to drop the
   two analytics entries would also swallow a genuinely missing image or font.
   Missing resources are therefore asserted at the response layer, where the URL
   is available and only /_vercel/ can be excluded by name. The console
   assertion keeps everything it can still attribute. */
function isUnattributable(text: string) {
  return text.startsWith("Failed to load resource");
}

test.describe("evestack landing page", () => {
  test("renders every section with no console errors", async ({ page }) => {
    const errors: string[] = [];
    const missing: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
      const text = msg.text();
      if (msg.type() !== "error") return;
      if (text.includes(VERCEL_RUNTIME_ONLY) || isUnattributable(text)) return;
      errors.push(text);
    });
    page.on("response", (res) => {
      if (res.status() < 400) return;
      const url = new URL(res.url());
      if (url.pathname.startsWith(VERCEL_RUNTIME_ONLY)) return;
      missing.push(`${res.status()} ${url.pathname}`);
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
      "run eve agents in production",
    );
    expect(errors).toEqual([]);
    expect(missing).toEqual([]);
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

  test("hero copy is legible in the first frame, never animated in", async ({ page }) => {
    // The headline, sub and CTAs are the point of the page. They used to be
    // hidden by a GSAP intro and played back over ~1.6s, so a refresh flashed
    // an empty hero. They must now be opaque immediately and STAY opaque —
    // sampling across the window the old entrance occupied catches any
    // reintroduced hide-and-replay, which a single late assertion would miss.
    await page.goto("/", { waitUntil: "commit" });
    const readCopy = () =>
      page.evaluate(() => {
        const op = (sel: string) => {
          const el = document.querySelector(sel);
          return el ? getComputedStyle(el).opacity : null;
        };
        return {
          h1: op("#hero-heading"),
          sub: op("[data-hero='sub']"),
          ctas: [...(document.querySelector("[data-hero='ctas']")?.children ?? [])].map(
            (c) => getComputedStyle(c).opacity,
          ),
        };
      });

    await page.locator("#hero-heading").waitFor({ state: "attached" });
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
        document.querySelector("#hero-heading"),
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

/* The compatibility matrix is generated into public/compat by a prebuild step
   rather than authored as a route, so nothing in the Next build fails if it
   stops being produced — the page would simply 404 while every other check
   here stayed green. That is exactly the page whose absence matters most: it
   is the artifact the whole "certified against every eve release" claim rests
   on, and it is linked from the docs. */
test.describe("compatibility matrix", () => {
  test("is served at /compat and carries real recorded runs", async ({ page }) => {
    const response = await page.goto("/compat");
    expect(response?.status()).toBe(200);

    // The version we ship must appear as a certified column, and the release
    // with the known auth bypass must still be shown as broken. A matrix that
    // renders but has quietly lost its red row is worse than no matrix.
    await expect(page.locator("th.vh", { hasText: "0.30.8" }).first()).toBeVisible();
    await expect(page.locator("td.s-fail").first()).toBeVisible();
  });
});
