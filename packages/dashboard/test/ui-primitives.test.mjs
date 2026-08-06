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
const { CommandPalette } = await import(`${UI}command-palette.tsx`);
const { Dialog } = await import(`${UI}dialog.tsx`);
const { EnvironmentPicker } = await import(`${UI}environment-picker.tsx`);
const { CoverageNote, Placeholder } = await import(`${UI}feedback.tsx`);
const { Menu, MenuItem, MenuSeparator } = await import(`${UI}menu.tsx`);
const { Popover } = await import(`${UI}popover.tsx`);
const { StatTile } = await import(`${UI}stat.tsx`);
const { DataTable } = await import(`${UI}table.tsx`);
const { Tabs } = await import(`${UI}tabs.tsx`);
const { TimeRangePicker } = await import(`${UI}time-range-picker.tsx`);
const { Tooltip } = await import(`${UI}tooltip.tsx`);

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

test("tabs render nothing when empty and a real tablist otherwise", () => {
  assert.equal(render(Tabs, { items: [], label: "Panes" }), "");
  const markup = render(Tabs, {
    label: "Panes",
    items: [
      { value: "tree", label: "Tree", content: "the tree" },
      { value: "facts", label: "Facts", content: "the facts" },
    ],
  });
  contains(markup, 'role="tablist"');
  contains(markup, 'aria-label="Panes"');
  contains(markup, 'role="tab"');
  contains(markup, 'aria-selected="true"');
  // The active tab is marked by an underline as well as a colour.
  contains(markup, "data-[state=active]:border-accent");
});

test("the environment picker offers the null bucket as its own choice", () => {
  const markup = render(EnvironmentPicker, {
    environments: ["development", null],
    value: undefined,
    onChange: () => {},
  });
  contains(markup, "Environment: All environments");
  const open = render(EnvironmentPicker, {
    environments: [],
    value: null,
    onChange: () => {},
  });
  // With nothing selected the trigger still names the state rather than going
  // blank, and the em dash is the same glyph an absent cell uses.
  contains(open, "Environment: —");
});

test("the time range picker names the window it is showing", () => {
  contains(
    render(TimeRangePicker, {
      value: { kind: "preset", id: "7d" },
      onChange: () => {},
      now: Date.parse("2026-08-06T12:00:00Z"),
    }),
    "Time range: Last 7 days",
  );
  contains(
    render(TimeRangePicker, {
      value: { kind: "absolute", fromMs: Date.parse("2026-08-01T00:00:00Z"), toMs: Date.parse("2026-08-06T12:00:00Z") },
      onChange: () => {},
    }),
    "Aug 1 00:00 UTC → Aug 6 12:00 UTC",
  );
});

test("the command palette exposes its shortcut on the trigger", () => {
  const markup = render(CommandPalette, {
    groups: [
      { heading: "Pages", items: [{ id: "sessions", label: "Sessions", onSelect: () => {} }] },
    ],
  });
  contains(markup, 'aria-keyshortcuts="Meta+K Control+K"');
  contains(markup, "⌘K");
  // Closed on the server: the dialog is not in the markup, only the trigger.
  omits(markup, "Command palette");
  // And it survives having no groups at all.
  contains(render(CommandPalette, { groups: [] }), "Search…");
});

test("overlays render their trigger and nothing else while closed", () => {
  const popover = render(Popover, {
    label: "Filter by model",
    trigger: h("button", { type: "button" }, "Model"),
    children: "panel",
  });
  contains(popover, 'aria-expanded="false"');
  omits(popover, "panel");

  const dialog = render(Dialog, {
    title: "Cancel this session?",
    description: "The agent stops mid-turn. Its sandbox keeps running.",
    trigger: h("button", { type: "button" }, "Cancel"),
  });
  contains(dialog, ">Cancel<");
  omits(dialog, "mid-turn");

  const menu = render(
    Menu,
    { label: "Session actions", trigger: h("button", { type: "button" }, "Actions") },
    h(MenuItem, { key: "fork" }, "Fork"),
    h(MenuSeparator, { key: "sep" }),
    h(MenuItem, { key: "cancel", tone: "danger" }, "Cancel"),
  );
  contains(menu, 'aria-haspopup="menu"');
  omits(menu, "Fork");

  const tooltip = render(Tooltip, { content: "Tools the model was offered, not tools it called." }, h("button", { type: "button" }, "?"));
  contains(tooltip, 'data-state="closed"');
});

test("no control is left wearing the operating system's chrome", () => {
  // `app/globals.css` takes Tailwind's theme and utilities and skips preflight,
  // so a `<button>` with only layout utilities on it computes, measured in
  // Chrome on this app: background rgb(239,239,239), border 2px outset,
  // font-family Arial, text-align center. A grey OS button in a dark table
  // header, and nothing in the component says so. Every button and text input
  // this directory renders therefore carries the reset from `style.ts`.
  //
  // Checkboxes and radios are excluded on purpose — those should look native.
  const markups = [
    render(DataTable, {
      data: [{ id: "a", outcome: "ok" }],
      columns: COLUMNS,
      caption: "Sessions",
      facetColumns: ["outcome"],
      searchPlaceholder: "Search",
    }),
    render(TimeRangePicker, { value: { kind: "preset", id: "24h" }, onChange: () => {} }),
    render(EnvironmentPicker, { environments: ["development"], value: undefined, onChange: () => {} }),
    render(CommandPalette, { groups: [] }),
  ];
  const controls = markups
    .flatMap((markup) => markup.match(/<(?:button|input)\b[^>]*>/g) ?? [])
    .filter((tag) => !/type="(?:checkbox|radio)"/.test(tag));
  assert.ok(controls.length >= 6, `expected several controls, found ${controls.length}`);
  for (const tag of controls) {
    assert.match(tag, /font-family:inherit/, tag);
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
