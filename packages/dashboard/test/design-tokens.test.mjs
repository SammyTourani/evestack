/**
 * app/globals.css — the design tokens, compiled rather than eyeballed.
 *
 * Tailwind arrived in a commit whose entire job was to change nothing visible,
 * so almost every claim it makes is a claim about CSS that no page uses yet.
 * `tsc` cannot see any of it: a token is a string in a stylesheet, a deleted
 * one is not an error, and a utility built on a token that no longer exists
 * simply stops being generated. The page then renders without it and looks
 * approximately fine, which is the worst possible failure — the same shape as
 * an unpriced model rendering $0.00.
 *
 * So this file compiles the real `app/globals.css` with the real Tailwind and
 * asserts on the output. Three things are worth the cost:
 *
 *   1. Preflight is absent. It is one `@import` line away, and adding it
 *      silently restyles ten shipped pages — heading sizes, list markers,
 *      paragraph margins, form-control fonts. Whoever adds it should be doing
 *      it deliberately, in the change that restyles those pages, and should
 *      have to delete an assertion that says so.
 *
 *   2. Colour utilities resolve to the raw custom property, not to a copy of
 *      its value. That indirection is what makes the `prefers-color-scheme`
 *      override still work: `bg-bg-raised` has to compile to
 *      `var(--bg-raised)`, which is dark or light depending on the media query
 *      at the bottom of the palette. Drop the `inline` keyword off the `@theme`
 *      block and the utilities point at a second variable instead — still
 *      valid CSS, one more hop, and much harder to reason about.
 *
 *   3. The scales that were deliberately narrowed stayed narrow. `--text-*`
 *      and `--radius-*` are reset before six type steps and two radii are
 *      declared, so an off-scale `text-sm` or `rounded-lg` produces nothing at
 *      all rather than quietly rendering Tailwind's default. That is the whole
 *      point of having a scale, and it is invisible until someone checks.
 *
 * Nothing here opens a socket or reads a database; it is the stylesheet in the
 * working tree, compiled in memory.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { compile } from "tailwindcss";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..", "app");
const require = createRequire(import.meta.url);

const source = await readFile(join(APP, "globals.css"), "utf8");
const layout = await readFile(join(APP, "layout.tsx"), "utf8");

/** Comments in this stylesheet quote its own syntax, so parse without them. */
const bare = source.replace(/\/\*[\s\S]*?\*\//g, "");

/** The text between `marker` and its matching close brace. */
function block(marker) {
  const open = bare.indexOf(marker);
  assert.notEqual(open, -1, `globals.css no longer contains \`${marker}\``);
  let depth = 0;
  for (let i = bare.indexOf("{", open); i < bare.length; i++) {
    if (bare[i] === "{") depth++;
    else if (bare[i] === "}" && --depth === 0) return bare.slice(open, i);
  }
  throw new Error(`unbalanced braces after ${marker}`);
}

const compiler = await compile(source, {
  base: APP,
  async loadStylesheet(id, base) {
    const path = require.resolve(id);
    return { path, base, content: await readFile(path, "utf8") };
  },
});

/** Compile one utility class and return just its declaration block. */
function utility(candidate) {
  const css = compiler.build([candidate]);
  const selector = `.${candidate}`;
  const at = css.indexOf(`${selector} {`);
  if (at === -1) return null;
  return css.slice(at + selector.length + 2, css.indexOf("}", at)).trim();
}

/**
 * A utility built on a `@theme` token compiles to `var(--token)`, and the token
 * itself is emitted into `:root`. Resolve the one hop so an assertion can name
 * the value a browser will actually paint.
 */
function resolved(candidate) {
  const decl = utility(candidate);
  if (decl === null) return null;
  return decl.replace(/var\((--[\w-]+)\)/g, (whole, name) => {
    const emitted = compiler.build([candidate]).match(new RegExp(`\\${name}:\\s*([^;]+);`));
    return emitted ? emitted[1].trim() : whole;
  });
}

/** The 14 variables the pre-Tailwind stylesheet defined, and still defines. */
const PALETTE = [
  "bg",
  "bg-raised",
  "bg-hover",
  "border",
  "text",
  "text-dim",
  "text-faint",
  "accent",
  "ok",
  "warn",
  "err",
];
const NON_COLOUR = ["radius", "mono", "sans"];

test("Tailwind is wired up at all: a stock utility compiles", () => {
  // Also the reason no spacing scale is declared — Tailwind's own `--spacing`
  // is already the 4pt grid, so redeclaring it would be a token that changes
  // nothing.
  assert.equal(utility("p-4"), "padding: calc(var(--spacing) * 4);");
});

/*
 * THIS TEST WAS INVERTED, and the inversion is the point of the change it
 * belongs to.
 *
 * It used to assert "preflight is not imported, so no shipped page is restyled".
 * That was correct while it stood: W3 took Tailwind's theme and utilities and
 * deliberately not its base layer, so that introducing Tailwind changed no
 * existing page and a port error stayed distinguishable from an intended
 * redesign. The note in globals.css said the line "belongs to the wave that
 * restyles the pages". This is that wave, so the guard now points the other way.
 *
 * What it still guards is the ORDER, which is the part that makes preflight safe
 * here. `base` before `app` means every element rule the hand-rolled stylesheet
 * writes — body, a, table, th, td, h1 — beats preflight's reset for that
 * element, and preflight only reaches what `app` never had an opinion about.
 * Import preflight into the wrong layer, or drop `app` from the order, and ten
 * pages change appearance at once with nothing to say so.
 */
test("preflight is imported, into base, and base still sits before app", () => {
  const css = compiler.build(["p-4"]);
  /*
   * These three are read out of tailwindcss/preflight.css, not remembered.
   *
   * The old guard listed `-webkit-appearance: button`, and Tailwind 4 writes
   * `appearance: button` — so that sentinel could never match, whichever way the
   * assertion pointed. A guard with a hole is worse than no guard: it reports a
   * pass for a string that was never going to be there.
   */
  for (const sentinel of [
    "-webkit-text-size-adjust: 100%", // preflight's html rule
    "appearance: button", // preflight's button reset
    "-webkit-tap-highlight-color: transparent", // preflight's html rule, again
    //
    // `list-style: none` was a sentinel and is not one. The build this scans
    // includes the hand-authored `@layer app` block, not only what Tailwind
    // emits, so a sentinel has to be something ONLY preflight could write — and
    // that is ordinary CSS anybody may write. The sidebar's `.nav-list` writes
    // it, because a <ul> of links should not render bullets.
  ]) {
    assert.ok(css.includes(sentinel), `compiled CSS is missing ${sentinel}, which preflight emits`);
  }

  assert.ok(
    source.includes('@import "tailwindcss/preflight.css" layer(base);'),
    "globals.css no longer imports preflight into the base layer",
  );

  // Still refused: the all-in-one import pulls preflight in UNLAYERED, and
  // unlayered CSS outranks every layer — which would put the reset above `app`
  // and silently undo the ordering this file is built on.
  assert.ok(
    !/@import\s+["']tailwindcss["']\s*;/.test(source),
    'globals.css imports all of "tailwindcss", which pulls preflight in unlayered',
  );

  const order = source.match(/@layer\s+([^;]+);/);
  assert.ok(order, "the @layer order declaration is gone");
  const layers = order[1].split(",").map((s) => s.trim());
  assert.ok(
    layers.indexOf("base") < layers.indexOf("app"),
    `base must precede app so the hand-rolled element rules win; got ${layers.join(", ")}`,
  );
});

test("every variable the hand-rolled stylesheet defined is still defined", () => {
  const root = block(":root {");
  for (const name of [...PALETTE, ...NON_COLOUR]) {
    assert.ok(root.includes(`--${name}:`), `--${name} is no longer declared on :root`);
  }
  assert.ok(root.includes("color-scheme: dark light"), "the dark-first color-scheme is gone");
});

test("the light override still overrides every colour, and only colours", () => {
  const light = block("@media (prefers-color-scheme: light)");
  for (const name of PALETTE) {
    assert.ok(light.includes(`--${name}:`), `--${name} has no light value`);
  }
  // --radius / --mono / --sans are mode-independent; a light value for one of
  // them would mean two sources of truth for the same number.
  for (const name of NON_COLOUR) {
    assert.ok(!light.includes(`--${name}:`), `--${name} should not vary by colour scheme`);
  }
});

test("colour utilities point at the raw variable, so the media query still switches them", () => {
  for (const name of PALETTE) {
    assert.equal(
      utility(`bg-${name}`),
      `background-color: var(--${name});`,
      `bg-${name} does not resolve to var(--${name})`,
    );
  }
  // Focus is published as its own role rather than as `accent`.
  assert.equal(utility("outline-focus"), "outline-color: var(--accent);");
});

test("the chart palette is six slots, each var-backed in both colour schemes", () => {
  for (let i = 1; i <= 6; i++) {
    assert.equal(utility(`stroke-chart-${i}`), `stroke: var(--chart-${i});`);
  }
  assert.equal(utility("stroke-chart-7"), null, "a seventh slot exists; the palette validated six");

  const dark = block(":root {");
  const light = block("@media (prefers-color-scheme: light)");
  for (let i = 1; i <= 6; i++) {
    assert.ok(dark.includes(`--chart-${i}:`), `--chart-${i} has no dark value`);
    assert.ok(light.includes(`--chart-${i}:`), `--chart-${i} has no light value`);
  }
});

test("the type scale is six steps and the default numeric scale is gone", () => {
  assert.equal(resolved("text-micro"), "font-size: 11px;");
  assert.equal(resolved("text-small"), "font-size: 12px;");
  assert.equal(resolved("text-body"), "font-size: 14px;");
  assert.equal(resolved("text-section"), "font-size: 17px;");
  assert.equal(resolved("text-title"), "font-size: 19px;");
  assert.equal(resolved("text-metric"), "font-size: 22px;");
  for (const off of ["text-xs", "text-sm", "text-base", "text-lg", "text-xl"]) {
    assert.equal(utility(off), null, `${off} still resolves to a Tailwind default font size`);
  }
});

test("two radii, matching the two the product draws", () => {
  assert.equal(resolved("rounded-sm"), "border-radius: 5px;");
  // `rounded-md` deliberately points back at --radius rather than repeating
  // 8px, so the card radius has exactly one definition.
  assert.equal(utility("rounded-md"), "border-radius: var(--radius);");
  assert.match(block(":root {"), /--radius:\s*8px;/);
  for (const off of ["rounded-xs", "rounded-lg", "rounded-xl"]) {
    assert.equal(utility(off), null, `${off} still resolves to a Tailwind default radius`);
  }
  // Pills keep using the built-in, which is a static utility rather than a token.
  assert.notEqual(utility("rounded-full"), null);
});

test("font-sans asks for Geist first, and the layout is what supplies it", () => {
  assert.match(utility("font-sans"), /^font-family: var\(--font-geist-sans\), /);
  assert.match(utility("font-mono"), /^font-family: var\(--font-geist-mono\), /);
  // The token is only meaningful because <html> carries the classes that
  // declare those two variables. Without them the whole declaration is invalid
  // at computed-value time and `font-sans` silently does nothing.
  assert.match(layout, /GeistSans\.variable/);
  assert.match(layout, /GeistMono\.variable/);
  assert.match(layout, /<html[^>]*className=/);
});

/**
 * "Nothing happened" and "I cannot see" must not render the same.
 *
 * Caught live: Postgres went down while five real turns sat on disk, and the
 * overview drew six em dashes. An em dash means "no value here", so the front
 * door reported that the agent had done nothing — the opposite of the truth, on
 * the one screen someone opens to find out whether anything is wrong.
 *
 * `Promise.allSettled` is what made it silent. It is the right tool for keeping
 * one dead tile from taking the page down, and the wrong tool for deciding what
 * a dead tile MEANS, so `Headline` now carries the reason alongside the value.
 */
test("a headline distinguishes an empty window from a failed query", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));

  const overview = readFileSync(join(here, "..", "app", "overview.ts"), "utf8");
  const page = readFileSync(join(here, "..", "app", "page.tsx"), "utf8");

  assert.match(overview, /readonly failed: boolean/, "Headline must carry why the value is absent");
  assert.match(
    overview,
    /const failed = current\.status === "rejected"/,
    "only a failed CURRENT window counts as blind; a missing previous one is ordinary",
  );
  assert.match(
    page,
    /blind\.every\(\(h\) => h\.failed\)/,
    "the page must surface an error when every measure failed, not six em dashes",
  );
});
