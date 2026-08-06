/**
 * The chart primitives, rendered.
 *
 * Recharts draws nothing without a browser — `renderToStaticMarkup` of a
 * `<LineChart>` is an empty `<div>`, measured. That turns out to be the right
 * shape for this file rather than a limitation of it, because everything this
 * wave is judged on is deliberately outside the `<svg>`: the em dash, the
 * coverage sentence, the two empty states, the legend swatch, the `<details>`
 * table and every ARIA attribute are plain React. A page rendered on the
 * server, a text browser and a screen reader all see exactly what these
 * assertions see.
 *
 * The three states the brief names — zero rows, one row, and a series that is
 * entirely null — are run against every primitive rather than against the one
 * that seemed likely to break, because "renders correctly with zero rows" is
 * the kind of claim that is true of seven components and false of the eighth.
 *
 * The last test in the file is a different kind: it compiles every Tailwind
 * class these components actually write against the real `app/globals.css`.
 * A class name is a string that `tsc` cannot see, the type scale and the
 * radius scale were both deliberately narrowed, and a `text-sm` that no longer
 * exists produces no CSS and no error — the component just renders at the
 * wrong size and looks approximately fine.
 */

import "./charts-loader.mjs";
import { render } from "./ui-render.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { globSync } from "node:fs";

import { compile } from "tailwindcss";

const { TimeSeriesChart } = await import("../components/charts/time-series.tsx");
const { BarChart } = await import("../components/charts/bar-chart.tsx");
const { HistogramChart } = await import("../components/charts/histogram-chart.tsx");
const { Heatmap } = await import("../components/charts/heatmap.tsx");
const { TopList } = await import("../components/charts/top-list.tsx");
const { Sparkline } = await import("../components/charts/sparkline.tsx");
const { QueryValue } = await import("../components/charts/query-value.tsx");

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = join(HERE, "..");
const EM_DASH = "—";

/**
 * The same three inputs for every primitive, expressed in each one's own prop
 * shape. `null` here always means "in scope, no value", never "zero".
 */
const CASES = [
  {
    name: "zero rows",
    timeSeries: { series: [] },
    bar: { categories: [], series: [] },
    histogram: { values: [] },
    heatmap: { cells: [] },
    topList: { rows: [] },
    spark: { values: [] },
    tile: { value: null },
  },
  {
    name: "one row",
    timeSeries: { series: [{ id: "a", label: "A", points: [{ x: 1, y: 7 }] }] },
    bar: { categories: ["sonnet"], series: [{ id: "a", label: "A", values: [7] }] },
    histogram: { values: [7] },
    heatmap: { cells: [{ row: "mon", col: "09", value: 7 }] },
    topList: { rows: [{ id: "a", label: "read_file", value: 7 }] },
    spark: { values: [7] },
    tile: { value: 7 },
  },
  {
    name: "a series that is entirely null",
    timeSeries: {
      series: [{ id: "a", label: "A", points: [{ x: 1, y: null }, { x: 2, y: null }] }],
    },
    bar: {
      categories: ["sonnet", "haiku"],
      series: [{ id: "a", label: "A", values: [null, null] }],
    },
    histogram: { values: [null, null] },
    heatmap: { cells: [{ row: "mon", col: "09", value: null }] },
    topList: { rows: [{ id: "a", label: "read_file", value: null }] },
    spark: { values: [null, null] },
    tile: { value: null },
  },
];

for (const c of CASES) {
  test(`every primitive renders with ${c.name}`, () => {
    const rendered = {
      "line chart": render(TimeSeriesChart, { title: "T", unit: "count", ...c.timeSeries }),
      "area chart": render(TimeSeriesChart, {
        title: "T",
        unit: "count",
        variant: "area",
        ...c.timeSeries,
      }),
      "stacked area chart": render(TimeSeriesChart, {
        title: "T",
        unit: "count",
        variant: "stacked-area",
        ...c.timeSeries,
      }),
      "bar chart": render(BarChart, { title: "T", unit: "count", ...c.bar }),
      histogram: render(HistogramChart, { title: "T", unit: "duration", ...c.histogram }),
      heatmap: render(Heatmap, { title: "T", unit: "count", ...c.heatmap }),
      "top list": render(TopList, { title: "T", unit: "count", valueLabel: "calls", ...c.topList }),
      sparkline: render(Sparkline, { label: "trend", unit: "count", ...c.spark }),
      "query value": render(QueryValue, { label: "Turns", unit: "count", ...c.tile }),
    };
    for (const [name, html] of Object.entries(rendered)) {
      assert.ok(html.length > 0, `${name} rendered nothing`);
      assert.doesNotMatch(html, /undefined|NaN|\[object Object\]/, `${name} leaked a value`);
    }
  });
}

test("no rows and no values are two different messages", () => {
  const none = render(TimeSeriesChart, { title: "Turns", unit: "count", series: [] });
  assert.match(none, /No data in this range\./);

  const silent = render(TimeSeriesChart, {
    title: "Turns",
    unit: "count",
    series: [{ id: "a", label: "A", points: [{ x: 1, y: null }, { x: 2, y: null }] }],
  });
  assert.match(silent, /2 buckets in range, and not one reported a value/);
  assert.match(silent, /This is missing data, not zero\./);
  assert.doesNotMatch(silent, /No data in this range/);
});

test("a chart is always accompanied by its numbers", () => {
  const html = render(TimeSeriesChart, {
    title: "Turns",
    unit: "count",
    xLabel: "time",
    formatX: (x) => `t${x}`,
    series: [{ id: "a", label: "A", points: [{ x: 1, y: 2 }, { x: 2, y: null }] }],
  });
  assert.match(html, /<details/);
  assert.match(html, /Data table \(2 rows\)/);
  assert.match(html, /<caption class="sr-only">Turns: underlying values<\/caption>/);
  // The absent bucket is an em dash in the table, exactly as it is a gap in
  // the line.
  assert.match(html, new RegExp(`<td[^>]*>${EM_DASH}</td>`));
});

test("the summary a screen reader hears is wired to the figure", () => {
  const html = render(TimeSeriesChart, {
    title: "Turns",
    unit: "duration",
    series: [
      {
        id: "a",
        label: "TTFT",
        points: [{ x: 1, y: 400 }],
        coverage: { rows: 41, of: 1203, noun: "turns" },
      },
    ],
  });
  const described = /aria-describedby="([^"]+)"/.exec(html);
  assert.ok(described, "the figure must point at its own summary");
  assert.match(html, new RegExp(`id="${described[1]}"[^>]*>[^<]*Line chart: Turns\\.`));
  assert.match(html, /Partial data\. TTFT covers 41 of 1,203 turns \(3%\)\./);
});

test("partial coverage is on the face of the chart, not only in the summary", () => {
  const html = render(TimeSeriesChart, {
    title: "Turns",
    unit: "duration",
    series: [
      {
        id: "a",
        label: "TTFT",
        points: [{ x: 1, y: 400 }],
        coverage: { rows: 41, of: 1203, noun: "turns" },
      },
    ],
  });
  // Twice: once in the caption a sighted reader sees, once in the summary.
  const occurrences = html.split("TTFT covers 41 of 1,203 turns").length - 1;
  assert.equal(occurrences, 2);
  assert.match(html, /class="text-small text-warn">Partial data\./);
});

test("every mouse interaction has a keyboard equivalent that says so", () => {
  const html = render(TimeSeriesChart, {
    title: "Turns",
    unit: "count",
    series: [{ id: "a", label: "A", points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }],
  });
  assert.match(html, /role="application"/);
  assert.match(html, /aria-roledescription="interactive chart"/);
  assert.match(html, /Arrow keys move the cursor/);
  assert.match(html, /Enter zooms in/);
  assert.match(html, /Escape clears the selection/);
  assert.match(html, /tabindex="0"/);
  // The zoom affordances are buttons, so Tab reaches them with no arrow keys
  // at all, and both start disabled because nothing is selected yet.
  assert.match(html, /<button[^>]*disabled=""[^>]*>Zoom in<\/button>/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Zoom out<\/button>/);
  assert.match(html, /focus-visible:outline-2/);
});

test("the legend distinguishes series without relying on hue", () => {
  const html = render(TimeSeriesChart, {
    title: "Turns",
    unit: "count",
    series: [
      { id: "a", label: "sonnet", points: [{ x: 1, y: 1 }] },
      { id: "b", label: "gpt-5-mini", points: [{ x: 1, y: 2 }] },
    ],
  });
  // Slot 1 is unbroken and slot 2 dashed, and each carries its own marker.
  assert.match(html, /stroke-dasharray="6 3"/);
  assert.match(html, /sonnet/);
  assert.match(html, /gpt-5-mini/);
  const swatches = html.split("<svg width=\"22\"").length - 1;
  assert.equal(swatches, 2, "every series owes a legend entry");
});

test("a filled mark is textured, because a fill cannot carry a dash", () => {
  const html = render(TimeSeriesChart, {
    title: "Cost",
    unit: "cost",
    variant: "stacked-area",
    series: [
      { id: "a", label: "sonnet", points: [{ x: 1, y: 1 }] },
      { id: "b", label: "gpt-5-mini", points: [{ x: 1, y: 2 }] },
    ],
  });
  // Ids are per instance, so a page of charts cannot collide, and every fill
  // has to name a texture this very document defines.
  const patterns = [...html.matchAll(/<pattern id="([^"]+)"/g)].map((m) => m[1]);
  const fills = [...html.matchAll(/fill="url\(#([^)]+)\)"/g)].map((m) => m[1]);
  assert.ok(patterns.length > 0, "a filled mark needs its textures defined");
  assert.equal(new Set(patterns).size, patterns.length, "duplicate SVG ids in one document");
  for (const fill of fills) {
    assert.ok(patterns.includes(fill), `${fill} is referenced but never defined`);
  }
  assert.ok(fills.length >= 2, "each band and each swatch gets its own texture");
  assert.equal(new Set(fills).size, fills.length, "two marks must not share one texture");
});

test("a bar chart names the categories it has no value for", () => {
  const html = render(BarChart, {
    title: "Spend by model",
    unit: "cost",
    xLabel: "model",
    categories: ["sonnet", "acme/experimental-v1", "ollama/qwen3"],
    series: [{ id: "spend", label: "spend", values: [8.14, null, 0] }],
  });
  assert.match(html, /No value reported for acme\/experimental-v1\./);
  assert.match(html, /Those are absences, not zeroes\./);
  // The free local model is a measured zero and must not be in that sentence.
  assert.doesNotMatch(html, /No value reported for[^<]*ollama/);
  assert.match(html, /<td[^>]*>\$0\.00<\/td>/);
});

test("a histogram says how many values it could not bin", () => {
  const html = render(HistogramChart, {
    title: "Turn duration",
    unit: "duration",
    noun: "turns",
    values: [100, 200, null, null, null],
  });
  assert.match(html, /3 of 5 turns reported no value and are not in this histogram\./);
});

test("a heatmap cell with no value is empty, not the coolest colour", () => {
  const html = render(Heatmap, {
    title: "Errors",
    unit: "count",
    rowKeys: ["mon", "tue"],
    colKeys: ["09", "10"],
    cells: [
      { row: "mon", col: "09", value: 4 },
      { row: "mon", col: "10", value: 0 },
    ],
  });
  assert.match(html, /2 of 4 cells have no value and are drawn empty, not as zero\./);
  assert.match(html, /repeating-linear-gradient/);
  assert.match(html, new RegExp(`${EM_DASH} no value reported`));
  // The measured zero is still a number, and it is announced as one.
  assert.match(html, /<span class="sr-only">0<\/span>/);
  assert.match(html, /color-mix\(in oklab, var\(--chart-1\)/);
});

test("a top list offers only the sorts its data supports", () => {
  const withoutErrors = render(TopList, {
    title: "Tools",
    unit: "count",
    valueLabel: "calls",
    rows: [{ id: "a", label: "read_file", value: 3 }],
  });
  assert.doesNotMatch(withoutErrors, /error rate/);

  const withErrors = render(TopList, {
    title: "Tools",
    unit: "count",
    valueLabel: "calls",
    durationLabel: "p95",
    rows: [
      { id: "a", label: "read_file", value: 3, errors: 0, total: 3, durationMs: 12 },
      { id: "b", label: "web_search", value: 5, errors: 1, total: 5, durationMs: null },
    ],
  });
  assert.match(withErrors, /error rate/);
  assert.match(withErrors, /aria-sort="descending"/);
  assert.match(withErrors, /aria-sort="none"/);
  assert.match(withErrors, /<button type="button" class="[^"]*">p95/);
  // The row with no duration reports it as an absence, with words for a
  // reader who cannot see the dash.
  assert.match(withErrors, new RegExp(`${EM_DASH}<span class="sr-only">no value reported`));
});

test("a top list ranks in a stated order and says how many it hid", () => {
  const html = render(TopList, {
    title: "Tools",
    unit: "count",
    valueLabel: "calls",
    limit: 1,
    rows: [
      { id: "a", label: "read_file", value: 3 },
      { id: "b", label: "web_search", value: 9 },
    ],
  });
  assert.match(html, /Showing 1 of 2\./);
  assert.match(html, /1\. web_search/);
  assert.doesNotMatch(html, /read_file/);
  assert.match(html, /sorted by calls, highest first/);
});

test("a sparkline of nothing is an em dash, not an empty box", () => {
  const nothing = render(Sparkline, { label: "cost", unit: "cost", values: [null, null] });
  assert.doesNotMatch(nothing, /<svg/);
  assert.match(nothing, new RegExp(EM_DASH));
  assert.match(nothing, /cost: no values in 2 buckets\./);

  const gapped = render(Sparkline, { label: "cost", unit: "cost", values: [1, 2, null, 4, 5] });
  assert.equal(gapped.split("<path").length - 1, 2, "a gap is two paths, not one line across");
  assert.match(gapped, /role="img"/);
  assert.match(gapped, /1 of 5 buckets reported no value and are drawn as gaps\./);

  // A value stranded between two gaps still has to appear, and a path of one
  // point draws nothing at all, so it becomes a dot.
  const stranded = render(Sparkline, { label: "cost", unit: "cost", values: [null, 4, null] });
  assert.equal(stranded.split("<path").length - 1, 0);
  assert.equal(stranded.split("<circle").length - 1, 1);
});

test("an unpriced model never renders as free", () => {
  const unpriced = render(QueryValue, {
    label: "Spend",
    unit: "cost",
    value: 0,
    priced: false,
    previous: 3,
  });
  assert.doesNotMatch(unpriced, /\$0\.00/);
  assert.match(unpriced, /unpriced/);
  // No ratio either: a delta against an unknown is an unknown.
  assert.match(unpriced, /no comparison: the previous period has no value/);

  const free = render(QueryValue, { label: "Spend", unit: "cost", value: 0, priced: true });
  assert.match(free, /\$0\.00/);
  assert.doesNotMatch(free, /unpriced/);
});

test("a delta is readable without colour", () => {
  const html = render(QueryValue, {
    label: "Spend",
    unit: "cost",
    value: 11.2,
    previous: 10,
    previousLabel: "the previous 7 days",
    better: "lower",
  });
  assert.match(html, /▲/, "a shape, not only a colour");
  assert.match(html, /\+12%/, "a number");
  assert.match(html, /up 12% from the previous 7 days/, "a sentence");
  assert.match(html, /text-err/, "and then the colour");
});

test("a tile over partial data says so on the tile", () => {
  const html = render(QueryValue, {
    label: "TTFT p50",
    unit: "duration",
    value: 410,
    coverage: { rows: 41, of: 1203, noun: "turns" },
  });
  assert.match(html, /Partial data: covers 41 of 1,203 turns \(3%\)\./);
});

/* ── the class names, compiled ──────────────────────────────────────────── */

/**
 * Pull every `className` value out of a source file. Static strings only —
 * an interpolated fragment is not a class name Tailwind could have generated
 * at build time either, so skipping it matches what the compiler does.
 */
function classNames(source) {
  const found = [];
  let at = source.indexOf("className=");
  while (at !== -1) {
    const start = at + "className=".length;
    if (source[start] === '"') {
      const end = source.indexOf('"', start + 1);
      found.push(source.slice(start + 1, end));
    } else if (source[start] === "{") {
      let depth = 0;
      let i = start;
      for (; i < source.length; i++) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}" && --depth === 0) break;
      }
      const expression = source.slice(start, i);
      // Both quoted literals and the static parts of template literals.
      for (const [, literal] of expression.matchAll(/"([^"]*)"/g)) found.push(literal);
      for (const [, template] of expression.matchAll(/`([^`]*)`/g)) {
        found.push(template.replaceAll(/\$\{[^}]*\}/g, " "));
      }
    }
    at = source.indexOf("className=", start);
  }
  return found.flatMap((value) => value.split(/\s+/)).filter((c) => c.length > 0);
}

/**
 * The selector Tailwind emits for a candidate. Everything outside
 * `[A-Za-z0-9_-]` is backslash-escaped, so `p-0.5` becomes `.p-0\.5` and
 * `hover:bg-bg-hover` becomes `.hover\:bg-bg-hover`.
 *
 * The trailing guard matters more than it looks: a plain substring search for
 * `.text-sm` finds `.text-small`, which is exactly the pair this project can
 * get wrong — the numeric scale was deleted and replaced by named steps, so
 * `text-sm` is the mistake a reviewer would make and `text-small` is its
 * prefix-sharing correct form.
 */
function selectorFor(candidate) {
  const escaped = candidate.replaceAll(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
  const literal = escaped.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\.${literal}(?![\\w\\-\\\\])`);
}

test("every Tailwind class these components write actually compiles", async () => {
  const require = createRequire(import.meta.url);
  const app = join(PACKAGE, "app");
  const stylesheet = await readFile(join(app, "globals.css"), "utf8");
  const compiler = await compile(stylesheet, {
    base: app,
    async loadStylesheet(id, base) {
      const path = require.resolve(id);
      return { path, base, content: await readFile(path, "utf8") };
    },
  });

  const candidates = new Set();
  const files = globSync(join(PACKAGE, "components/charts/**/*.tsx"));
  assert.ok(files.length >= 8, `expected the primitives, found ${files.length} files`);
  for (const file of files) {
    for (const candidate of classNames(await readFile(file, "utf8"))) candidates.add(candidate);
  }
  assert.ok(candidates.size > 40, `expected a real class list, found ${candidates.size}`);

  // One build for the whole list. `compiler.build` is incremental — it returns
  // everything asked for so far — so a per-candidate call cannot be compared
  // against a baseline, which is how an earlier version of this test passed
  // while `rounded-xs` was producing nothing at all.
  const css = compiler.build([...candidates]);
  const inert = [...candidates].filter((c) => !selectorFor(c).test(css));
  assert.deepEqual(
    inert,
    [],
    "these class names produce no CSS — a typo, or a token removed from the narrowed scale",
  );
});
