/**
 * Binning, and the count a histogram normally throws away.
 *
 * Every histogram implementation drops the nulls. That is arithmetically
 * necessary and journalistically wrong: a duration histogram over 500 turns
 * where 480 never reported a duration is a picture of 20 turns, and drawn
 * without comment it is a picture of the fleet. `absent` is returned alongside
 * the bins so the chart can say so on its face — the same obligation as
 * `span_coverage`, one aggregation further along.
 *
 * Bin edges are "nice" (…1, 2, 5, 10, 20, 50…) rather than exactly the data
 * range, because an axis reading "0–1,247ms in 10 bins" gives a reader
 * boundaries they cannot hold in their head, and comparing two histograms of
 * slightly different data becomes impossible when the edges move.
 */

import type { Value } from "./format";

export interface Bin {
  /** Inclusive. */
  readonly from: number;
  /** Exclusive, except on the last bin where it is inclusive. */
  readonly to: number;
  readonly count: number;
}

export interface Histogram {
  readonly bins: Bin[];
  /** Values that were `null`: in scope, not measured. */
  readonly absent: number;
  /** Values that carried a number. */
  readonly observed: number;
  readonly min: number | null;
  readonly max: number | null;
}

/** The 1–2–5 ladder, so bin edges are numbers a person can read off an axis. */
function niceStep(rough: number): number {
  if (!(rough > 0) || !Number.isFinite(rough)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const scaled = rough / magnitude;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return step * magnitude;
}

export interface HistogramOptions {
  /** Target bin count; the nice step may produce one or two fewer or more. */
  readonly bins?: number;
}

export function histogram(values: readonly Value[], options: HistogramOptions = {}): Histogram {
  const target = Math.max(1, options.bins ?? 20);
  const present: number[] = [];
  let absent = 0;
  for (const v of values) {
    if (v === null || !Number.isFinite(v)) absent++;
    else present.push(v);
  }
  if (present.length === 0) {
    return { bins: [], absent, observed: 0, min: null, max: null };
  }

  let min = present[0] as number;
  let max = min;
  for (const v of present) {
    if (v < min) min = v;
    if (v > max) max = v;
  }

  // Every value identical — one bin of zero width is the honest picture, and
  // inventing a range around it would imply a spread that is not there.
  if (min === max) {
    return { bins: [{ from: min, to: min, count: present.length }], absent, observed: present.length, min, max };
  }

  const step = niceStep((max - min) / target);
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const count = Math.max(1, Math.round((end - start) / step));
  const bins: Bin[] = Array.from({ length: count }, (_, i) => ({
    from: start + i * step,
    to: start + (i + 1) * step,
    count: 0,
  })) as Bin[];

  const counts = new Array<number>(count).fill(0);
  for (const v of present) {
    // The last bin owns its upper edge, so the maximum value is inside the
    // histogram rather than one index past the end of it.
    const index = Math.min(count - 1, Math.floor((v - start) / step));
    counts[index] = (counts[index] as number) + 1;
  }

  return {
    bins: bins.map((b, i) => ({ ...b, count: counts[i] as number })),
    absent,
    observed: present.length,
    min,
    max,
  };
}

/** The visible sentence for values that had no measurement. `null` when none. */
export function absentNote(h: Histogram, noun: string): string | null {
  if (h.absent === 0) return null;
  const total = h.absent + h.observed;
  return `${h.absent.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} ${noun} reported no value and are not in this histogram.`;
}
