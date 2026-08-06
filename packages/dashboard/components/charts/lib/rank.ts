/**
 * The ranked list that sits under a chart and re-sorts by error rate or
 * duration. Vercel Observability puts one under every graph and it is the
 * cheapest way to turn "something is wrong" into "this is the thing".
 *
 * Two rules do all the work here.
 *
 * An absent measure sorts last in both directions. Ascending by duration must
 * not put the tools nobody timed at the top, and descending must not bury a
 * real value under them either. Absence is not small and it is not large; it
 * is out of the ordering, and it renders as an em dash.
 *
 * An error rate needs a denominator. `errors: 0, total: 0` is not a 0% error
 * rate, it is no calls and therefore no rate — the same shape as an unpriced
 * model rendering $0.00. `errorRate` returns `null` there, the row shows an em
 * dash, and it sorts with the other absences.
 */

import type { Value } from "./format";

export interface RankRow {
  readonly id: string;
  readonly label: string;
  /** The primary measure the list is about: calls, spend, tokens. */
  readonly value: Value;
  /** Failed invocations. `null` when failure was not recorded at all. */
  readonly errors?: Value;
  /** The denominator for the error rate. `null` or 0 means no rate exists. */
  readonly total?: Value;
  /** Whichever duration statistic the caller chose; the label says which. */
  readonly durationMs?: Value;
  /** Where the row drills into, if anywhere. */
  readonly href?: string;
}

export type RankKey = "value" | "errorRate" | "duration";
export type RankDirection = "asc" | "desc";

/** Failures over calls, or `null` when there is no denominator to divide by. */
export function errorRate(row: RankRow): Value {
  const errors = row.errors ?? null;
  const total = row.total ?? null;
  if (errors === null || total === null || total === 0) return null;
  return errors / total;
}

function measure(row: RankRow, key: RankKey): Value {
  switch (key) {
    case "value":
      return row.value;
    case "errorRate":
      return errorRate(row);
    case "duration":
      return row.durationMs ?? null;
  }
}

/**
 * Sorted copy. Ties break on label so the order is stable across renders and
 * across the two sort directions, which matters when the list is the thing a
 * reader is scanning for a change.
 */
export function rankRows(
  rows: readonly RankRow[],
  key: RankKey,
  direction: RankDirection = "desc",
): RankRow[] {
  return [...rows].sort((a, b) => {
    const av = measure(a, key);
    const bv = measure(b, key);
    if (av === null && bv === null) return a.label.localeCompare(b.label);
    if (av === null) return 1;
    if (bv === null) return -1;
    if (av !== bv) return direction === "desc" ? bv - av : av - bv;
    return a.label.localeCompare(b.label);
  });
}

/**
 * The largest present value for a key, for scaling the bars. `null` when
 * nothing has a value, which is the signal to draw no bars at all rather than
 * to draw every bar full-width off a zero maximum.
 */
export function rankMax(rows: readonly RankRow[], key: RankKey): number | null {
  let max: number | null = null;
  for (const row of rows) {
    const v = measure(row, key);
    if (v === null) continue;
    if (max === null || v > max) max = v;
  }
  return max;
}

/**
 * Bar width as a fraction of the widest row, or `null` when the row has no
 * value — which must render as an em dash and an empty track, never as a
 * zero-width bar that looks like a measured zero.
 */
export function barFraction(row: RankRow, key: RankKey, max: number | null): number | null {
  const v = measure(row, key);
  if (v === null) return null;
  if (max === null || max <= 0) return v === 0 ? 0 : null;
  return Math.max(0, Math.min(1, v / max));
}

/** The visible column heading, which also tells a reader what is sorted. */
export function rankKeyLabel(key: RankKey, valueLabel: string, durationLabel: string): string {
  switch (key) {
    case "value":
      return valueLabel;
    case "errorRate":
      return "error rate";
    case "duration":
      return durationLabel;
  }
}
