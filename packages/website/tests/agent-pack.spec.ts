import { test, expect, devices } from "@playwright/test";
import { agentPack, site } from "@/lib/copy";

/* The agent pack — the routes that serve it and the two controls that hand it
   over.
 *
 * The assertion that matters most is that the clipboard gets the SAME BYTES the
 * route serves. This whole feature exists so a stranger's agent learns the true
 * thing about evestack, and the failure mode that would be invisible is a
 * button that copies a stale or partial payload while /agent.md looks fine. So
 * the test fetches the route and compares, rather than checking that something
 * plausible landed on the clipboard. */

test.describe("agent pack routes", () => {
  test("/agent.md serves a complete, self-contained pack", async ({ request }) => {
    const response = await request.get("/agent.md");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/plain");

    const body = await response.text();

    // The instruction to persist it comes first — an agent that can write files
    // should turn one paste into a durable skill.
    expect(body).toContain("If you can write files, save this as a skill");
    expect(body).toContain(".claude/skills/evestack/SKILL.md");

    // Every section of the pack is inlined. A local model with no fetch tool is
    // the case this exists for, so a reference that is linked rather than
    // included is a broken pack, not a smaller one.
    expect(body).toContain("## `SKILL.md`");
    for (const reference of ["cli", "build-an-agent", "dashboard", "troubleshooting"]) {
      expect(body, `references/${reference}.md must be inlined`).toContain(
        `## \`references/${reference}.md\``,
      );
    }

    // Frontmatter is routing metadata for a skills runtime, not prose. It must
    // not survive into the pasted document as raw YAML.
    expect(body).not.toContain("license: Apache-2.0\nmetadata:");

    // Load-bearing facts, spot-checked. These are the ones whose absence would
    // make the pack confidently wrong rather than merely thin.
    expect(body).toContain("npm run db:bootstrap");
    expect(body).toContain("not a fork");
    expect(body).toContain("beta");
  });

  test("/llms-full.txt serves every doc page in reading order", async ({ request }) => {
    const response = await request.get("/llms-full.txt");
    expect(response.status()).toBe(200);

    const body = await response.text();

    // meta.json order, not alphabetical: introduction before troubleshooting.
    const order = ["/docs/index", "/docs/quickstart", "/docs/architecture", "/docs/troubleshooting"];
    const positions = order.map((slug) => body.indexOf(slug));
    expect(positions.every((p) => p > -1), `missing one of ${order.join(", ")}`).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));

    // Nested sections ship too — docs/channels/* is the only one, and a
    // directory-recursion bug would drop it silently.
    expect(body).toContain("/docs/channels/slack");

    // It is the firehose, not a summary.
    expect(body.length).toBeGreaterThan(150_000);
  });

  test("/llms.txt still points agents at both companions", async ({ request }) => {
    const body = await (await request.get("/llms.txt")).text();
    expect(body).toContain("/agent.md");
    expect(body).toContain("/llms-full.txt");
  });
});

test.describe("the copy control", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("copies exactly what /agent.md serves", async ({ page, request }) => {
    const served = await (await request.get("/agent.md")).text();

    await page.goto("/");
    /* Structural, not by-name: copying CHANGES the accessible name, so a
       by-name locator re-resolves to the section's copy of this component
       halfway through the assertion and reports the wrong element's text. */
    const button = page.locator('[data-agent-pack="primary"] button').first();
    await expect(button).toContainText(agentPack.label);
    await button.click();

    await expect(button).toContainText(agentPack.copied);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toBe(served);

    // …and it reverts, so the control does not read as permanently spent.
    await expect(button).toContainText(agentPack.label, { timeout: 5000 });
  });

  test("hovering the button opens the menu, and crossing the gap keeps it open", async ({ page }) => {
    /* Hover-open, added 2026-08-11. Two failure modes worth pinning, because
       both look fine in a screenshot and are infuriating in use:

       1. It does not open without a click.
       2. It opens, and then closes the instant the pointer crosses the 8px gap
          between the button and the panel, so the item being travelled toward
          disappears before you reach it. The close delay and the invisible
          bridge both exist for that, and neither is visible to review. */
    await page.goto("/");
    const menu = page.locator("[data-agent-menu]").first();
    await expect(menu).not.toHaveAttribute("data-open", /.*/);
    // Closed means genuinely out of reach, not merely transparent.
    await expect(menu).toHaveAttribute("inert", /.*/);

    await page.locator("#hero").locator('[data-agent-pack="primary"]').hover();
    await expect(menu).toHaveAttribute("data-open", /.*/, { timeout: 2000 });
    await expect(menu).not.toHaveAttribute("inert", /.*/);

    // Travel from the button down to the LAST row, crossing the gap.
    await menu.locator("[data-agent-menu-item]").last().hover();
    await page.waitForTimeout(400);
    await expect(menu, "crossing the gap must not close it").toHaveAttribute("data-open", /.*/);

    // Leaving closes it, and it goes inert again.
    await page.mouse.move(60, 60);
    await expect(menu).not.toHaveAttribute("data-open", /.*/, { timeout: 2000 });
    await expect(menu).toHaveAttribute("inert", /.*/);
  });

  test("on touch, where there is no hover, tapping still works", async ({ browser }) => {
    /* This is the bug hover-open shipped with, found on an iPhone 13 profile:
       a tap emits pointerenter, pointerup, THEN pointerleave, because the
       pointer stops existing when the finger lifts. So the tap opened the menu
       and the same tap closed it again, and the control was simply dead on
       every phone. The hover handlers are gated on (hover: hover) now, and
       focus only opens for :focus-visible so the tap's own focus cannot
       re-introduce it. */
    const ctx = await browser.newContext({ ...devices["iPhone 13"], colorScheme: "dark" });
    const page = await ctx.newPage();
    await page.goto("/");
    const menu = page.locator("[data-agent-menu]").first();
    await expect(menu).not.toHaveAttribute("data-open", /.*/);

    await page.getByLabel(agentPack.menuLabel).first().tap();
    await expect(menu).toHaveAttribute("data-open", /.*/, { timeout: 2000 });

    // …and it is a toggle there, since there is no pointer-leave to close it.
    await page.getByLabel(agentPack.menuLabel).first().tap();
    await expect(menu).not.toHaveAttribute("data-open", /.*/, { timeout: 2000 });
    await ctx.close();
  });

  test("every destination carries its own mark", async ({ page }) => {
    await page.goto("/");
    await page.locator("#hero").locator('[data-agent-pack="primary"]').hover();
    const items = page.locator("[data-agent-menu]").first().locator("[data-agent-menu-item]");
    await expect(items).toHaveCount(3);
    for (let i = 0; i < 3; i++) {
      await expect(items.nth(i).locator("svg").first()).toBeVisible();
    }
  });

  test("the menu opens, lists every destination, and closes on Escape", async ({ page }) => {
    await page.goto("/");
    const caret = page.getByRole("button", { name: agentPack.menuLabel }).first();

    await caret.click();
    await expect(caret).toHaveAttribute("aria-expanded", "true");

    const menu = page.getByRole("menu");
    for (const item of agentPack.menu) {
      await expect(menu.getByRole("menuitem", { name: new RegExp(item.label) })).toBeVisible();
    }

    await page.keyboard.press("Escape");
    /* Not toHaveCount(0): the panel is MOUNTED whether open or closed, so it
       can animate out as well as in. "Closed" is the data-open attribute being
       gone and the panel going inert, which is also what makes the links leave
       the tab order. */
    await expect(menu.first()).not.toHaveAttribute("data-open", /.*/);
    await expect(menu.first()).toHaveAttribute("inert", /.*/);
    await expect(caret).toHaveAttribute("aria-expanded", "false");
  });

  test("the hero menu stays inside the viewport", async ({ page }) => {
    /* The hero menu opens inside a position:sticky viewport on a very tall
       section, so anything below the fold there cannot be scrolled to —
       scrolling scrubs the disassembly instead of moving the page. Clipped
       means unreachable, which is why the flip exists. */
    await page.goto("/");
    await page.getByRole("button", { name: agentPack.menuLabel }).first().click();

    const box = await page.getByRole("menu").boundingBox();
    expect(box).not.toBeNull();
    const viewport = page.viewportSize()!;
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
  });
});

test.describe("the closing CTA carries all three ways to start", () => {
  test("command, agent pack and GitHub sit on one row", async ({ page }) => {
    /* Replaces the §Two ways in tests. That section drew the same fork one
       screen above this CTA, which already offered the command, so the fork
       moved here rather than being dropped. What has to hold is that all three
       routes are present and reachable at the point a reader decides. */
    await page.goto("/");
    const closing = page.locator("#get-started");

    await expect(closing.getByRole("button", { name: `Copy "${site.command}"` })).toBeVisible();
    await expect(closing.locator('[data-agent-pack="primary"]')).toBeVisible();
    await expect(closing.getByRole("link", { name: /Star on GitHub/ })).toBeVisible();

    // The pack button here is a real one, not a decorative copy: it opens.
    await closing.locator('[data-agent-pack="primary"]').hover();
    await expect(closing.locator("[data-agent-menu]")).toHaveAttribute("data-open", /.*/, {
      timeout: 2000,
    });
  });

  test("its menu opens upward, since it sits at the foot of the page", async ({ page }) => {
    /* The flip matters more here than in the hero: there is footer below, and
       a menu dropping down at the bottom of the document would hang off the
       viewport with nothing to scroll to. */
    await page.goto("/");
    await page.mouse.move(700, 450);
    const top = await page.evaluate(
      () => (document.querySelector("#get-started") as HTMLElement).offsetTop,
    );
    while ((await page.evaluate(() => window.scrollY)) < top - 200) {
      await page.mouse.wheel(0, 800);
      await page.waitForTimeout(30);
    }
    const closing = page.locator("#get-started");
    await closing.locator('[data-agent-pack="primary"]').hover();
    const menu = closing.locator("[data-agent-menu]");
    await expect(menu).toHaveAttribute("data-open", /.*/, { timeout: 2000 });

    const box = await menu.boundingBox();
    const viewport = page.viewportSize()!;
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
  });

  test("the deleted section left nothing behind", async ({ page }) => {
    /* Both rounds of deletion in one assertion. The first took the pipeline
       rail and the verify receipt (data-qs-*); the second took the two path
       cards and their CSS. A stray attribute or class here would be a selector
       with no rule left to match: silently unstyled rather than loudly
       broken. */
    await page.goto("/");
    await expect(page.locator("#quickstart")).toHaveCount(0);
    for (const sel of [
      "[data-qs-dot]",
      "[data-qs-seg]",
      "[data-qs-rcpt]",
      "[data-qs-row]",
      ".path-card",
      ".path-card-rail",
      ".cmd-plate",
    ]) {
      await expect(page.locator(sel), `${sel} should be gone`).toHaveCount(0);
    }
  });

  test("no-JS still offers the command, and a route to the pack", async ({ browser }) => {
    /* The menu ships INERT and stays inert without JS, which is correct and is
       not a bug to route around: a control that cannot open should not be
       advertising tabbable links. My first version of this test asserted the
       menu's links were reachable and failed for exactly that reason.

       So the assertion is the one that actually matters to a no-JS visitor:
       the command is readable, and there is a real anchor somewhere on the
       page that reaches the agent pack. The footer's "Set up with your agent"
       is that anchor, and this is what keeps it from being deleted as
       redundant later. */
    const ctx = await browser.newContext({ javaScriptEnabled: false });
    const page = await ctx.newPage();
    await page.goto("/");

    await expect(page.locator("#get-started").getByText(site.command)).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Set up with your agent/ }),
      "a no-JS visitor still has a way to the pack",
    ).toHaveCount(1);
    await ctx.close();
  });
});
