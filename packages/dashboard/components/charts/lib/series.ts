/**
 * The one function every chart in this directory calls before it draws
 * anything: it turns whatever the caller has into the exact shape Recharts
 * wants, and along the way it settles the four questions a chart component
 * must never answer by accident.
 *
 *   1. Is this empty? There are two different empties and they mean different
 *      things. No rows at all is "nothing happened in this window". Rows whose
 *      every value is absent is "something happened and we did not measure
 *      it". Collapsing the second into the first is the missing-is-zero lie
 *      wearing a different hat, so `state` distinguishes them.
 *
 *   2. Where are the gaps? An absent point is a hole in the line, never a
 *      visit to the x-axis. Recharts does that correctly for `null` — but only
 *      if the row exists with a `null` in it, which is why every series is
 *      re-keyed onto the union of x values rather than left as its own list.
 *      A series that simply stops early would otherwise be indistinguishable
 *      from one that reported zeros.
 *
 *   3. Which points would be invisible? `connectNulls={false}` draws nothing
 *      for a value with absent neighbours, because a line segment needs two
 *      ends. A one-row chart is the degenerate case of this and it is in the
 *      brief. `isolatedX` names those points so the component can draw a
 *      marker where a line cannot go.
 *
 *   4. How many series are there really? The palette is six wide and
 *      `palette.ts` explains why. A seventh series folds, visibly.
 *
 * None of this touches React, which is the point: it is all testable without
 * a DOM, and Recharts renders nothing at all without one.
 */

import type { Unit, Value } from "./format";
import {
  foldToSlots,
  otherLabel,
  OTHER_ID,
  slotStyle,
  type Overflow,
  type SlotStyle,
} from "./palette";

/** One measurement. `x` is a millisecond epoch on a time chart, a bin centre
 *  on a histogram, or any other monotonic numeric position. */
export interface Point {
  readonly x: number;
  readonly y: Value;
}

/**
 * How much of the population a series was actually computed from.
 *
 * The reason this is a first-class field rather than a footnote: a TTFT chart
 * built from spans covers only the turns that exported spans, which in the
 * measured corpus was a small minority. Averaging those and labelling the
 * result "the fleet" is the exact failure `fact_turn.span_coverage` was added
 * to prevent, and a chart is where a reader would believe it.
 */
/*
 * `{rows, of}` because that is what `lib/metrics.ts` returns on every measure
 * and what `components/ui/format.ts` already consumes. This interface used to
 * say `{observed, total}` for the same two numbers, which meant a coverage
 * object from the query API could not be handed to a chart without being
 * rewritten field by field at the call site — the third time the two halves of
 * Wave 2 turned out to have named one concept twice, after `Unit`
 * (ms/usd/ratio vs duration/cost/percent) and the button styles.
 *
 * `noun` stays here rather than moving to the canonical type: it is a
 * presentation choice about the sentence, not part of the measurement, which is
 * why `components/ui/feedback.tsx` also carries it as a separate prop.
 */
export interface Coverage {
  /** Rows that contributed a value. */
  readonly rows: number;
  /** Rows that matched the query, whether they contributed or not. */
  readonly of: number;
  /** What is being counted: "turns", "spans", "runs". */
  readonly noun: string;
}

export interface SeriesInput {
  readonly id: string;
  /** Always required. Hue is a supporting channel, not the only one. */
  readonly label: string;
  readonly points: readonly Point[];
  /** Omit when the series is computed over everything in scope. */
  readonly coverage?: Coverage | null;
}

export interface PreparedSeries {
  readonly id: string;
  readonly label: string;
  readonly style: SlotStyle;
  /**
   * The x positions whose value has no neighbour to join, including every
   * point of a single-point series. A line cannot render these; a marker can.
   */
  readonly isolatedX: ReadonlySet<number>;
  /** Non-null when this series saw less than its whole population. */
  readonly coverage: Coverage | null;
  /** How many of this series' points carried a value. */
  readonly observedPoints: number;
}

/**
 * A Recharts datum. `x` is always present; every prepared series id maps to a
 * value or to `null`, and `null` is what makes Recharts break the line.
 */
export interface Row {
  readonly x: number;
  readonly [seriesId: string]: number | null;
}

export type ChartState =
  /** No rows in the window. */
  | "no-rows"
  /** Rows exist, and not one of them carries a value in any series. */
  | "all-absent"
  /**
   * The query did not answer, so there is no window to describe.
   *
   * A third empty rather than a reuse of `no-rows`, because those are opposite
   * facts and `no-rows` is the reassuring one: "No data in this range" is what
   * a genuinely quiet week says, and rendering it for a database that refused
   * the read is the same all-clear-while-blind the fleet banner and /api/health
   * were both fixed for. Never produced by `prepareChart` — it is set by the
   * caller that caught the failure, because that is the only place that knows.
   */
  | "unreadable"
  | "ok";

export interface PreparedChart {
  readonly state: ChartState;
  readonly series: PreparedSeries[];
  readonly rows: Row[];
  /** Labels of series dropped because the palette ran out, under `omit`. */
  readonly omitted: string[];
  readonly xDomain: readonly [number, number] | null;
  readonly yDomain: readonly [number, number] | null;
  /**
   * x positions where a stacked total cannot be trusted because at least one
   * member series is absent there. Empty unless `stack` was requested.
   */
  readonly stackGaps: number[];
  readonly unit: Unit;
}

export interface PrepareOptions {
  readonly unit: Unit;
  /**
   * Required only when there are more series than colours; see
   * `palette.ts`. Passing it always is harmless.
   */
  readonly overflow?: Overflow;
  /** The noun for the folded entry: "3 other models". */
  readonly overflowNoun?: string;
  /**
   * Set for stacked marks. It changes the y domain (the stack total, not the
   * tallest member) and turns on `stackGaps`.
   */
  readonly stack?: boolean;
}

/** Sum that keeps absence: any absent member makes the total unknown. */
function strictSum(values: readonly Value[]): Value {
  let total = 0;
  for (const v of values) {
    if (v === null) return null;
    total += v;
  }
  return total;
}

/**
 * Merge the overflow tail into one "Other" series by adding the tail's values
 * at each x. Only reachable under `overflow: "sum"`, which a caller may only
 * pass for an additive measure.
 */
function sumIntoOther(tail: readonly SeriesInput[], noun: string): SeriesInput {
  const byX = new Map<number, Value[]>();
  for (const s of tail) {
    for (const p of s.points) {
      const bucket = byX.get(p.x);
      if (bucket === undefined) byX.set(p.x, [p.y]);
      else bucket.push(p.y);
    }
  }
  const points: Point[] = [...byX.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([x, values]) => ({ x, y: strictSum(values) }));
  return { id: OTHER_ID, label: otherLabel(tail.length, noun), points };
}

export function prepareChart(
  input: readonly SeriesInput[],
  options: PrepareOptions,
): PreparedChart {
  const overflow = options.overflow ?? "omit";
  const fold = foldToSlots(input, overflow);
  const omitted: string[] = [];
  const chosen: SeriesInput[] = [...fold.kept];
  if (fold.overflow.length > 0) {
    if (overflow === "sum") {
      chosen.push(sumIntoOther(fold.overflow, options.overflowNoun ?? "series"));
    } else {
      for (const s of fold.overflow) omitted.push(s.label);
    }
  }

  // The union of x positions, so a series that stops early leaves a hole
  // rather than a shortened line. Sorted because Recharts draws in array
  // order and an unsorted array draws a scribble.
  const xs = new Set<number>();
  for (const s of chosen) for (const p of s.points) xs.add(p.x);
  const orderedX = [...xs].sort((a, b) => a - b);

  const byId = new Map<string, Map<number, Value>>();
  for (const s of chosen) {
    const m = new Map<number, Value>();
    // A duplicate x within one series is a caller bug we cannot resolve
    // honestly — two different measurements at one position have no defined
    // merge — so the second wins and the count below reports the truth of
    // what is drawn rather than of what was passed.
    for (const p of s.points) m.set(p.x, p.y);
    byId.set(s.id, m);
  }

  const rows: Row[] = orderedX.map((x) => {
    const row: Record<string, number | null> = { x };
    for (const s of chosen) row[s.id] = byId.get(s.id)?.get(x) ?? null;
    return row as Row;
  });

  const series: PreparedSeries[] = chosen.map((s, i) => {
    const values = byId.get(s.id) as Map<number, Value>;
    const isolatedX = new Set<number>();
    let observedPoints = 0;
    for (let k = 0; k < orderedX.length; k++) {
      const x = orderedX[k] as number;
      if ((values.get(x) ?? null) === null) continue;
      observedPoints++;
      const before = k > 0 ? (values.get(orderedX[k - 1] as number) ?? null) : null;
      const after =
        k < orderedX.length - 1 ? (values.get(orderedX[k + 1] as number) ?? null) : null;
      if (before === null && after === null) isolatedX.add(x);
    }
    return {
      id: s.id,
      label: s.label,
      style: slotStyle(i),
      isolatedX,
      coverage: s.coverage ?? null,
      observedPoints,
    };
  });

  const stackGaps: number[] = [];
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    if (options.stack === true) {
      const total = strictSum(series.map((s) => row[s.id] ?? null));
      if (total === null) {
        stackGaps.push(row.x);
        continue;
      }
      // A stack's floor is zero even when every member is positive, because
      // the reader measures the band from the baseline.
      if (total < yMin) yMin = total;
      if (total > yMax) yMax = total;
      if (yMin > 0) yMin = 0;
    } else {
      for (const s of series) {
        const v = row[s.id] ?? null;
        if (v === null) continue;
        if (v < yMin) yMin = v;
        if (v > yMax) yMax = v;
      }
    }
  }

  const observed = series.reduce((n, s) => n + s.observedPoints, 0);
  const state: ChartState = rows.length === 0 ? "no-rows" : observed === 0 ? "all-absent" : "ok";

  return {
    state,
    series,
    rows,
    omitted,
    xDomain:
      rows.length === 0
        ? null
        : [(rows[0] as Row).x, (rows[rows.length - 1] as Row).x],
    yDomain: Number.isFinite(yMin) && Number.isFinite(yMax) ? [yMin, yMax] : null,
    stackGaps,
    unit: options.unit,
  };
}

/**
 * The visible sentence a partly-covered chart has to carry. `null` when every
 * series saw its whole population, which is the common case and must not
 * produce a reassuring "100% coverage" badge — a chart with no note is a
 * chart with nothing to disclose.
 */
export function coverageNote(chart: PreparedChart): string | null {
  const parts: string[] = [];
  for (const s of chart.series) {
    const phrase = describeCoverage(s.coverage);
    if (phrase !== null) parts.push(`${s.label} ${phrase}`);
  }
  if (parts.length === 0) return null;
  return `Partial data. ${parts.join("; ")}.`;
}

/**
 * "covers 41 of 1,203 turns (3%)", or `null` when coverage is complete or
 * unstated. Shared with the stat tile, which carries the same obligation for
 * a single number that a chart carries for a series.
 */
export function describeCoverage(coverage: Coverage | null | undefined): string | null {
  if (coverage === null || coverage === undefined) return null;
  if (coverage.of <= 0 || coverage.rows >= coverage.of) return null;
  // FLOOR, not round. This branch only runs when rows < of, so the sentence is
  // already committed to saying the data is partial — and 1,879 of 1,887 rounds
  // to "covers ... (100%)", a partial-data warning that contradicts itself in
  // its own last word. Flooring makes the worst case read 99%, which is both
  // true and consistent with the note being shown at all.
  const pct = Math.floor((coverage.rows / coverage.of) * 100);
  return `covers ${coverage.rows.toLocaleString("en-US")} of ${coverage.of.toLocaleString("en-US")} ${coverage.noun} (${pct}%)`;
}

/** The visible sentence for series the palette could not fit. */
export function omittedNote(chart: PreparedChart): string | null {
  if (chart.omitted.length === 0) return null;
  return `${chart.omitted.length} series not shown: ${chart.omitted.join(", ")}.`;
}

/**
 * The visible sentence for buckets a series has no value for.
 *
 * A line chart does not need this — a gap in a line is visible. A bar chart
 * does: a bar of height zero and a bar that was never drawn occupy the same
 * nothing, so without a sentence naming them, "no data for this model" and
 * "this model cost nothing" are the same picture.
 */
export function absentPointNote(
  chart: PreparedChart,
  formatX: (x: number) => string,
): string | null {
  const missing = new Set<number>();
  for (const row of chart.rows) {
    for (const s of chart.series) {
      if ((row[s.id] ?? null) === null) missing.add(row.x);
    }
  }
  if (missing.size === 0) return null;
  const names = [...missing].sort((a, b) => a - b).map(formatX);
  const shown = names.slice(0, 6).join(", ");
  const rest = names.length > 6 ? `, and ${names.length - 6} more` : "";
  return `No value reported for ${shown}${rest}. Those are absences, not zeroes.`;
}

/**
 * The visible sentence for stacked buckets whose total is unknown. Separate
 * from `coverageNote` because it is a different fact: the population is fine,
 * one member of the stack simply has no value there, and adding the rest
 * would understate the total rather than sample it.
 */
export function stackGapNote(chart: PreparedChart): string | null {
  if (chart.stackGaps.length === 0) return null;
  const n = chart.stackGaps.length;
  return `${n} ${n === 1 ? "bucket has" : "buckets have"} no total: at least one series reported no value there.`;
}
