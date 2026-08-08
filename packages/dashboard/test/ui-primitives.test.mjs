/**
 * Every primitive in components/ui, rendered.
 *
 * The claims here are the ones a reviewer would otherwise have to take on
 * trust: that each component survives an empty list, a single item and an
 * error; that the accessibility attributes the components were built around are
 * actually emitted; and that the three "never let a number lie" rules hold in
 * the markup rather than only in the formatter they call.
 *
 * `test/ui-render.mjs` explains what this can and cannot see. In short: the
 * server pass, which is every branch decided during render. A Radix popover's
 * open panel and a focus ring are not reachable from here, so the assertions
 * about those are about the props and composition that produce them.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { contains, h, omits, render } from "./ui-render.mjs";

const UI = new URL("../components/ui/", import.meta.url).href;

const { Badge, OutcomeBadge } = await import(`${UI}badge.tsx`);
const { Card } = await import(`${UI}card.tsx`);
const { CoverageNote, Placeholder } = await import(`${UI}feedback.tsx`);
const { Popover } = await import(`${UI}popover.tsx`);
const { StatTile } = await import(`${UI}stat.tsx`);
const { DataTable } = await import(`${UI}table.tsx`);

const COLUMNS = [
  { accessorKey: "id", header: "Session" },
  { accessorKey: "outcome", header: "Outcome" },
];

/* -------------------------------------------------------------------------- */
/* the three rules, in rendered markup                                        */
/* -------------------------------------------------------------------------- */

test("a cost tile over an unpriced window never renders a dollar amount", () => {
  const markup = render(StatTile, {
    label: "Model spend",
    value: 0,
    unit: "cost",
    priced: false,
    previous: 4.2,
  });
  contains(markup, "Unpriced");
  omits(markup, "$", "an unpriced tile printed a currency amount");
  // And no delta either: `Unpriced ▼ −100.0%` is a confident number about an
  // amount the line above just said is unknown.
  omits(markup, "%", "an unpriced tile printed a period-over-period change");
});

test("a priced zero still says $0.00, because that one is true", () => {
  // ollama/* is priced at zero deliberately — local inference costs no API
  // money — and suppressing it would be its own lie.
  contains(render(StatTile, { label: "Spend", value: 0, unit: "cost" }), "$0.00");
});

test("an absent measure renders an em dash, and a measured zero does not", () => {
  contains(render(StatTile, { label: "p95 TTFT", value: null, unit: "duration" }), "—");
  contains(render(StatTile, { label: "Failures", value: 0, unit: "count" }), ">0<");
});

test("a partial metric says so on the tile itself", () => {
  const markup = render(StatTile, {
    label: "p95 TTFT",
    value: 812,
    unit: "duration",
    coverage: { rows: 370, of: 1922 },
    coverageNoun: "turns",
  });
  contains(markup, "812ms");
  contains(markup, "Partial — 370 of 1,922 turns");
});

test("a full metric adds no note at all", () => {
  const markup = render(StatTile, {
    label: "Turns",
    value: 1922,
    unit: "count",
    coverage: { rows: 1922, of: 1922 },
  });
  omits(markup, "Partial");
  omits(markup, "No data");
});

test("a delta from nothing is drawn as nothing", () => {
  // 0 → 5 is not "+100%" and not "+∞%".
  omits(render(StatTile, { label: "Runs", value: 5, unit: "count", previous: 0 }), "%");
});

test("a delta states its direction in words as well as an arrow", () => {
  const markup = render(StatTile, {
    label: "p95",
    value: 200,
    unit: "duration",
    previous: 100,
    betterWhen: "down",
  });
  contains(markup, "+100.0%");
  contains(markup, "▲");
  contains(markup, "up versus the previous period");
  // Latency doubling is bad, so the delta is the error colour.
  contains(markup, "text-err");
});

/* -------------------------------------------------------------------------- */
/* empty, one item, error                                                     */
/* -------------------------------------------------------------------------- */

test("the table renders empty, with one row, and in an error state", () => {
  const empty = render(DataTable, {
    data: [],
    columns: COLUMNS,
    caption: "Sessions",
    emptyTitle: "No sessions yet",
  });
  contains(empty, "No sessions yet");
  contains(empty, '<caption class="sr-only">Sessions</caption>');
  contains(empty, 'aria-rowcount="1"');

  const one = render(DataTable, {
    data: [{ id: "wrun_1", outcome: "ok" }],
    columns: COLUMNS,
    caption: "Sessions",
  });
  contains(one, "wrun_1");
  contains(one, 'aria-rowcount="2"');
  contains(one, 'aria-rowindex="2"');

  const failed = render(DataTable, {
    data: [],
    columns: COLUMNS,
    caption: "Sessions",
    error: "Postgres refused the connection.",
  });
  contains(failed, 'role="alert"');
  contains(failed, "Postgres refused the connection.");
  // The error replaces the table rather than sitting above an empty one, which
  // would read as "loaded fine, no rows".
  omits(failed, "<table");
});

test("a null cell renders an em dash without every column remembering to", () => {
  const markup = render(DataTable, {
    data: [{ id: "wrun_1", outcome: null }],
    columns: COLUMNS,
    caption: "Sessions",
  });
  // The column definition says nothing about nulls; the table's default cell
  // does. `fact_turn.environment` is NULL on most rows, and an empty cell is
  // indistinguishable from a blank value.
  contains(markup, ">—</td>");
});

test("a measured zero and a measured false are still printed", () => {
  const markup = render(DataTable, {
    data: [{ id: "wrun_1", outcome: 0 }],
    columns: COLUMNS,
    caption: "Sessions",
  });
  contains(markup, ">0</td>");
  omits(markup, ">—</td>", "a zero was mistaken for an absent value");
});

test("every sortable header is a button inside a th that reports its state", () => {
  const markup = render(DataTable, {
    data: [{ id: "a", outcome: "ok" }],
    columns: COLUMNS,
    caption: "Sessions",
    initialSorting: [{ id: "id", desc: true }],
  });
  contains(markup, 'aria-sort="descending"');
  contains(markup, 'aria-sort="none"');
  contains(markup, 'scope="col"');
  // Not a click handler on the th, which no keyboard reaches.
  contains(markup, '<th scope="col" aria-sort="descending"');
  assert.equal((markup.match(/<button type="button"/g) ?? []).length >= 2, true);
});

test("the row count is announced, and it names both numbers", () => {
  const markup = render(DataTable, {
    data: [{ id: "a", outcome: "ok" }, { id: "b", outcome: "failed" }],
    columns: COLUMNS,
    caption: "Sessions",
  });
  contains(markup, 'aria-live="polite"');
  contains(markup, "2 of 2 rows shown");
});

test("a faceted column gets a chip; a column that is not faceted does not", () => {
  const markup = render(DataTable, {
    data: [{ id: "a", outcome: "ok" }],
    columns: COLUMNS,
    caption: "Sessions",
    facetColumns: ["outcome"],
  });
  // The chip is a popover trigger, closed on the server.
  contains(markup, 'aria-haspopup="dialog"');
  contains(markup, ">Outcome<");
  const bare = render(DataTable, { data: [], columns: COLUMNS, caption: "Sessions" });
  omits(bare, 'aria-haspopup="dialog"');
});

test("beyond the virtualization threshold the table still states the real total", () => {
  const many = Array.from({ length: 400 }, (_, i) => ({ id: `s${i}`, outcome: "ok" }));
  const markup = render(DataTable, {
    data: many,
    columns: COLUMNS,
    caption: "Sessions",
    virtualizeAfter: 150,
  });
  // 400 rows plus the header. The DOM will hold ~30 of them; a screen reader
  // that inferred the count from the DOM would be wrong by an order of
  // magnitude, which is what aria-rowcount is for.
  contains(markup, 'aria-rowcount="401"');
  contains(markup, "400 of 400 rows shown");
});

test("the card renders with and without a header, at the heading level asked for", () => {
  contains(render(Card, { title: "Spend", children: "x" }), "<h2");
  contains(render(Card, { title: "Steps", headingLevel: 3, children: "x" }), "<h3");
  const bare = render(Card, { children: "x" });
  omits(bare, "<header");
  omits(bare, "<h2");
});

test("the placeholder announces only the error tone", () => {
  contains(render(Placeholder, { tone: "error", title: "Broken" }), 'role="alert"');
  omits(render(Placeholder, { title: "Nothing yet" }), 'role="alert"');
});

test("the coverage note is silent when there is nothing to warn about", () => {
  assert.equal(render(CoverageNote, { coverage: { rows: 10, of: 10 } }), "");
  assert.equal(render(CoverageNote, { coverage: { rows: 0, of: 0 } }), "");
  contains(render(CoverageNote, { coverage: { rows: 0, of: 40 }, noun: "turns" }), "No data — 0 of 40 turns");
});

/*
 * Popover only. This used to cover Dialog, Menu and Tooltip in the same test;
 * those three were deleted along with command-palette, environment-picker and
 * time-range-picker, because nothing in the app ever rendered them and the
 * redesign did not reach for them either. Popover is the one of the five that a
 * page actually uses.
 */
test("the popover renders its trigger and nothing else while closed", () => {
  const popover = render(Popover, {
    label: "Filter by model",
    trigger: h("button", { type: "button" }, "Model"),
    children: "panel",
  });
  contains(popover, 'aria-expanded="false"');
  omits(popover, "panel");
});

test("no control is left wearing the operating system's chrome", () => {
  // WHAT THIS ASSERTED BEFORE, AND WHY IT CHANGED. It was written when
  // globals.css took Tailwind's theme and utilities and skipped its base layer,
  // so a `<button>` carrying only layout utilities computed — measured in Chrome
  // on this app — background rgb(239,239,239), border 2px outset, font-family
  // Arial. `style.ts` hand-rolled the reset, and this matched
  // /font-family:inherit/ on every control.
  //
  // globals.css imports preflight now. Read off tailwindcss@4.3.3/preflight.css
  // rather than assumed, `font: inherit` at line 249 and `background-color:
  // transparent` at 255 cover form controls, and `padding: 0; border: 0 solid`
  // at 13-15 cover everything — so the utilities this used to require became
  // duplicates and were deleted.
  //
  // The intervening version of this comment argued they should stay anyway, so
  // the reset "travels with the component" into an email or an embed that never
  // loaded globals.css. That argument does not survive being looked at:
  // `font-family: inherit` in a foreign document inherits THAT document's font,
  // so it produces the host's typeface, not the product's. It bought nothing.
  //
  // What preflight does NOT do is the thing now asserted. Line 377-380 ADDS
  // `appearance: button` to `button` and to submit/reset/button inputs, to make
  // the border radius stylable in iOS Safari — so without `appearance-none`
  // those render as platform controls, and preflight is the reason rather than
  // the cure. This is a stronger test than the one it replaces: it guards a
  // hazard that exists, instead of a duplicate that did not.
  //
  // Checkboxes and radios are excluded on purpose — those should look native.
  const markup = render(DataTable, {
    data: [{ id: "a", outcome: "ok" }],
    columns: COLUMNS,
    caption: "Sessions",
    facetColumns: ["outcome"],
    searchPlaceholder: "Search",
  });
  const controls = (markup.match(/<(?:button|input)\b[^>]*>/g) ?? []).filter(
    (tag) => !/type="(?:checkbox|radio)"/.test(tag),
  );
  assert.ok(controls.length >= 3, `expected several controls, found ${controls.length}`);

  // The ones preflight hands a platform appearance to.
  const buttonish = controls.filter(
    (tag) => /^<button\b/.test(tag) || /type="(?:button|submit|reset)"/.test(tag),
  );
  assert.ok(buttonish.length >= 2, `expected buttons, found ${buttonish.length}`);
  for (const tag of buttonish) {
    assert.match(tag, /appearance-none/, tag);
  }

  // And every control, button or field, still has to say where the keyboard is.
  // That fails silently when it drifts, which is why it is pinned here and not
  // left to a visual pass.
  for (const tag of controls) {
    assert.match(tag, /focus-visible:outline-2/, tag);
  }
});

test("a badge is never colour alone — the state is its text", () => {
  for (const outcome of [
    "ok",
    "failed",
    "no_model_call",
    "cancelled",
    "budget_stopped",
    "wedged",
    "running",
  ]) {
    const markup = render(OutcomeBadge, { outcome });
    // Every arm of the map produces a label and an explanation, so a value
    // added to sql/facts.sql's CHECK and not to the map is caught here.
    assert.match(markup, />[a-z][a-z ]+<\/span>$/, outcome);
    contains(markup, "title=", outcome);
  }
  contains(render(Badge, { tone: "warn" }, "unpriced"), "text-warn");
});

/**
 * The outcome vocabulary lives in two places that cannot see each other: a
 * CHECK constraint in `sql/facts.sql` and a TypeScript union in
 * `components/ui/badge.tsx`. `tsc` reads one of them.
 *
 * If the SQL gains a state the badge does not know, `OUTCOME[outcome]` is
 * `undefined` and the row renders a blank pill — the same silent failure the
 * badge's own header says it exists to prevent, one level up. If the badge
 * gains one the SQL rejects, the refresh fails at 3am instead.
 *
 * Wave 2 shipped two incompatible unit vocabularies at exactly this kind of
 * seam, because two agents each declared their own copy and nothing compared
 * them. This is that comparison, for the vocabulary Wave 3 is about to build
 * two pages on.
 */
test("the badge knows exactly the outcomes the database can store", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");

  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(join(here, "..", "sql", "facts.sql"), "utf8");

  const match = sql.match(/outcome IN \(([^)]*)\)/);
  assert.ok(match, "could not find the outcome CHECK constraint in sql/facts.sql");
  const fromSql = [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();

  // Read from source rather than imported: the test loader does not handle
  // .tsx, and parsing the file that ships is the stronger check anyway.
  const badge = readFileSync(join(here, "..", "components", "ui", "badge.tsx"), "utf8");
  const list = badge.match(/export const OUTCOMES = \[([^\]]*)\]/);
  assert.ok(list, "could not find the OUTCOMES array in components/ui/badge.tsx");
  const fromBadge = [...list[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();

  assert.deepEqual(
    fromBadge,
    fromSql,
    `badge.tsx and facts.sql disagree.\n  badge: ${fromBadge.join(", ")}\n  sql:   ${fromSql.join(", ")}`,
  );
});

/**
 * One coverage shape, for the same reason there is one `Unit`.
 *
 * `lib/metrics.ts` stamps `{rows, of}` on every measure it returns.
 * `components/ui/format.ts` consumes that. `components/charts/lib/series.ts`
 * declared `{observed, total}` for the identical two numbers, so a coverage
 * object straight from the query API could not be handed to a chart without
 * being rewritten field by field at the call site — which is how the overview
 * page first tried to build it, and why this test exists.
 *
 * That is the THIRD time the two halves of Wave 2 named one concept twice,
 * after the unit vocabulary and the control styles. This pins the last one.
 */
test("charts and the query API describe coverage with the same field names", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));

  const fields = (file, iface) => {
    const src = readFileSync(join(here, "..", file), "utf8");
    const m = src.match(new RegExp(`interface ${iface} \\{([\\s\\S]*?)\\n\\}`));
    assert.ok(m, `could not find ${iface} in ${file}`);
    return [...m[1].matchAll(/readonly (\w+):/g)].map((x) => x[1]).sort();
  };

  const api = fields("lib/metrics.ts", "MeasureCoverage");
  const ui = fields("components/ui/format.ts", "Coverage");
  const charts = fields("components/charts/lib/series.ts", "Coverage");

  assert.deepEqual(ui, api, "components/ui and lib/metrics disagree");
  // Charts additionally carry `noun`, which is a sentence choice rather than
  // part of the measurement. Everything else must match.
  assert.deepEqual(
    charts.filter((f) => f !== "noun"),
    api,
    `components/charts and lib/metrics disagree.\n  charts: ${charts.join(", ")}\n  api:    ${api.join(", ")}`,
  );
});
