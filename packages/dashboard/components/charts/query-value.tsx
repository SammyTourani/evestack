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

import { formatCost, formatValue, type Unit, type Value } from "./lib/format";
import { describeDelta, formatDelta, periodDelta, type Better } from "./lib/delta";
import { describeCoverage, type Coverage } from "./lib/series";
import { Sparkline } from "./sparkline";

export interface QueryValueProps {
  readonly label: string;
  readonly value: Value;
  readonly unit: Unit;
  /**
   * Only meaningful for `unit: "usd"`. `false` means no catalog price covers
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
    props.unit === "usd" ? formatCost(props.value, priced) : formatValue(props.value, props.unit);

  // A delta against an unpriced number would be a ratio of two unknowns.
  const comparable = props.unit === "usd" && !priced ? null : props.value;
  const delta = periodDelta(comparable, props.previous ?? null, props.better ?? "neutral");
  const previousLabel = props.previousLabel ?? "the previous period";
  const coverage = describeCoverage(props.coverage);

  const sentiment = delta.kind === "ratio" || delta.kind === "from-zero" ? delta.sentiment : "neutral";
  const arrow =
    delta.kind === "ratio" || delta.kind === "from-zero"
      ? delta.direction === "up"
        ? "▲"
        : delta.direction === "down"
          ? "▼"
          : "="
      : null;

  return (
    <div className="flex flex-col gap-1 rounded-md border border-border bg-bg-raised p-4">
      <span className="text-micro tracking-wide text-text-dim uppercase">{props.label}</span>
      <span className="font-mono text-metric text-text">
        {text}
        {props.unit === "usd" && !priced ? (
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
        <div className="mt-1">
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
export function QueryValueRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
      {children}
    </div>
  );
}
