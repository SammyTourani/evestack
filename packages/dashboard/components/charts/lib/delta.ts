/**
 * Period-over-period change, and the four ways it can fail to be a percentage.
 *
 * Datadog calls this widget "Change" and Vercel puts it on every tile. The
 * arithmetic is one division; everything below is about the cases where that
 * division is not the answer, each of which this dashboard would otherwise
 * render as a confident number:
 *
 *   either side absent   Not measured last week is not "0 last week". No
 *                        percentage exists. Em dash.
 *   previous is zero     $0 → $8.14 is not "+∞%" and certainly not "+100%".
 *                        It is new spend, and that is what it says.
 *   both zero            No change, and no division. "no change", not "0%".
 *   current is zero      -100% is arithmetically right and worth stating
 *                        plainly, so it stays a ratio.
 *
 * The second thing this module settles is that a direction is not a judgement.
 * Cost going up and error rate going up are both "up" and only one of them is
 * bad, so the caller declares which direction is an improvement and the tile
 * colours from `sentiment`, never from the sign.
 */

import { ABSENT, formatRatio, type Value } from "./format";

export type Direction = "up" | "down" | "flat";

/** Which way is good. `neutral` means the tile shows change without colour. */
export type Better = "higher" | "lower" | "neutral";

export type Sentiment = "good" | "bad" | "neutral";

export type Delta =
  /** One or both periods have no value. */
  | { readonly kind: "absent" }
  /** Previous was zero and current is not: a ratio would divide by zero. */
  | { readonly kind: "from-zero"; readonly direction: "up" | "down"; readonly sentiment: Sentiment }
  /** Both periods are zero. */
  | { readonly kind: "unchanged" }
  | {
      readonly kind: "percent";
      /** Signed fraction: 0.12 is +12%. */
      readonly fraction: number;
      readonly direction: Direction;
      readonly sentiment: Sentiment;
    };

function sentimentOf(direction: Direction, better: Better): Sentiment {
  if (direction === "flat" || better === "neutral") return "neutral";
  if (better === "higher") return direction === "up" ? "good" : "bad";
  return direction === "up" ? "bad" : "good";
}

export function periodDelta(current: Value, previous: Value, better: Better = "neutral"): Delta {
  if (current === null || previous === null) return { kind: "absent" };
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return { kind: "absent" };
  if (previous === 0) {
    if (current === 0) return { kind: "unchanged" };
    // A negative current against a zero previous is still a move away from
    // zero with no ratio available, and it is reported with its own sign
    // rather than flattened into "new" — every measure this dashboard charts
    // is non-negative, so a negative here is a signal, not a rounding.
    const direction = current > 0 ? "up" : "down";
    return { kind: "from-zero", direction, sentiment: sentimentOf(direction, better) };
  }
  const fraction = (current - previous) / Math.abs(previous);
  const direction: Direction = fraction > 0 ? "up" : fraction < 0 ? "down" : "flat";
  return { kind: "percent", fraction, direction, sentiment: sentimentOf(direction, better) };
}

/**
 * The text on the tile. Deliberately includes a word as well as a sign,
 * because an arrow glyph and a colour are both channels a reader may not
 * have; "+12% vs previous" survives greyscale and a screen reader.
 */
export function formatDelta(delta: Delta): string {
  switch (delta.kind) {
    case "absent":
      return ABSENT;
    case "unchanged":
      return "no change";
    case "from-zero":
      return delta.direction === "up" ? "new" : "now negative";
    case "percent": {
      if (delta.direction === "flat") return "no change";
      const sign = delta.fraction > 0 ? "+" : "-";
      return `${sign}${formatRatio(Math.abs(delta.fraction))}`;
    }
  }
}

/** The sentence a screen reader gets, where "+12%" alone lacks a referent. */
export function describeDelta(delta: Delta, periodLabel: string): string {
  switch (delta.kind) {
    case "absent":
      return `no comparison: ${periodLabel} has no value`;
    case "unchanged":
      return `unchanged from ${periodLabel}`;
    case "from-zero":
      return delta.direction === "up"
        ? `new: ${periodLabel} was zero`
        : `now negative: ${periodLabel} was zero`;
    case "percent": {
      if (delta.direction === "flat") return `unchanged from ${periodLabel}`;
      const word = delta.direction === "up" ? "up" : "down";
      return `${word} ${formatRatio(Math.abs(delta.fraction))} from ${periodLabel}`;
    }
  }
}
