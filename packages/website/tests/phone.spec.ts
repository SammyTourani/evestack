import { test, expect, devices } from "@playwright/test";

/* THE HOLE THIS CLOSES.
 *
 * On an iPhone 15 Pro viewport the landing page rendered 148 elements past the
 * right edge of the screen, four of them carrying prose that was cut off
 * mid-sentence, and the whole suite was green. It stayed green because the one
 * check anybody would think to write — does the page scroll sideways? — was
 * PASSING the entire time: document.scrollWidth was exactly 393. Every one of
 * those elements sat inside an ancestor with `overflow: hidden`, so the page
 * had nothing to scroll and the content was not off-screen, it was destroyed.
 *
 * So the predicate here is deliberately not "does the page scroll sideways".
 * It is: does any element extend past the viewport's right edge WITHOUT a
 * scrollable ancestor to reach it with? Overflow that lands in a real scroll
 * region is fine — the terminal in §01 is meant to be swiped, and the logo
 * marquee is an infinite strip by construction. Overflow that lands in an
 * overflow:hidden box is content the reader can never get to.
 *
 * The page must be SCROLLED before any of this can be measured. Every reveal in
 * choreography.tsx is `once: true` against a ScrollTrigger, so a section that
 * has never been on screen is still parked at width 0 / opacity 0 and measures
 * as nothing at all. A capture taken at scroll 0 would have found no defects in
 * seven of the nine sections and reported a clean page. */

const PHONE = devices["iPhone 13"];

/** Walk the whole page so every `once: true` reveal has fired and settled. */
async function scrollThrough(page: import("@playwright/test").Page) {
  await page.evaluate(async () => {
    const step = Math.round(window.innerHeight * 0.8);
    for (let y = 0; y <= document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 400));
  });
}

test.describe("phone layout", () => {
  test("no content is clipped off the right edge", async ({ browser }) => {
    const ctx = await browser.newContext({ ...PHONE, colorScheme: "dark" });
    const page = await ctx.newPage();
    await page.goto("/");
    await scrollThrough(page);

    const clipped = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const bad: string[] = [];
      document.querySelectorAll<HTMLElement>("main *, header *, footer *").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        /* Decoration is allowed to bleed: the hero's glow is 120vw and its
           stage is a 107vw film-back frame, both aria-hidden and both feathered
           by masks. Only content a reader is meant to read has to fit. */
        if (el.getAttribute("aria-hidden") === "true") return;
        if (el.closest('[aria-hidden="true"]')) return;
        /* The logo marquee is a ~13,400px seam-proof track inside an
           overflow-hidden window, by construction — see marquee-rows.tsx.
           Its overflow is the feature, so it opts out by attribute. */
        if (el.closest("[data-marquee]")) return;
        if (r.right - vw <= 1) return;
        for (let p = el.parentElement; p; p = p.parentElement) {
          const cs = getComputedStyle(p);
          if (p.scrollWidth > p.clientWidth + 2 && /auto|scroll/.test(cs.overflowX)) return;
        }
        bad.push(
          `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} ` +
            `+${Math.round(r.right - vw)}px "${(el.textContent ?? "").trim().slice(0, 40)}"`,
        );
      });
      return bad;
    });

    expect(clipped, `clipped with no way to scroll to it:\n${clipped.join("\n")}`).toEqual([]);
  });

  test("the page itself never scrolls sideways", async ({ browser }) => {
    /* Weak on its own — it was green through every bug above — but it is the
       check that catches a fix which trades clipping for a horizontally
       scrolling PAGE, which is the usual overcorrection. */
    const ctx = await browser.newContext({ ...PHONE, colorScheme: "dark" });
    const page = await ctx.newPage();
    await page.goto("/");
    await scrollThrough(page);
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
  });

  test("every control is at least 44px on both axes", async ({ browser }) => {
    /* 44x44 is the iOS Human Interface Guidelines floor. Some controls here
       keep a small PAINTED box on purpose — a copy button is a 28px glyph
       inside a 48px pill and growing it would move the pill — and pay the
       floor with a transparent pseudo-element instead, so the measurement has
       to include ::before and ::after or it reports false failures. */
    const ctx = await browser.newContext({ ...PHONE, colorScheme: "dark" });
    const page = await ctx.newPage();
    await page.goto("/");
    await scrollThrough(page);

    const small = await page.evaluate(() => {
      const bad: string[] = [];
      const sel = 'a, button, summary, [role="tab"], [role="menuitem"]';
      document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        if (String(el.className).includes("sr-only")) return;
        /* WCAG 2.5.8's Inline exception: a link sitting inside a sentence is
           exempt, because its size is set by the line-height of the prose
           around it and cannot be grown without moving that prose. This is not
           a loophole for convenience — it was tried the other way first. An
           out-of-flow 44px overlay on the closing CTA's "documentation" link
           reached 13px past a 20px line box, so 16 characters of the FOLLOWING
           line hit-tested to the link: tapping ordinary prose navigated to
           /docs, and the text under it could not be selected. A small inline
           target in a sentence is better than a big one over someone else's
           words. Anything blockified — a flex item, or a footer link that is
           `block` on a phone — is not inline and is still held to 44px. */
        if (getComputedStyle(el).display === "inline") return;
        let w = r.width;
        let h = r.height;
        for (const pseudo of ["::before", "::after"]) {
          const ps = getComputedStyle(el, pseudo);
          const pw = parseFloat(ps.width);
          const ph = parseFloat(ps.height);
          if (ps.content && ps.content !== "none" && pw && ph) {
            w = Math.max(w, pw);
            h = Math.max(h, ph);
          }
        }
        if (w < 44 || h < 44) {
          const name = (el.textContent ?? el.getAttribute("aria-label") ?? "").trim().slice(0, 30);
          bad.push(`${Math.round(w)}x${Math.round(h)} "${name}"`);
        }
      });
      return bad;
    });

    expect(small, `under the 44px floor:\n${small.join("\n")}`).toEqual([]);
  });

  test("the mobile menu can be dismissed by tapping outside it", async ({ browser }) => {
    /* The first version of this backdrop shipped inert and no test noticed,
       because nothing in this suite exercised open/close at all. #site-header
       carries `backdrop-blur-md`, which makes it the containing block for its
       own `position: fixed` descendants, so the summary's `inset: 0` pseudo
       resolved to the header's 393x64 box instead of the viewport: the
       backdrop covered the header strip, sat behind the header's content
       there, and could not be tapped anywhere on the page. The panel stayed
       open over whatever the reader had just jumped to.

       So this asserts the BEHAVIOUR (a tap outside closes it) rather than the
       geometry, and it taps well down the page where the old version provably
       did nothing. */
    const ctx = await browser.newContext({ ...PHONE, colorScheme: "dark" });
    const page = await ctx.newPage();
    await page.goto("/");
    const details = page.locator("#site-header details");
    await page.getByLabel("Menu").tap();
    await expect(details).toHaveAttribute("open", /.*/);

    const size = page.viewportSize()!;
    await page.touchscreen.tap(20, Math.round(size.height * 0.8));
    await expect(details).not.toHaveAttribute("open", /.*/);
    await ctx.close();
  });

  test("docs prose does not clip long inline code", async ({ browser }) => {
    /* /docs is fumadocs and is responsive everywhere it matters, with one
       exception worth a test: an inline <code> holding a path or a connection
       string is a single unbreakable token, and the docs grid clips rather
       than scrolls. /docs/troubleshooting's PATH value ran 139px past the edge
       with no way to reach the rest. */
    const ctx = await browser.newContext({ ...PHONE, colorScheme: "dark" });
    const page = await ctx.newPage();
    await page.goto("/docs/troubleshooting");
    const overflowing = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      return [...document.querySelectorAll<HTMLElement>("#nd-page :not(pre) > code")]
        .filter((el) => el.getBoundingClientRect().right - vw > 1)
        .map((el) => (el.textContent ?? "").slice(0, 50));
    });
    expect(overflowing).toEqual([]);
  });
});
