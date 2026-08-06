/**
 * A sparkline, and the row-level honesty problems that come with one.
 *
 * No axes, no tooltip, no legend, forty pixels tall, and usually two hundred
 * of them in a table — so it is plain SVG rather than Recharts, per §9 of
 * RESEARCH.md. It is a server component: nothing here needs a browser, which
 * means it renders in the first paint of a table rather than after hydration.
 *
 * Three things it refuses to do:
 *
 *   join across a gap        `sparkGeometry` cuts the series into runs, so a
 *                            quiet hour and a dead hour do not look the same.
 *   draw an empty box        No values, or all values absent, renders an em
 *                            dash. A flat line at the bottom of the box is
 *                            what a chart of zeros looks like.
 *   be an unlabelled <svg>   `role="img"` with the extremes and the latest
 *                            value in the label, so the row is readable
 *                            without the picture.
 */

import { ABSENT, formatValue, type Unit, type Value } from "./lib/format";
import { slotStyle } from "./lib/palette";
import { sparkGeometry } from "./lib/spark";

export interface SparklineProps {
  readonly values: readonly Value[];
  readonly unit: Unit;
  /** What the line is of, for the accessible label: "cost per day". */
  readonly label: string;
  readonly width?: number;
  readonly height?: number;
  /** Palette slot; defaults to the first. */
  readonly slot?: number;
  /**
   * Share a scale across a column of sparklines. Without it every row scales
   * to itself and a row peaking at 4ms looks exactly like one peaking at 40s.
   */
  readonly domain?: readonly [number, number];
}

/** The label a screen reader gets in place of the picture. */
export function sparklineLabel(
  values: readonly Value[],
  unit: Unit,
  label: string,
): string {
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) {
    return `${label}: no values in ${values.length} ${values.length === 1 ? "bucket" : "buckets"}.`;
  }
  const min = Math.min(...present);
  const max = Math.max(...present);
  const latest = values[values.length - 1] ?? null;
  const absent = values.length - present.length;
  const gap =
    absent === 0
      ? ""
      : ` ${absent} of ${values.length} buckets reported no value and are drawn as gaps.`;
  return `${label}: ${present.length} ${present.length === 1 ? "value" : "values"}, low ${formatValue(min, unit)}, high ${formatValue(max, unit)}, latest ${formatValue(latest, unit)}.${gap}`;
}

export function Sparkline(props: SparklineProps) {
  const width = props.width ?? 96;
  const height = props.height ?? 24;
  const style = slotStyle(props.slot ?? 0);
  const geometry = sparkGeometry(props.values, {
    width,
    height,
    domain: props.domain,
  });
  const label = sparklineLabel(props.values, props.unit, props.label);

  if (!geometry.drawable) {
    return (
      <span className="text-text-faint" title={label}>
        {ABSENT}
        <span className="sr-only">{label}</span>
      </span>
    );
  }

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
      className="overflow-visible align-middle"
    >
      {geometry.paths.map((d) => (
        <path
          key={d}
          d={d}
          fill="none"
          stroke={style.color}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      {geometry.dots.map((dot) => (
        <circle key={`${dot.cx} ${dot.cy}`} cx={dot.cx} cy={dot.cy} r={1.75} fill={style.color} />
      ))}
    </svg>
  );
}
