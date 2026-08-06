/**
 * How a number becomes text, in one place.
 *
 * Every surface built on top of W2's query API — a stat tile, a table cell, a
 * chart tooltip, an axis tick — has to turn `{value, unit}` into a string, and
 * the three rules this repo already gets right are all rules about that
 * conversion:
 *
 *   1. An unpriced model never renders `$0.00`. `lib/pricing.ts` returns 0 for
 *      a model it has no rate for, which is arithmetically fine and a lie on
 *      screen. The caller knows whether the model was priced; this module
 *      refuses to print a dollar sign when it was not.
 *   2. A metric over partial data says so. `fact_turn.span_coverage` and the
 *      `coverage` block on every metrics response both exist for this, and
 *      both are useless if the tile renders the number bare.
 *   3. An absent value is an em dash, never a zero. `null` from a percentile
 *      over an empty bucket means "nothing to measure", and `0` means "measured
 *      zero". They are different facts and they must not share a glyph.
 *
 * Nothing here is React. It is imported by the primitives in this directory and
 * unit-tested directly, because a formatting rule is exactly the kind of thing
 * that is cheap to assert and expensive to get wrong in a screenshot.
 */
// Relative rather than the `@/` alias the pages use: `test/register-ts-resolve.mjs`
// resolves a relative specifier to its `.ts` file, and a bare `@/…` goes to
// node_modules and fails. Everything in this directory therefore imports
// relatively, so a primitive can be unit-tested without a bundler.
import type { Unit } from "../../lib/metrics";
import { formatUsd } from "../../lib/pricing";
import { duration } from "../../lib/time";

/**
 * The absent-value glyph.
 *
 * `lib/time.ts` holds the same constant privately and returns it from `ago()`
 * and `duration()`. Rather than widen that module's API for one character, this
 * is a second declaration and `test/ui-format.test.mjs` asserts the two agree
 * by calling `duration(null)` — so a change in either place fails a test rather
 * than producing two different dashes on one page.
 */
export const EM_DASH = "—";

/** `Intl` once, not once per cell. A table renders thousands of these. */
const INTEGER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const DECIMAL = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/** Anything that is not a finite number is absent, including `NaN`. */
function absent(value: number | null | undefined): value is null | undefined {
  return value === null || value === undefined || !Number.isFinite(value);
}

/**
 * Cost, with the unpriced case made unrepresentable as a dollar amount.
 *
 * `priced` is deliberately required rather than defaulted, because every
 * default is wrong somewhere: defaulting to `true` reprints the `$0.00` this
 * function exists to prevent, and defaulting to `false` labels a real $12.40 as
 * unpriced. The caller has the model and `isPriced()` from `lib/pricing.ts`.
 */
export function formatCost(usd: number | null | undefined, priced: boolean): string {
  if (!priced) return "Unpriced";
  if (absent(usd)) return EM_DASH;
  return formatUsd(usd);
}

/**
 * Bytes at three significant figures, matching `duration()`'s resolution rule.
 * Powers of 1024 because these are payload sizes measured with
 * `octet_length`/`Buffer.byteLength`, not disk marketing units.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${INTEGER.format(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(2) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * A percent is stored as a fraction, because `failure_rate` is `avg()` of a 0/1
 * column and `avg` of a boolean is a fraction. One decimal, except at exactly
 * zero — `app/monitors/page.tsx` already draws it that way, so "0%" and "0.0%"
 * do not both appear on the same screen.
 */
function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(fraction === 0 ? 0 : 1)}%`;
}

/**
 * `{value, unit}` to text. The unit vocabulary is `lib/metrics.ts`'s, so a new
 * unit there is a type error here rather than a silently unformatted number.
 *
 * Cost routes through `formatCost` with `priced: true`: a metrics response is
 * an aggregate over many turns and has no single model to check, so the
 * unpriced question belongs to whatever knows which models are in the window.
 * A caller that does know calls `formatCost` directly.
 */
export function formatMetric(value: number | null | undefined, unit: Unit): string {
  if (absent(value)) return EM_DASH;
  switch (unit) {
    case "duration":
      return duration(value);
    case "cost":
      return formatCost(value, true);
    case "percent":
      return formatPercent(value);
    case "bytes":
      return formatBytes(value);
    case "count":
    case "tokens":
      return INTEGER.format(value);
    case "tokens_per_second":
      return `${DECIMAL.format(value)}/s`;
  }
}

export interface Delta {
  /** Signed, already formatted: `+12.4%`. */
  readonly text: string;
  readonly direction: "up" | "down" | "flat";
}

/**
 * Period-over-period change, or `null` when there is no honest one to state.
 *
 * `null` covers three cases and they are all the same mistake if collapsed into
 * a number. Either side absent means the comparison was never computed. A
 * previous value of exactly zero means the percentage is undefined — 0 → 5 is
 * not "+100%" and not "+∞%", it is "there was nothing before", which a tile
 * says by drawing no delta rather than by inventing one.
 *
 * The caller decides whether up is good; this only reports which way it went.
 */
export function delta(
  current: number | null | undefined,
  previous: number | null | undefined,
): Delta | null {
  if (absent(current) || absent(previous) || previous === 0) return null;
  const change = (current - previous) / Math.abs(previous);
  if (change === 0) return { text: "0%", direction: "flat" };
  return {
    text: `${change > 0 ? "+" : "−"}${(Math.abs(change) * 100).toFixed(1)}%`,
    direction: change > 0 ? "up" : "down",
  };
}

/**
 * How much of the population a number was actually computed over.
 *
 * Shaped like `MeasureCoverage` in `lib/metrics.ts` (`{rows, of}`) so a response
 * can be handed straight to it, and it also covers the fact table's
 * `span_coverage`, which answers the same question one row at a time.
 */
export interface Coverage {
  /** Rows that contributed a value. */
  readonly rows: number;
  /** Rows that matched the query. */
  readonly of: number;
}

/**
 * The sentence to put next to a partial number, or `null` when the number
 * stands on its own. Returning `null` for the full case is what lets a caller
 * write `{note && <p>{note}</p>}` without deciding the rule itself.
 *
 * `noun` names the population — "turns", "tool calls" — because "3 of 40 rows"
 * is true and "3 of 40 turns" is the sentence someone can act on.
 *
 * Two silences, and they are silent for different reasons. Nothing matched the
 * filter (`of === 0`) is a question about the filter and belongs to whatever
 * renders the empty state; full coverage needs no caveat. The order matters:
 * `{rows: 0, of: 0}` reaching the `rows === 0` arm would read "No data — 0 of 0
 * rows", which is a warning about a measure over a population that does not
 * exist.
 */
export function coverageNote(coverage: Coverage, noun = "rows"): string | null {
  const { rows, of } = coverage;
  if (of <= 0 || rows >= of) return null;
  if (rows <= 0) {
    return `No data — 0 of ${INTEGER.format(of)} ${noun} carry this measure.`;
  }
  return `Partial — ${INTEGER.format(rows)} of ${INTEGER.format(of)} ${noun} carry this measure.`;
}
