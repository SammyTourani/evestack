/**
 * Sparkline geometry, hand-rolled.
 *
 * §9 of RESEARCH.md keeps bespoke SVG for exactly this shape: a sparkline is
 * forty pixels tall, has no axes, no tooltip and no legend, and Recharts
 * brings a chart store, a responsive container and a resize observer to draw
 * a polyline. In a table with two hundred rows that is two hundred resize
 * observers.
 *
 * The work that is not trivial is the gaps. A sparkline drawn as one polyline
 * over `values.filter(v => v !== null)` silently closes every hole, which on a
 * row-level "last 24h" spark is the difference between an agent that was quiet
 * and an agent that was down. So the series is cut into contiguous runs, each
 * run becomes its own path, and a run of length one becomes a dot because a
 * one-point path draws nothing at all.
 */

import type { Value } from "./format";

/** Inclusive `[start, end]` index ranges over which values are present. */
export function contiguousRuns(values: readonly Value[]): [number, number][] {
  const runs: [number, number][] = [];
  let start: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const present = values[i] !== null && values[i] !== undefined;
    if (present && start === null) start = i;
    if (!present && start !== null) {
      runs.push([start, i - 1]);
      start = null;
    }
  }
  if (start !== null) runs.push([start, values.length - 1]);
  return runs;
}

export interface SparkGeometry {
  /** One `d` attribute per contiguous run of two or more points. */
  readonly paths: string[];
  /** Runs of exactly one point, which no path can render. */
  readonly dots: { readonly cx: number; readonly cy: number }[];
  /** `false` when nothing is drawable: no values, or every value absent. */
  readonly drawable: boolean;
}

export interface SparkOptions {
  readonly width: number;
  readonly height: number;
  /** Stroke width, so the extremes are not clipped by half a line. */
  readonly padding?: number;
  /**
   * Fix the vertical scale across several sparklines that are meant to be
   * compared. Left open, each spark scales to itself and two rows with wildly
   * different magnitudes look identical — the classic sparkline lie.
   */
  readonly domain?: readonly [number, number];
}

export function sparkGeometry(
  values: readonly Value[],
  options: SparkOptions,
): SparkGeometry {
  const pad = options.padding ?? 2;
  const runs = contiguousRuns(values);
  if (runs.length === 0) return { paths: [], dots: [], drawable: false };

  let lo: number;
  let hi: number;
  if (options.domain) {
    [lo, hi] = options.domain;
  } else {
    lo = Number.POSITIVE_INFINITY;
    hi = Number.NEGATIVE_INFINITY;
    for (const v of values) {
      if (v === null) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  const span = hi - lo;

  const x = (i: number) =>
    values.length <= 1
      ? options.width / 2
      : pad + (i / (values.length - 1)) * (options.width - 2 * pad);
  // A flat series sits on the centre line rather than on the floor: pinning it
  // to the bottom of the box reads as "zero" when it may be a steady 400ms.
  const y = (v: number) =>
    span === 0
      ? options.height / 2
      : options.height - pad - ((v - lo) / span) * (options.height - 2 * pad);

  const paths: string[] = [];
  const dots: { cx: number; cy: number }[] = [];
  for (const [from, to] of runs) {
    if (from === to) {
      dots.push({ cx: x(from), cy: y(values[from] as number) });
      continue;
    }
    const points: string[] = [];
    for (let i = from; i <= to; i++) {
      points.push(`${round(x(i))},${round(y(values[i] as number))}`);
    }
    paths.push(`M${points.join(" L")}`);
  }
  return { paths, dots, drawable: true };
}

/** Two decimals is under a tenth of a pixel and halves the markup. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}
