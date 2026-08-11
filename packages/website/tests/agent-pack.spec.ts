import { test, expect } from "@playwright/test";
import { agentPack, quickstart } from "@/lib/copy";

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
    await expect(menu).toHaveCount(0);
    await expect(caret).toHaveAttribute("aria-expanded", "false");
  });

  test("the hero menu stays inside the viewport", async ({ page }) => {
    /* The hero menu opens inside a position:sticky viewport on a 220vh
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

test.describe("§09 — the fork", () => {
  test("offers both paths, with every command copyable", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/");

    const section = page.locator("#quickstart");
    await expect(section.getByRole("heading", { name: quickstart.heading })).toBeAttached();
    await expect(section.getByText(quickstart.commands.title)).toBeAttached();
    await expect(section.getByText(quickstart.agent.title)).toBeAttached();

    // All five commands, and each row copies its own line without the `$`.
    const rows = section.getByRole("button", { name: /^Copy "/ });
    await expect(rows).toHaveCount(quickstart.commands.rows.length);

    const first = quickstart.commands.rows[0];
    await rows.first().click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(first.pre + first.cmd);
  });

  test("the pack label states the real pack, not a typed-in number", async ({ page, request }) => {
    /* The size and reference count on the card are read off the artifact at
       build time. A hardcoded pair would be wrong the first time anyone edits
       a reference file, and this page's contract is that its numbers are
       reproducible — so the test reproduces them from the served routes. */
    const served = await (await request.get("/agent.md")).text();
    const pack = (await (await request.get("/agent-pack.json")).json()) as {
      files: { path: string }[];
    };
    const references = pack.files.filter((f) => f.path.startsWith("references/")).length;
    const kilobytes = Math.round(Buffer.byteLength(served, "utf8") / 1024);

    await page.goto("/");
    await expect(page.locator("#quickstart")).toContainText(
      `SKILL.md + ${references} references · ${kilobytes} KB`,
    );
  });

  test("both cards carry their accent rail and raised surface", async ({ page }) => {
    await page.goto("/");
    const cards = page.locator("#quickstart .path-card");
    await expect(cards).toHaveCount(2);

    // The rails are what give the section its colour; they are set per card
    // through --rail, so a missing custom property renders a grey hairline
    // that looks deliberate and is not.
    const rails = await page.locator("#quickstart .path-card-rail").evaluateAll((els) =>
      els.map((el) => getComputedStyle(el).getPropertyValue("--rail").trim()),
    );
    expect(rails).toHaveLength(2);
    expect(rails.every((value) => value !== "")).toBe(true);

    // Raised, not drawn: the inset highlight + drop shadow pair.
    const shadow = await cards.first().evaluate((el) => getComputedStyle(el).boxShadow);
    expect(shadow).toContain("inset");
  });

  test("the deleted choreography left nothing behind", async ({ page }) => {
    /* The pipeline rail, its spine and the verify receipt panel are gone. Their
       CSS went with them, so a stray data attribute here would be a selector
       with no rule — silently unstyled rather than loudly broken. */
    await page.goto("/");
    for (const attr of ["data-qs-dot", "data-qs-seg", "data-qs-rcpt", "data-qs-row"]) {
      await expect(page.locator(`[${attr}]`), `${attr} should be gone`).toHaveCount(0);
    }
  });

  test("no-JS still shows both paths in full", async ({ browser }) => {
    const ctx = await browser.newContext({ javaScriptEnabled: false });
    const page = await ctx.newPage();
    await page.goto("/");

    const section = page.locator("#quickstart");
    await expect(section.getByText(quickstart.commands.title)).toBeVisible();
    await expect(section.getByText(quickstart.agent.title)).toBeVisible();
    for (const row of quickstart.commands.rows) {
      await expect(section.getByText(row.cmd, { exact: false }).first()).toBeVisible();
    }
    // The pack is still reachable without the clipboard.
    await expect(section.getByRole("link", { name: /Read it first/ })).toBeVisible();
    await ctx.close();
  });
});
