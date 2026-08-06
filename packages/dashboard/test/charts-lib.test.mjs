/**
 * The chart logic that is not React.
 *
 * Everything a chart can lie about is decided in these modules, before any
 * pixel exists: whether an absence becomes a zero, whether a partly-covered
 * series says so, whether a seventh model disappears, whether a keyboard
 * reaches the same states a mouse does. Recharts draws nothing without a
 * browser, so a rendering test cannot check any of it and this file can check
 * all of it.
 *
 * Nothing here opens a socket or reads a database.
 */

import "./charts-loader.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  ABSENT,
  formatBytes,
  formatCost,
  formatDuration,
  formatRatio,
  formatTick,
  formatValue,
} = await import("../components/charts/lib/format.ts");
const { SLOT_COUNT, foldToSlots, otherLabel, slotStyle } = await import(
  "../components/charts/lib/palette.ts"
);
const {
  absentPointNote,
  coverageNote,
  describeCoverage,
  omittedNote,
  prepareChart,
  stackGapNote,
} = await import("../components/charts/lib/series.ts");
const { describeDelta, formatDelta, periodDelta } = await import(
  "../components/charts/lib/delta.ts"
);
const { barFraction, errorRate, rankKeyLabel, rankMax, rankRows } = await import(
  "../components/charts/lib/rank.ts"
);
const { absentNote, histogram } = await import("../components/charts/lib/histogram.ts");
const { absentCellNote, buildHeatmap, heatIntensity, heatLegend } = await import(
  "../components/charts/lib/heatmap.ts"
);
const {
  INITIAL_ZOOM,
  applyView,
  canZoomIn,
  canZoomOut,
  createZoomReducer,
  describeView,
} = await import("../components/charts/lib/zoom.ts");
const { contiguousRuns, sparkGeometry } = await import("../components/charts/lib/spark.ts");
const { chartSummary, chartTable } = await import("../components/charts/lib/a11y.ts");

/* ── format ─────────────────────────────────────────────────────────────── */

test("an absent value is an em dash in every unit, and never a zero", () => {
  for (const unit of ["count", "duration", "cost", "percent", "tokens", "bytes"]) {
    assert.equal(formatValue(null, unit), ABSENT, unit);
    assert.equal(formatTick(null, unit), ABSENT, unit);
  }
  // A NaN or an Infinity arrives from a division nobody guarded. It is an
  // absence too, not a very large number.
  assert.equal(formatValue(Number.NaN, "count"), ABSENT);
  assert.equal(formatValue(Number.POSITIVE_INFINITY, "cost"), ABSENT);
});

test("a real zero still renders as a zero", () => {
  assert.equal(formatValue(0, "count"), "0");
  assert.equal(formatValue(0, "cost"), "$0.00");
  assert.equal(formatValue(0, "percent"), "0%");
});

test("unpriced renders as an absence, free renders as $0.00", () => {
  // The seeded corpus has both: ollama/qwen3 is genuinely free, and
  // acme/experimental-v1 has no catalog entry. Both store 0.
  assert.equal(formatCost(0, true), "$0.00");
  assert.equal(formatCost(0, false), ABSENT);
  assert.equal(formatCost(8.14, false), ABSENT);
});

test("durations stay in the unit that carries the difference", () => {
  assert.equal(formatDuration(6), "6ms");
  assert.equal(formatDuration(999), "999ms");
  assert.equal(formatDuration(1000), "1.0s");
  assert.equal(formatDuration(6600), "6.6s");
  assert.equal(formatDuration(31_300), "31s");
  assert.equal(formatDuration(60_000), "1m");
  assert.equal(formatDuration(122_500), "2m 3s");
});

test("a small error rate keeps its decimal instead of rounding to 0%", () => {
  assert.equal(formatRatio(0.004), "0.4%");
  assert.equal(formatRatio(0.031), "3.1%");
  assert.equal(formatRatio(0.5), "50%");
  assert.equal(formatRatio(0), "0%");
});

test("axis ticks compact only where a full number would not fit", () => {
  assert.equal(formatTick(9999, "count"), "9,999");
  assert.equal(formatTick(12_345, "count"), "12.3K");
  assert.equal(formatTick(1_240_000, "tokens"), "1.2M");
  assert.equal(formatTick(6600, "duration"), "6.6s");
});

test("bytes are base 10, like every other size in this dashboard", () => {
  assert.equal(formatBytes(900), "900 B");
  assert.equal(formatBytes(4100), "4.1 kB");
});

/* ── palette ────────────────────────────────────────────────────────────── */

test("every slot carries two channels besides hue", () => {
  const shapes = new Set();
  const dashes = new Set();
  for (let i = 0; i < SLOT_COUNT; i++) {
    const slot = slotStyle(i);
    assert.match(slot.color, /^var\(--chart-[1-6]\)$/);
    shapes.add(slot.shape);
    dashes.add(String(slot.dash));
  }
  assert.equal(shapes.size, SLOT_COUNT, "marker shapes must all differ");
  assert.equal(dashes.size, SLOT_COUNT, "dash patterns must all differ");
});

test("asking for a seventh colour throws rather than recycling one", () => {
  assert.throws(() => slotStyle(SLOT_COUNT), RangeError);
});

test("the seventh series folds, and how depends on whether the measure adds", () => {
  const seven = Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, label: `S${i}` }));
  const omitted = foldToSlots(seven, "omit");
  assert.equal(omitted.kept.length, 6);
  assert.equal(omitted.overflow.length, 1);

  // Under `sum` the sixth slot is reserved for the "Other" entry the caller
  // builds, so only five originals are kept.
  const summed = foldToSlots(seven, "sum");
  assert.equal(summed.kept.length, 5);
  assert.equal(summed.overflow.length, 2);

  assert.deepEqual(foldToSlots(seven.slice(0, 6), "omit"), {
    kept: seven.slice(0, 6),
    overflow: [],
  });
  assert.equal(otherLabel(1, "model"), "1 other model");
  assert.equal(otherLabel(3, "model"), "3 other models");
});

/* ── prepareChart ───────────────────────────────────────────────────────── */

const COUNT = { unit: "count" };

test("no rows and no values are different empties", () => {
  assert.equal(prepareChart([], COUNT).state, "no-rows");
  assert.equal(prepareChart([{ id: "a", label: "A", points: [] }], COUNT).state, "no-rows");

  const allNull = prepareChart(
    [{ id: "a", label: "A", points: [{ x: 1, y: null }, { x: 2, y: null }] }],
    COUNT,
  );
  assert.equal(allNull.state, "all-absent");
  assert.equal(allNull.rows.length, 2, "the buckets still exist, they just said nothing");
  assert.equal(allNull.yDomain, null);
});

test("one row is a valid chart", () => {
  const chart = prepareChart([{ id: "a", label: "A", points: [{ x: 5, y: 3 }] }], COUNT);
  assert.equal(chart.state, "ok");
  assert.deepEqual(chart.xDomain, [5, 5]);
  assert.deepEqual(chart.yDomain, [3, 3]);
  // A single point has no neighbour to join, so a line would draw nothing.
  assert.deepEqual([...chart.series[0].isolatedX], [5]);
});

test("a series that stops early leaves a hole, not a shortened line", () => {
  const chart = prepareChart(
    [
      { id: "a", label: "A", points: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }] },
      { id: "b", label: "B", points: [{ x: 1, y: 9 }] },
    ],
    COUNT,
  );
  assert.equal(chart.rows.length, 3);
  assert.equal(chart.rows[1].b, null);
  assert.equal(chart.rows[2].b, null);
  assert.notEqual(chart.rows[1].b, 0);
});

test("isolated points are exactly the ones a line cannot draw", () => {
  const chart = prepareChart(
    [
      {
        id: "a",
        label: "A",
        points: [
          { x: 1, y: 5 },
          { x: 2, y: null },
          { x: 3, y: 7 },
          { x: 4, y: 8 },
          { x: 5, y: null },
        ],
      },
    ],
    COUNT,
  );
  // x=1 and x=3 have no present neighbour; x=4 joins x=3 so a segment exists.
  assert.deepEqual([...chart.series[0].isolatedX].sort((p, q) => p - q), [1]);
  assert.equal(chart.series[0].observedPoints, 3);
});

test("rows are sorted, so the line does not scribble", () => {
  const chart = prepareChart(
    [{ id: "a", label: "A", points: [{ x: 3, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 3 }] }],
    COUNT,
  );
  assert.deepEqual(chart.rows.map((r) => r.x), [1, 2, 3]);
});

test("a stacked total is unknown when any member is unknown", () => {
  const chart = prepareChart(
    [
      { id: "a", label: "A", points: [{ x: 1, y: 2 }, { x: 2, y: 3 }] },
      { id: "b", label: "B", points: [{ x: 1, y: 4 }, { x: 2, y: null }] },
    ],
    { unit: "count", stack: true },
  );
  assert.deepEqual(chart.stackGaps, [2]);
  // The y domain is the stack total at x=1 and ignores the unknown bucket
  // rather than treating the missing member as zero and plotting 3.
  assert.deepEqual(chart.yDomain, [0, 6]);
  assert.match(stackGapNote(chart), /^1 bucket has no total/);
});

test("an unstacked domain is the tallest member, not the sum", () => {
  const chart = prepareChart(
    [
      { id: "a", label: "A", points: [{ x: 1, y: 2 }] },
      { id: "b", label: "B", points: [{ x: 1, y: 4 }] },
    ],
    COUNT,
  );
  assert.deepEqual(chart.yDomain, [2, 4]);
  assert.deepEqual(chart.stackGaps, []);
  assert.equal(stackGapNote(chart), null);
});

test("a seventh series is summed or named, never dropped in silence", () => {
  const seven = Array.from({ length: 7 }, (_, i) => ({
    id: `s${i}`,
    label: `S${i}`,
    points: [{ x: 1, y: i + 1 }],
  }));

  const omitted = prepareChart(seven, { unit: "count", overflow: "omit" });
  assert.equal(omitted.series.length, 6);
  assert.deepEqual(omitted.omitted, ["S6"]);
  assert.equal(omittedNote(omitted), "1 series not shown: S6.");

  const summed = prepareChart(seven, {
    unit: "count",
    overflow: "sum",
    overflowNoun: "model",
  });
  assert.equal(summed.series.length, 6);
  assert.equal(summed.series[5].label, "2 other models");
  assert.equal(summed.rows[0].__other__, 6 + 7);
  assert.equal(omittedNote(summed), null);
});

test("summing into other keeps an absence absent", () => {
  const seven = Array.from({ length: 7 }, (_, i) => ({
    id: `s${i}`,
    label: `S${i}`,
    points: [{ x: 1, y: i === 6 ? null : 1 }],
  }));
  const summed = prepareChart(seven, { unit: "count", overflow: "sum" });
  // Slot six is "S5 + S6"; S6 has no value, so the total has none either.
  assert.equal(summed.rows[0].__other__, null);
});

test("a duplicate x within one series does not double-count", () => {
  const chart = prepareChart(
    [{ id: "a", label: "A", points: [{ x: 1, y: 2 }, { x: 1, y: 5 }] }],
    COUNT,
  );
  assert.equal(chart.rows.length, 1);
  assert.equal(chart.rows[0].a, 5);
  assert.equal(chart.series[0].observedPoints, 1);
});

test("partial coverage produces a sentence, full coverage produces silence", () => {
  const partial = prepareChart(
    [
      {
        id: "ttft",
        label: "TTFT",
        points: [{ x: 1, y: 400 }],
        coverage: { rows: 41, of: 1203, noun: "turns" },
      },
    ],
    { unit: "duration" },
  );
  assert.equal(coverageNote(partial), "Partial data. TTFT covers 41 of 1,203 turns (3%).");

  const full = prepareChart(
    [
      {
        id: "ttft",
        label: "TTFT",
        points: [{ x: 1, y: 400 }],
        coverage: { rows: 1203, of: 1203, noun: "turns" },
      },
    ],
    { unit: "duration" },
  );
  assert.equal(coverageNote(full), null, "a chart with nothing to disclose says nothing");
  assert.equal(describeCoverage(null), null);
  assert.equal(describeCoverage({ rows: 0, of: 0, noun: "turns" }), null);
});

test("bar charts name the categories that reported nothing", () => {
  const chart = prepareChart(
    [
      {
        id: "a",
        label: "A",
        points: [{ x: 0, y: 1 }, { x: 1, y: null }, { x: 2, y: 0 }],
      },
    ],
    COUNT,
  );
  const labels = ["sonnet", "gpt-5-mini", "ollama"];
  assert.equal(
    absentPointNote(chart, (x) => labels[x]),
    "No value reported for gpt-5-mini. Those are absences, not zeroes.",
  );
  // A measured zero is not an absence and must not appear in that sentence.
  assert.doesNotMatch(absentPointNote(chart, (x) => labels[x]), /ollama/);
});

/* ── delta ──────────────────────────────────────────────────────────────── */

test("no percentage exists when either period has no value", () => {
  assert.deepEqual(periodDelta(null, 10), { kind: "absent" });
  assert.deepEqual(periodDelta(10, null), { kind: "absent" });
  assert.equal(formatDelta(periodDelta(10, null)), ABSENT);
  assert.equal(
    describeDelta(periodDelta(10, null), "last week"),
    "no comparison: last week has no value",
  );
});

test("growth from zero is 'new', not an infinite percentage", () => {
  const delta = periodDelta(8.14, 0, "lower");
  assert.equal(delta.kind, "from-zero");
  assert.equal(formatDelta(delta), "new");
  assert.equal(delta.sentiment, "bad", "spend appearing where there was none is bad news");
  assert.equal(formatDelta(periodDelta(0, 0)), "no change");
});

test("a direction is not a judgement", () => {
  assert.equal(periodDelta(12, 10, "higher").sentiment, "good");
  assert.equal(periodDelta(12, 10, "lower").sentiment, "bad");
  assert.equal(periodDelta(12, 10).sentiment, "neutral");
  assert.equal(periodDelta(8, 10, "lower").sentiment, "good");
});

test("a ratio reports its size and its words", () => {
  const up = periodDelta(112, 100);
  assert.equal(up.kind, "percent");
  assert.equal(formatDelta(up), "+12%");
  assert.equal(describeDelta(up, "the previous 7 days"), "up 12% from the previous 7 days");
  assert.equal(formatDelta(periodDelta(88, 100)), "-12%");
  assert.equal(formatDelta(periodDelta(100, 100)), "no change");
});

/* ── rank ───────────────────────────────────────────────────────────────── */

test("no calls is not a 0% error rate", () => {
  assert.equal(errorRate({ id: "a", label: "a", value: 0, errors: 0, total: 0 }), null);
  assert.equal(errorRate({ id: "a", label: "a", value: 0 }), null);
  assert.equal(errorRate({ id: "a", label: "a", value: 1, errors: 0, total: 40 }), 0);
  assert.equal(errorRate({ id: "a", label: "a", value: 1, errors: 4, total: 40 }), 0.1);
});

test("an absence sorts last in both directions", () => {
  const rows = [
    { id: "a", label: "a", value: 5, durationMs: null },
    { id: "b", label: "b", value: null, durationMs: 10 },
    { id: "c", label: "c", value: 9, durationMs: 2 },
  ];
  assert.deepEqual(rankRows(rows, "value", "desc").map((r) => r.id), ["c", "a", "b"]);
  assert.deepEqual(rankRows(rows, "value", "asc").map((r) => r.id), ["a", "c", "b"]);
  assert.deepEqual(rankRows(rows, "duration", "desc").map((r) => r.id), ["b", "c", "a"]);
});

test("ties break on label so the order is stable", () => {
  const rows = [
    { id: "z", label: "zeta", value: 1 },
    { id: "a", label: "alpha", value: 1 },
  ];
  assert.deepEqual(rankRows(rows, "value", "desc").map((r) => r.id), ["a", "z"]);
  assert.deepEqual(rankRows(rows, "value", "asc").map((r) => r.id), ["a", "z"]);
});

test("bar widths scale to the widest present value", () => {
  const rows = [
    { id: "a", label: "a", value: 10 },
    { id: "b", label: "b", value: 5 },
    { id: "c", label: "c", value: null },
    { id: "d", label: "d", value: 0 },
  ];
  const max = rankMax(rows, "value");
  assert.equal(max, 10);
  assert.equal(barFraction(rows[1], "value", max), 0.5);
  assert.equal(barFraction(rows[2], "value", max), null, "an absence gets no bar at all");
  assert.equal(barFraction(rows[3], "value", max), 0, "a measured zero gets a zero-width bar");
  assert.equal(rankMax([{ id: "a", label: "a", value: null }], "value"), null);
});

test("the sort control names the column it sorts", () => {
  assert.equal(rankKeyLabel("value", "calls", "p95"), "calls");
  assert.equal(rankKeyLabel("duration", "calls", "p95"), "p95");
  assert.equal(rankKeyLabel("errorRate", "calls", "p95"), "error rate");
});

/* ── histogram ──────────────────────────────────────────────────────────── */

test("a histogram counts what it could not bin", () => {
  const h = histogram([1, null, 3, null, null], { bins: 4 });
  assert.equal(h.absent, 3);
  assert.equal(h.observed, 2);
  assert.equal(
    absentNote(h, "turns"),
    "3 of 5 turns reported no value and are not in this histogram.",
  );
  assert.equal(absentNote(histogram([1, 2, 3]), "turns"), null);
});

test("a histogram of nothing, and of nothing measured", () => {
  assert.deepEqual(histogram([]), { bins: [], absent: 0, observed: 0, min: null, max: null });
  const allNull = histogram([null, null]);
  assert.deepEqual(allNull.bins, []);
  assert.equal(allNull.absent, 2);
});

test("one distinct value is one bin, not an invented spread", () => {
  const h = histogram([7, 7, 7]);
  assert.deepEqual(h.bins, [{ from: 7, to: 7, count: 3 }]);
});

test("bin edges are numbers a reader can hold in their head", () => {
  const h = histogram([0, 12, 37, 51, 97], { bins: 10 });
  assert.equal(h.bins[0].from, 0);
  assert.equal(h.bins[0].to, 10);
  assert.equal(h.bins.at(-1).to, 100);
  assert.equal(
    h.bins.reduce((n, b) => n + b.count, 0),
    5,
    "every value lands in exactly one bin",
  );
});

test("the maximum lands inside the histogram, not one past the end", () => {
  const h = histogram([0, 100], { bins: 10 });
  assert.equal(h.bins.at(-1).count, 1);
  assert.equal(h.bins[0].count, 1);
});

/* ── heatmap ────────────────────────────────────────────────────────────── */

test("a cell nobody reported is not a cell that reported zero", () => {
  const grid = buildHeatmap(
    [
      { row: "mon", col: "09", value: 4 },
      { row: "mon", col: "10", value: 0 },
      { row: "tue", col: "09", value: 12 },
    ],
    { rowKeys: ["mon", "tue"], colKeys: ["09", "10"] },
  );
  assert.deepEqual(grid.grid, [
    [4, 0],
    [12, null],
  ]);
  assert.equal(grid.absent, 1);
  assert.equal(grid.observed, 3);
  assert.equal(heatIntensity(null, grid), null);
  assert.equal(heatIntensity(0, grid), 0);
  assert.equal(heatIntensity(12, grid), 1);
  assert.match(absentCellNote(grid), /^1 of 4 cells have no value/);
});

test("intensity is measured from zero, so a quiet bucket looks quiet", () => {
  const grid = buildHeatmap([
    { row: "a", col: "1", value: 3 },
    { row: "a", col: "2", value: 100 },
  ]);
  // From the minimum, 3 would be 0% — the same as a dead hour.
  assert.equal(heatIntensity(3, grid), 0.03);
});

test("a legend always starts at zero, and never divides by zero", () => {
  const one = buildHeatmap([{ row: "a", col: "1", value: 5 }]);
  assert.equal(heatIntensity(5, one), 1);
  assert.deepEqual(heatLegend(one, 5), [
    { from: 0, to: 1, intensity: 0 },
    { from: 1, to: 2, intensity: 0.25 },
    { from: 2, to: 3, intensity: 0.5 },
    { from: 3, to: 4, intensity: 0.75 },
    { from: 4, to: 5, intensity: 1 },
  ]);

  // Every cell zero: the ramp has no width, and five identical swatches would
  // claim a spread that is not there.
  const flat = buildHeatmap([
    { row: "a", col: "1", value: 0 },
    { row: "a", col: "2", value: 0 },
  ]);
  assert.equal(heatIntensity(0, flat), 1);
  assert.deepEqual(heatLegend(flat), [{ from: 0, to: 0, intensity: 1 }]);
});

test("row and column keys are not confusable", () => {
  const grid = buildHeatmap([
    { row: "a b", col: "c", value: 1 },
    { row: "a", col: "b c", value: 2 },
  ]);
  assert.equal(grid.observed, 2, "two labels that concatenate alike are still two cells");
});

test("an empty heatmap has no legend to draw", () => {
  const grid = buildHeatmap([]);
  assert.deepEqual(grid.grid, []);
  assert.deepEqual(heatLegend(grid), []);
  assert.equal(absentCellNote(grid), null);
});

/* ── zoom ───────────────────────────────────────────────────────────────── */

const XS = [10, 20, 30, 40, 50];
const reduce = createZoomReducer(XS);
const run = (actions, from = INITIAL_ZOOM) => actions.reduce(reduce, from);

test("a drag selects, and a click does not", () => {
  const dragged = run([
    { type: "pointer-down", x: 20 },
    { type: "pointer-move", x: 40 },
    { type: "pointer-up", x: 40 },
  ]);
  assert.deepEqual(dragged.selection, { from: 20, to: 40 });
  assert.equal(canZoomIn(dragged), true);

  const clicked = run([
    { type: "pointer-down", x: 20 },
    { type: "pointer-up", x: 20 },
  ]);
  assert.equal(clicked.selection, null);
  assert.equal(canZoomIn(clicked), false);
});

test("a backwards drag selects the same range", () => {
  const forwards = run([
    { type: "pointer-down", x: 20 },
    { type: "pointer-up", x: 40 },
  ]);
  const backwards = run([
    { type: "pointer-down", x: 40 },
    { type: "pointer-up", x: 20 },
  ]);
  assert.deepEqual(forwards.selection, backwards.selection);
});

test("the keyboard reaches the state the mouse reaches", () => {
  // Mouse: press at 20, release at 40.
  const mouse = run([
    { type: "pointer-down", x: 20 },
    { type: "pointer-move", x: 30 },
    { type: "pointer-up", x: 40 },
  ]);
  // Keyboard: caret to 20, then Shift+Right twice.
  const keyboard = run([
    { type: "key", key: "Home", extend: false },
    { type: "key", key: "ArrowRight", extend: false },
    { type: "key", key: "ArrowRight", extend: true },
    { type: "key", key: "ArrowRight", extend: true },
  ]);
  assert.deepEqual(keyboard.selection, mouse.selection);
  assert.equal(canZoomIn(keyboard), canZoomIn(mouse));

  const zoomedByKey = reduce(keyboard, { type: "zoom-in" });
  const zoomedByMouse = reduce(mouse, { type: "zoom-in" });
  assert.deepEqual(zoomedByKey.view, zoomedByMouse.view);
});

test("the caret cannot leave the data", () => {
  const left = run([
    { type: "key", key: "Home", extend: false },
    { type: "key", key: "ArrowLeft", extend: false },
    { type: "key", key: "ArrowLeft", extend: false },
  ]);
  assert.equal(left.cursor, 0);
  const right = run([{ type: "key", key: "End", extend: false }, { type: "key", key: "ArrowRight", extend: false }]);
  assert.equal(right.cursor, XS.length - 1);
});

test("zoom in, zoom out, and back to the whole extent", () => {
  const first = run([
    { type: "pointer-down", x: 10 },
    { type: "pointer-up", x: 50 },
    { type: "zoom-in" },
  ]);
  assert.deepEqual(first.view, { from: 10, to: 50 });
  assert.equal(first.selection, null, "zooming consumes the selection");

  const second = run(
    [{ type: "pointer-down", x: 20 }, { type: "pointer-up", x: 30 }, { type: "zoom-in" }],
    first,
  );
  assert.deepEqual(second.view, { from: 20, to: 30 });

  const out = reduce(second, { type: "zoom-out" });
  assert.deepEqual(out.view, { from: 10, to: 50 }, "zoom out returns to the exact previous view");
  const outAgain = reduce(out, { type: "zoom-out" });
  assert.equal(outAgain.view, null);
  assert.equal(canZoomOut(outAgain), false);
});

test("zoom in does nothing without a range to zoom into", () => {
  assert.deepEqual(reduce(INITIAL_ZOOM, { type: "zoom-in" }), INITIAL_ZOOM);
  const oneCell = run([{ type: "key", key: "Home", extend: false }]);
  assert.equal(canZoomIn(oneCell), false);
  assert.deepEqual(reduce(oneCell, { type: "zoom-in" }).view, null);
});

test("escape clears the selection and leaves the view alone", () => {
  const zoomed = run([
    { type: "pointer-down", x: 10 },
    { type: "pointer-up", x: 50 },
    { type: "zoom-in" },
    { type: "pointer-down", x: 20 },
    { type: "pointer-move", x: 30 },
    { type: "clear" },
  ]);
  assert.equal(zoomed.selection, null);
  assert.deepEqual(zoomed.view, { from: 10, to: 50 });
});

test("a pointer move with no button held does nothing", () => {
  assert.deepEqual(reduce(INITIAL_ZOOM, { type: "pointer-move", x: 30 }), INITIAL_ZOOM);
  assert.deepEqual(reduce(INITIAL_ZOOM, { type: "pointer-up", x: 30 }), INITIAL_ZOOM);
});

test("a keypress on an empty chart is a no-op rather than a crash", () => {
  const empty = createZoomReducer([]);
  assert.deepEqual(empty(INITIAL_ZOOM, { type: "key", key: "ArrowRight", extend: false }), INITIAL_ZOOM);
});

test("the view filters rows and says how many are left", () => {
  const rows = XS.map((x) => ({ x }));
  assert.equal(applyView(rows, null).length, 5);
  assert.deepEqual(applyView(rows, { from: 20, to: 40 }).map((r) => r.x), [20, 30, 40]);
  assert.equal(describeView(null, 5, 5, String), "showing all 5 buckets");
  assert.equal(
    describeView({ from: 20, to: 40 }, 3, 5, String),
    "zoomed to 20 through 40, 3 of 5 buckets",
  );
});

/* ── sparkline geometry ─────────────────────────────────────────────────── */

test("runs stop at every gap", () => {
  assert.deepEqual(contiguousRuns([1, 2, null, 3, null, null, 4]), [
    [0, 1],
    [3, 3],
    [6, 6],
  ]);
  assert.deepEqual(contiguousRuns([]), []);
  assert.deepEqual(contiguousRuns([null, null]), []);
  assert.deepEqual(contiguousRuns([1, 2, 3]), [[0, 2]]);
});

test("a sparkline of nothing is not a flat line at zero", () => {
  assert.equal(sparkGeometry([], { width: 80, height: 20 }).drawable, false);
  assert.equal(sparkGeometry([null, null], { width: 80, height: 20 }).drawable, false);
});

test("a lone point becomes a dot, because a one-point path draws nothing", () => {
  const geometry = sparkGeometry([null, 5, null], { width: 80, height: 20 });
  assert.deepEqual(geometry.paths, []);
  assert.equal(geometry.dots.length, 1);
  assert.equal(geometry.drawable, true);
});

test("a gap in a sparkline is two paths, not one line across it", () => {
  const geometry = sparkGeometry([1, 2, null, 3, 4], { width: 80, height: 20 });
  assert.equal(geometry.paths.length, 2);
  assert.equal(geometry.dots.length, 0);
});

test("a flat series sits on the centre line, not on the floor", () => {
  const geometry = sparkGeometry([4, 4, 4], { width: 80, height: 20 });
  assert.equal(geometry.paths.length, 1);
  assert.match(geometry.paths[0], /,10 L/, "y is half of 20 everywhere");
});

test("a shared domain makes two sparklines comparable", () => {
  const small = sparkGeometry([1, 2], { width: 80, height: 20, domain: [0, 100] });
  const large = sparkGeometry([50, 100], { width: 80, height: 20, domain: [0, 100] });
  assert.notEqual(small.paths[0], large.paths[0]);
  // Without the shared domain each scales to itself and the two are identical.
  const soloSmall = sparkGeometry([1, 2], { width: 80, height: 20 });
  const soloLarge = sparkGeometry([50, 100], { width: 80, height: 20 });
  assert.equal(soloSmall.paths[0], soloLarge.paths[0]);
});

/* ── accessible text ────────────────────────────────────────────────────── */

const TABLE_OPTIONS = { title: "Turns", xLabel: "time", formatX: (x) => `t${x}` };

test("the data table carries the same em dashes the chart does", () => {
  const chart = prepareChart(
    [
      { id: "a", label: "A", points: [{ x: 1, y: 2 }, { x: 2, y: null }] },
      { id: "b", label: "B", points: [{ x: 1, y: 0 }, { x: 2, y: 4 }] },
    ],
    COUNT,
  );
  const table = chartTable(chart, TABLE_OPTIONS);
  assert.deepEqual(table.columns, ["time", "A", "B"]);
  assert.deepEqual(table.rows, [
    ["t1", "2", "0"],
    ["t2", ABSENT, "4"],
  ]);
  assert.equal(table.caption, "Turns: underlying values");
});

test("the spoken summary leads with the caveat, not the number", () => {
  const chart = prepareChart(
    [
      {
        id: "a",
        label: "TTFT",
        points: [{ x: 1, y: 400 }, { x: 2, y: 500 }],
        coverage: { rows: 41, of: 1203, noun: "turns" },
      },
    ],
    { unit: "duration" },
  );
  const summary = chartSummary(chart, { ...TABLE_OPTIONS, kind: "Line chart" });
  assert.match(summary, /^Line chart: Turns\./);
  assert.match(summary, /TTFT over 2 buckets from t1 to t2/);
  assert.match(summary, /Partial data\. TTFT covers 41 of 1,203 turns \(3%\)\./);
});

test("both empties describe themselves differently", () => {
  const none = chartSummary(prepareChart([], COUNT), { ...TABLE_OPTIONS, kind: "Line chart" });
  assert.equal(none, "Line chart: Turns. No data in this range.");

  const silent = chartSummary(
    prepareChart([{ id: "a", label: "A", points: [{ x: 1, y: null }] }], COUNT),
    { ...TABLE_OPTIONS, kind: "Line chart" },
  );
  assert.equal(silent, "Line chart: Turns. 1 time buckets, none of which reported a value.");
});

/**
 * A partial-data warning may never round to 100%.
 *
 * `describeCoverage` only runs when rows < of, so the sentence has already
 * committed to saying the data is incomplete. Rounding made 1,879 of 1,887 read
 * "covers 1,879 of 1,887 turns (100%)" on the overview — a caveat that
 * contradicts itself in its own last word, which is worse than no caveat
 * because a reader who sees 100% stops reading the numerator.
 */
test("a partial-coverage note never claims 100%", () => {
  const note = describeCoverage({ rows: 1879, of: 1887, noun: "turns" });
  assert.ok(note, "1879 of 1887 is partial and must produce a note");
  assert.match(note, /99%/);
  assert.doesNotMatch(note, /100%/);

  // Full coverage stays silent rather than saying 100%.
  assert.equal(describeCoverage({ rows: 1887, of: 1887, noun: "turns" }), null);

  // And nothing in the partial range may ever reach 100.
  for (let of = 2; of <= 4000; of *= 3) {
    for (const rows of [1, of - 1, Math.floor(of / 2)]) {
      const n = describeCoverage({ rows, of, noun: "turns" });
      if (n !== null) assert.doesNotMatch(n, /100%/, `${rows} of ${of}`);
    }
  }
});
