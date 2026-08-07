/**
 * The big number, with everything that keeps it from lying.
 *
 * `.stat` in `app/globals.css` is a label and a value. Three things are added
 * here, and each one exists because of a specific way the two-line version
 * misleads:
 *
 *   - **A unit.** The value arrives from the metrics API as a bare number with
 *     a `unit` beside it. Rendering `12` for twelve tokens per second, or
 *     `4946` for a p50, is the number lying about what it is.
 *   - **Coverage.** A p95 TTFT over the 3% of turns that exported spans looks
 *     exactly like a p95 over all of them. `CoverageNote` puts the denominator
 *     under it.
 *   - **A delta that refuses the undefined case.** Period-over-period is the
 *     first thing anyone looks at and `previous = 0` has no percentage. See
 *     `delta()`.
 *
 * `sparkline` is a slot rather than a chart, because the chart primitives are a
 * separate piece of work and a tile that imported one would couple them.
 */
import type { ReactNode } from "react";

import type { Unit } from "../../lib/metrics";
import { CoverageNote } from "./feedback";
import { type Coverage, delta, formatCost, formatMetric } from "./format";

export interface StatTileProps {
  readonly label: string;
  readonly value: number | null | undefined;
  readonly unit: Unit;
  /**
   * Required when `unit` is `cost` and the window contains a model with no
   * configured rate — the tile then reads `Unpriced` rather than `$0.00`.
   * Ignored for every other unit, because only cost can be unpriced.
   */
  readonly priced?: boolean;
  /** The same measure over the preceding window of equal length. */
  readonly previous?: number | null;
  /** Which direction is good. Omit when neither is — a run count, say. */
  readonly betterWhen?: "up" | "down";
  readonly coverage?: Coverage;
  /** Names the population in the coverage sentence: `turns`, `tool calls`. */
  readonly coverageNoun?: string;
  /** A `<Sparkline/>` from the chart primitives, or nothing. */
  readonly sparkline?: ReactNode;
}

/** ▲/▼ so direction survives greyscale, print, and every form of colour blindness. */
const ARROW = { up: "▲", down: "▼", flat: "→" } as const;

export function StatTile({
  label,
  value,
  unit,
  priced = true,
  previous,
  betterWhen,
  coverage,
  coverageNoun,
  sparkline,
}: StatTileProps) {
  // An unpriced window has no spend to compare, so it has no change either.
  // Without this the tile reads `Unpriced ▼ −100.0%`, which is a confident
  // number about an amount the previous line just said it does not know.
  const change = unit === "cost" && !priced ? null : delta(value, previous);
  const good =
    change === null || change.direction === "flat" || betterWhen === undefined
      ? null
      : change.direction === betterWhen;

  return (
    <div className="rounded-md border border-border bg-bg-raised px-4 py-3.5">
      <div className="text-micro uppercase tracking-[0.06em] text-text-faint">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-metric font-semibold tabular-nums text-text">
          {unit === "cost" ? formatCost(value, priced) : formatMetric(value, unit)}
        </span>
        {change !== null ? (
          <span
            className={[
              "text-small tabular-nums",
              good === null ? "text-text-dim" : good ? "text-ok" : "text-err",
            ].join(" ")}
          >
            <span aria-hidden="true">{ARROW[change.direction]}</span> {change.text}
            {/* The arrow is decoration; this is the sentence that gets read. */}
            <span className="sr-only"> {change.direction} versus the previous period</span>
          </span>
        ) : null}
      </div>
      {sparkline ? <div className="mt-2">{sparkline}</div> : null}
      {coverage ? (
        <div className="mt-2">
          <CoverageNote coverage={coverage} noun={coverageNoun} />
        </div>
      ) : null}
    </div>
  );
}
