/**
 * Which of the six chart slots a series gets, and the two channels besides
 * hue that carry the same information.
 *
 * `app/globals.css` validated the six categorical colours and then wrote down
 * the obligation that comes with them: the worst adjacent pair clears the
 * colour-vision-deficiency separation target by four tenths of a unit, "which
 * is a pass and not a comfortable one, so hue stays a supporting channel:
 * whatever draws these owes every series a direct label or a legend entry."
 * That comment also explains why there is no `--series-dash-*` token — the
 * obligation belongs to the mark, not to a variable. This module is the mark's
 * side of that bargain.
 *
 * Three channels per slot:
 *
 *   colour   `var(--chart-N)`, switching with `prefers-color-scheme`.
 *   dash     a stroke-dasharray, so a line is identifiable in greyscale.
 *   shape    the marker drawn at an isolated point and in the legend swatch,
 *            so a series is identifiable in a single-pixel-wide screenshot.
 *
 * Areas and bars cannot use a dash, so they get a hatch texture instead; see
 * `components/charts/hatch.tsx`, which owns the SVG `<pattern>` definitions
 * and keys them by the same slot index.
 */

/** The palette was validated as six colours. A seventh does not exist. */
export const SLOT_COUNT = 6;

export type MarkerShape = "circle" | "square" | "triangle" | "diamond" | "cross" | "wye";

export interface SlotStyle {
  /** A CSS colour, always a `var()` so the light-mode media query still wins. */
  readonly color: string;
  /**
   * `stroke-dasharray`, or `null` for the unbroken first slot. Patterns are
   * chosen to stay distinguishable at a 2px stroke: long, dotted, dash-dot,
   * short, and long-short.
   */
  readonly dash: string | null;
  readonly shape: MarkerShape;
}

const SLOTS: readonly SlotStyle[] = [
  { color: "var(--chart-1)", dash: null, shape: "circle" },
  { color: "var(--chart-2)", dash: "6 3", shape: "square" },
  { color: "var(--chart-3)", dash: "2 3", shape: "triangle" },
  { color: "var(--chart-4)", dash: "8 3 2 3", shape: "diamond" },
  { color: "var(--chart-5)", dash: "3 3", shape: "cross" },
  { color: "var(--chart-6)", dash: "10 4 3 4", shape: "wye" },
];

/**
 * The style for slot `index`, assigned in fixed order — slot 1 is always the
 * first series and is never recycled when a filter drops a series, which is
 * the property `globals.css` asks for. Callers must never index past the
 * palette; `foldToSlots` below is how a longer list becomes a shorter one.
 */
export function slotStyle(index: number): SlotStyle {
  const slot = SLOTS[index];
  if (slot === undefined) {
    throw new RangeError(
      `chart slot ${index} does not exist: the palette is ${SLOT_COUNT} colours wide, ` +
        `fold the series with foldToSlots() before styling them`,
    );
  }
  return slot;
}

/**
 * What to do with a seventh series.
 *
 * `sum` is only correct for an additive measure — a stacked area of cost by
 * model can honestly show "other" as the sum of the tail, because the sum of
 * dollars is dollars. `omit` is for everything else: the mean of a tail of
 * latencies is not a latency anybody experienced, so those series are dropped
 * and named instead. There is deliberately no default. A caller that has more
 * series than colours has to say which of these two its measure permits.
 */
export type Overflow = "sum" | "omit";

export interface Foldable {
  readonly id: string;
  readonly label: string;
}

export interface Fold<T extends Foldable> {
  /** At most `SLOT_COUNT` entries, ready to be styled by slot index. */
  readonly kept: T[];
  /**
   * The series that did not fit, in the order they arrived. Under `sum` the
   * caller merges these into a final "Other" entry; under `omit` it names
   * them in a visible note. Empty in the common case.
   */
  readonly overflow: T[];
}

/**
 * Split a series list at the palette's width.
 *
 * Under `sum` only five slots are kept, because the sixth is reserved for the
 * "Other" entry the caller is about to build — otherwise folding seven series
 * would produce seven marks and defeat the point.
 */
export function foldToSlots<T extends Foldable>(series: readonly T[], overflow: Overflow): Fold<T> {
  const width = overflow === "sum" ? SLOT_COUNT - 1 : SLOT_COUNT;
  if (series.length <= SLOT_COUNT) return { kept: [...series], overflow: [] };
  return { kept: series.slice(0, width), overflow: series.slice(width) };
}

/** The id and label the folded tail is presented under. */
export const OTHER_ID = "__other__";

/** "3 other models", so the legend entry says how much it is hiding. */
export function otherLabel(count: number, noun: string): string {
  return `${count} other ${count === 1 ? noun : `${noun}s`}`;
}
