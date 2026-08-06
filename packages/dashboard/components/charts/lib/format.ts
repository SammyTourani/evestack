/**
 * Turning a number into text, and refusing to turn an absence into one.
 *
 * The dashboard already spells this rule out in a dozen places by hand —
 * `run.durationMs === null ? "—" : …`, `priced ? formatUsd(…) : <span
 * className="unpriced">—</span>`. Charts multiply the number of places that
 * decision gets made by every axis tick, every tooltip row, every legend
 * entry and every cell of the data table, so it is made once here instead.
 *
 * The one rule: `null` is an absence and renders as an em dash. It is never
 * coerced, never defaulted, never summed as zero. A model with no price is
 * `priced: false`, not `costUsd: 0`, and it renders "unpriced" rather than
 * "$0.00" — the distinction the seeded fixture exists to catch
 * (`ollama/qwen3` is genuinely free, `acme/experimental-v1` is unpriced, and
 * both store 0).
 */

import { formatUsd } from "@/lib/pricing";

/** The single absence glyph, matching every `—` already in `app/`. */
export const ABSENT = "—";

/**
 * What a chart axis is counting. The unit travels with the series rather than
 * with the formatter call so that the axis, the tooltip, the legend and the
 * data table cannot disagree about it.
 */
export type { Unit } from "../../../lib/metrics";
import type { Unit } from "../../../lib/metrics";

/*
 * The unit vocabulary is NOT declared here. It is imported from
 * `lib/metrics.ts`, which stamps a unit on every measure it returns, because a
 * chart is supposed to be renderable straight from a `/api/metrics/query`
 * response — that is the entire point of shipping a query API.
 *
 * An earlier version of this file declared its own list: `ms`, `usd`, `ratio`.
 * The two halves of the same wave, built in parallel, invented incompatible
 * vocabularies at the one seam where they meet, so a series fed from the API
 * carried units no chart could match and every cost rendered as a bare count.
 * Importing the type instead of restating it makes that divergence a
 * compile error rather than a silent mis-render, which is better than the test
 * that would otherwise have to notice. `switch` statements below are
 * exhaustive over it, so adding a unit to the catalog breaks the build here
 * until this file handles it.
 */

/** A value that may be genuinely absent. `null` is a gap, never a zero. */
export type Value = number | null;

const COUNT = new Intl.NumberFormat("en-US");

/**
 * Compact for axis labels, where 1,204,000 does not fit and "1.2M" does.
 * `Intl` rounds to one fraction digit, so 1.24M and 1.25M both read "1.2M";
 * that is acceptable on a tick and is why the data table shows the full value.
 */
const COMPACT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/**
 * A duration, in the units a human reading a latency chart thinks in. Under a
 * second stays in milliseconds because the difference between 6 ms and 60 ms
 * is the whole story on a tool-call chart, and "0.0s" tells it badly.
 */
export function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < 1000) return `${Math.round(ms)}ms`;
  if (abs < 60_000) return `${(ms / 1000).toFixed(abs < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(abs / 60_000);
  const seconds = Math.round((abs % 60_000) / 1000);
  const sign = ms < 0 ? "-" : "";
  return seconds === 0 ? `${sign}${minutes}m` : `${sign}${minutes}m ${seconds}s`;
}

/** Base-10 bytes, matching how every other size in this dashboard is printed. */
export function formatBytes(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1000) return `${Math.round(n)} B`;
  if (abs < 1_000_000) return `${(n / 1000).toFixed(1)} kB`;
  if (abs < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  return `${(n / 1_000_000_000).toFixed(1)} GB`;
}

/**
 * A ratio in 0..1 rendered as a percentage. Small non-zero rates keep a
 * decimal, because an error rate of 0.4% must not round to "0%" — that is the
 * same lie as an absent value rendering as zero, one step further along.
 */
export function formatRatio(r: number): string {
  const pct = r * 100;
  // An exact zero is an exact zero and says so. Anything else under 10% keeps
  // a decimal, because 0.4% must not round to the same string.
  if (pct === 0) return "0%";
  if (Math.abs(pct) < 10) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

/**
 * The full-precision rendering, for tooltips, the data table and stat tiles.
 * `null` in, em dash out — no caller gets to decide otherwise.
 */
export function formatValue(value: Value, unit: Unit): string {
  if (value === null || !Number.isFinite(value)) return ABSENT;
  switch (unit) {
    case "duration":
      return formatDuration(value);
    case "cost":
      return formatUsd(value);
    case "percent":
      return formatRatio(value);
    case "bytes":
      return formatBytes(value);
    case "tokens_per_second":
      return `${COUNT.format(Math.round(value))}/s`;
    case "count":
    case "tokens":
      return COUNT.format(value);
  }
}

/**
 * The same value shortened for an axis tick, where horizontal space is the
 * binding constraint. Money and durations are already short; counts and token
 * totals are the ones that overflow.
 */
export function formatTick(value: Value, unit: Unit): string {
  if (value === null || !Number.isFinite(value)) return ABSENT;
  if (unit === "count" || unit === "tokens" || unit === "tokens_per_second") {
    return Math.abs(value) < 10_000 ? COUNT.format(value) : COMPACT.format(value);
  }
  return formatValue(value, unit);
}

/**
 * Money, with the unpriced case kept separate from the free case.
 *
 * `priced === false` means no catalog entry covers the model, so the true
 * spend is unknown and any number printed here would be an invention. It
 * renders as an absence. `priced === true` with a zero value means local
 * inference that really did cost nothing, and prints "$0.00".
 */
export function formatCost(value: Value, priced: boolean): string {
  if (!priced) return ABSENT;
  return formatValue(value, "cost");
}
