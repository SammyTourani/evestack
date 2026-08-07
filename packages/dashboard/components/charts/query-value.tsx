/**
 * Datadog calls it Query Value, Vercel puts one at the top of every insight
 * section: one number, and what it was last period.
 *
 * It is the smallest widget here and the easiest one to make lie, because a
 * single number has nowhere to put a caveat. All three of this project's
 * conventions land on this component at once:
 *
 *   unpriced is not free      `priced={false}` renders an em dash and the word
 *                             "unpriced", never "$0.00".
 *   partial is not full       a `coverage` prop puts the denominator on the
 *                             tile, under the number, not in a tooltip.
 *   missing is not zero       a `null` value is an em dash, and there is no
 *                             delta against a period that has no value.
 *
 * Colour is not the only channel on the delta: the chip carries a triangle
 * (shape), a signed percentage (text), and a full sentence for assistive
 * technology. The colour is the fourth channel, not the first.
 */

import { Children } from "react";
import { formatCost, formatValue, type Unit, type Value } from "./lib/format";
import { describeDelta, formatDelta, periodDelta, type Better } from "./lib/delta";
import { describeCoverage, type Coverage } from "./lib/series";
import { Sparkline } from "./sparkline";

export interface QueryValueProps {
  readonly label: string;
  readonly value: Value;
  readonly unit: Unit;
  /**
   * Only meaningful for `unit: "cost"`. `false` means no catalog price covers
   * the model, so the spend is unknown rather than zero.
   */
  readonly priced?: boolean;
  /** The same measure over the preceding window. */
  readonly previous?: Value;
  /** Names the comparison window: "previous 7 days". */
  readonly previousLabel?: string;
  readonly better?: Better;
  /** Optional trend, one value per bucket. */
  readonly spark?: readonly Value[];
  readonly coverage?: Coverage;
}

const CHIP: Record<string, string> = {
  good: "text-ok",
  bad: "text-err",
  neutral: "text-text-dim",
};

export function QueryValue(props: QueryValueProps) {
  const priced = props.priced ?? true;
  const text =
    props.unit === "cost" ? formatCost(props.value, priced) : formatValue(props.value, props.unit);

  // A delta against an unpriced number would be a ratio of two unknowns.
  const comparable = props.unit === "cost" && !priced ? null : props.value;
  const delta = periodDelta(comparable, props.previous ?? null, props.better ?? "neutral");
  const previousLabel = props.previousLabel ?? "the previous period";
  const coverage = describeCoverage(props.coverage);

  const sentiment = delta.kind === "percent" || delta.kind === "from-zero" ? delta.sentiment : "neutral";
  const arrow =
    delta.kind === "percent" || delta.kind === "from-zero"
      ? delta.direction === "up"
        ? "▲"
        : delta.direction === "down"
          ? "▼"
          : "="
      : null;

  return (
    <div className="flex h-full flex-col gap-1 rounded-md border border-border bg-bg-raised p-4">
      {/* `min-h-8` so a label that wraps to two lines ("P95 time to first token")
          does not push its own number a line lower than its neighbours'. The
          numbers are the thing being compared across the row; they have to sit on
          one baseline. */}
      <span className="min-h-8 text-micro tracking-wide text-text-dim uppercase">{props.label}</span>
      <span className="font-mono text-metric text-text">
        {text}
        {props.unit === "cost" && !priced ? (
          <span className="ml-2 font-sans text-micro text-warn">unpriced</span>
        ) : null}
      </span>

      <span className={`flex items-center gap-1 text-small ${CHIP[sentiment] ?? "text-text-dim"}`}>
        {arrow === null ? null : <span aria-hidden="true">{arrow}</span>}
        <span aria-hidden="true">{formatDelta(delta)}</span>
        <span className="sr-only">{describeDelta(delta, previousLabel)}</span>
        {delta.kind === "absent" ? null : (
          <span aria-hidden="true" className="text-text-faint">
            vs {previousLabel}
          </span>
        )}
      </span>

      {coverage === null ? null : (
        <span className="text-small text-warn">Partial data: {coverage}.</span>
      )}

      {props.spark === undefined ? null : (
        // `mt-auto` pins every sparkline to the bottom of its tile. Without it a
        // tile carrying a coverage warning drew its spark one line lower than the
        // tiles beside it, so the row read as ragged rather than as a set.
        <div className="mt-auto pt-1">
          <Sparkline
            values={props.spark}
            unit={props.unit}
            label={`${props.label} trend`}
            width={140}
            height={28}
          />
        </div>
      )}
    </div>
  );
}

/**
 * A row of tiles. It exists so that the grid rule lives in one place rather
 * than being re-guessed on every page that shows four numbers.
 */
/**
 * Column counts that divide the row evenly, chosen from how many tiles it holds.
 *
 * `auto-fit, minmax(180px, 1fr)` divides the available width and takes whatever
 * count falls out. That is fine until the count does not divide the tiles: with
 * the sidebar in place the content column is ~1060px, 180px minimums gave exactly
 * FIVE columns, and the overview's SIX tiles rendered as five plus a lone orphan
 * under an empty half-row.
 *
 * A fixed 2/3/6 fixes the overview and breaks /costs, which has four — three plus
 * an orphan at the middle step. So the count is read rather than assumed. Only the
 * arities this actually carries are listed; anything else falls back to auto-fit,
 * which is a reasonable guess when there is nothing better to go on.
 */
const COLUMNS: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-1 sm:grid-cols-3",
  4: "grid-cols-2 lg:grid-cols-4",
  5: "grid-cols-2 sm:grid-cols-3 xl:grid-cols-5",
  6: "grid-cols-2 md:grid-cols-3 xl:grid-cols-6",
};

export function QueryValueRow({ children }: { children: React.ReactNode }) {
  const count = Children.toArray(children).length;
  const columns = COLUMNS[count] ?? "[grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]";
  return <div className={`grid gap-3 ${columns}`}>{children}</div>;
}
