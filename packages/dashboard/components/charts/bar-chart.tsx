"use client";

/**
 * Bars over categories: spend by model, calls by tool, turns by outcome.
 * Grouped or stacked.
 *
 * The interesting problem here is that a bar chart cannot show an absence.
 * A measured zero draws a bar of height zero; an unmeasured category draws no
 * bar. Both are the same empty column, so the chart that is most often used to
 * compare things is the one least able to say "I do not know about this one".
 *
 * Two things fix it, and neither is a tooltip:
 *
 *   `minPointSize={2}` gives a measured zero a visible two-pixel stub, so a
 *   real zero is a mark rather than an absence of one.
 *
 *   `absentPointNote` names the categories with no value, on the face of the
 *   chart, in the frame. The data table shows them as em dashes.
 *
 * Categories are passed as labels and carried through the pipeline as their
 * index, which is what lets this reuse `prepareChart` — the six-slot fold, the
 * two empty states, the coverage note and the accessible table are all the
 * same code the time chart runs.
 */

import { useMemo } from "react";
import {
  Bar,
  BarChart as RechartsBarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { ChartFrame, notes, type FrameNote, type LegendItem } from "./chart-frame";
import { useHatch } from "./hatch";
import { chartSummary, chartTable } from "./lib/a11y";
import { formatTick, formatValue, type Unit, type Value } from "./lib/format";
import type { Overflow } from "./lib/palette";
import {
  absentPointNote,
  coverageNote,
  omittedNote,
  prepareChart,
  stackGapNote,
  type Coverage,
  type PreparedChart,
  type Row,
} from "./lib/series";

export interface BarSeries {
  readonly id: string;
  readonly label: string;
  /** One value per category, in category order. `null` is an absence. */
  readonly values: readonly Value[];
  readonly coverage?: Coverage | null;
}

export interface BarChartProps {
  readonly title: string;
  readonly subtitle?: string;
  /** The x axis, in the order they should appear. */
  readonly categories: readonly string[];
  readonly series: readonly BarSeries[];
  readonly unit: Unit;
  readonly stacked?: boolean;
  readonly height?: number;
  /** Heading for the x column of the data table: "model", "tool". */
  readonly xLabel?: string;
  /** Notes a caller computed itself; the histogram uses this. */
  readonly extraNotes?: readonly FrameNote[];
  readonly overflow?: Overflow;
  readonly overflowNoun?: string;
}

interface BarTooltipProps {
  readonly chart: PreparedChart;
  readonly formatX: (x: number) => string;
  readonly active?: boolean;
  readonly payload?: readonly { readonly payload?: Row }[];
}

function BarTooltip(props: BarTooltipProps) {
  const row = props.payload?.[0]?.payload;
  if (props.active !== true || row === undefined) return null;
  return (
    <div className="rounded-md border border-border bg-bg-raised px-3 py-2 text-small shadow-lg">
      <p className="m-0 mb-1 text-text-dim">{props.formatX(row.x)}</p>
      <ul className="m-0 list-none p-0">
        {props.chart.series.map((s) => (
          <li key={s.id} className="flex items-baseline justify-between gap-4">
            <span className="text-text-dim">{s.label}</span>
            <span className="font-mono text-text">
              {formatValue(row[s.id] ?? null, props.chart.unit)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function BarChart(props: BarChartProps) {
  const hatch = useHatch();
  const stacked = props.stacked ?? false;
  const xLabel = props.xLabel ?? "category";
  const categories = props.categories;
  const formatX = useMemo(
    () => (x: number) => categories[x] ?? String(x),
    [categories],
  );

  const chart = useMemo(
    () =>
      prepareChart(
        props.series.map((s) => ({
          id: s.id,
          label: s.label,
          coverage: s.coverage,
          points: categories.map((_, i) => ({ x: i, y: s.values[i] ?? null })),
        })),
        {
          unit: props.unit,
          overflow: props.overflow,
          overflowNoun: props.overflowNoun,
          stack: stacked,
        },
      ),
    [props.series, props.unit, props.overflow, props.overflowNoun, stacked, categories],
  );

  const legend: LegendItem[] = chart.series.map((s) => ({
    id: s.id,
    label: s.label,
    style: s.style,
    mark: "fill",
  }));

  return (
    <ChartFrame
      title={props.title}
      subtitle={props.subtitle}
      notes={[
        ...notes(
          [coverageNote(chart), "caveat"],
          [absentPointNote(chart, formatX), "caveat"],
          [stackGapNote(chart), "caveat"],
          [omittedNote(chart), "info"],
        ),
        ...(props.extraNotes ?? []),
      ]}
      legend={legend}
      summary={chartSummary(chart, {
        kind: stacked ? "Stacked bar chart" : "Bar chart",
        title: props.title,
        xLabel,
        formatX,
      })}
      table={chartTable(chart, { title: props.title, xLabel, formatX })}
      state={chart.state}
      bucketCount={chart.rows.length}
    >
      <div style={{ height: props.height ?? 260 }}>
        <ResponsiveContainer width="100%" height="100%">
          <RechartsBarChart data={chart.rows} margin={{ top: 8, right: 8, bottom: 4, left: 4 }}>
            {hatch.defs}
            <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" vertical={false} />
            <XAxis
              dataKey="x"
              type="category"
              tickFormatter={formatX}
              stroke="var(--text-faint)"
              tick={{ fontSize: 11 }}
              tickLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tickFormatter={(v: number) => formatTick(v, chart.unit)}
              stroke="var(--text-faint)"
              tick={{ fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={56}
            />
            <Tooltip
              cursor={{ fill: "var(--bg-hover)" }}
              content={<BarTooltip chart={chart} formatX={formatX} />}
            />
            {chart.series.map((s, i) => (
              <Bar
                key={s.id}
                dataKey={s.id}
                name={s.label}
                stackId={stacked ? "stack" : undefined}
                fill={hatch.fill(i)}
                stroke={s.style.color}
                // A measured zero gets two pixels so it is a mark rather than
                // the same nothing an absent category draws.
                minPointSize={2}
                isAnimationActive={false}
              />
            ))}
          </RechartsBarChart>
        </ResponsiveContainer>
      </div>
    </ChartFrame>
  );
}
