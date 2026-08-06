"use client";

/**
 * The time chart: line, area, or stacked area, one to six series, with
 * drag-to-select and a Zoom In affordance that a keyboard can reach.
 *
 * Stacked area is a variant rather than a second component because it is the
 * same chart with `stackId` set and a different y domain, and `prepareChart`
 * already knows the one thing that actually differs — a stacked total is
 * unknown when any member is unknown, so those buckets are a gap in the whole
 * band rather than a dip. Two files would have been two chances to get that
 * wrong.
 *
 * Animation is off. That is one line instead of a `prefers-reduced-motion`
 * hook plus a media-query listener plus the state that goes with them, it is
 * correct for every reader rather than for the ones who set the preference,
 * and a chart that re-animates on every zoom step is worse than one that does
 * not. Motion was not carrying information here.
 */

import { useCallback, useEffect, useMemo, useReducer } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Symbols,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { clock, stamp } from "@/lib/time";
import { ChartFrame, notes, type LegendItem } from "./chart-frame";
import { useHatch } from "./hatch";
import { chartSummary, chartTable } from "./lib/a11y";
import { formatTick, formatValue, type Unit } from "./lib/format";
import type { Overflow } from "./lib/palette";
import {
  coverageNote,
  omittedNote,
  prepareChart,
  stackGapNote,
  type PreparedChart,
  type PreparedSeries,
  type Row,
  type SeriesInput,
} from "./lib/series";
import {
  applyView,
  canZoomIn,
  canZoomOut,
  createZoomReducer,
  describeView,
  INITIAL_ZOOM,
  type Range,
} from "./lib/zoom";

export type TimeSeriesVariant = "line" | "area" | "stacked-area";

export interface TimeSeriesProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly series: readonly SeriesInput[];
  readonly unit: Unit;
  readonly variant?: TimeSeriesVariant;
  readonly height?: number;
  /** Heading for the x column of the data table. */
  readonly xLabel?: string;
  /** Full rendering, for the tooltip and the table. */
  readonly formatX?: (x: number) => string;
  /** Short rendering, for an axis tick. */
  readonly formatXTick?: (x: number) => string;
  /** Required only when more than six series are passed; see `palette.ts`. */
  readonly overflow?: Overflow;
  readonly overflowNoun?: string;
  /**
   * Called when the reader zooms, with the range they chose or `null` for the
   * full extent. The chart re-scales itself from the data it already has; this
   * is for a caller that wants to re-query at a finer grain.
   */
  readonly onViewChange?: (view: Range | null) => void;
}

const defaultFormatX = (x: number) => stamp(new Date(x).toISOString(), "second");
const defaultFormatXTick = (x: number) => clock(new Date(x).toISOString(), "minute");

/**
 * A value whose neighbours are both absent cannot be drawn as a line, and a
 * one-row chart is the whole series in that state. Recharts asks for a dot
 * renderer per point; this one draws the series' marker shape where a segment
 * is impossible and nothing where the line already says it.
 */
function isolatedDot(series: PreparedSeries) {
  return function renderDot(props: {
    cx?: number;
    cy?: number;
    payload?: Row;
    key?: React.Key | null;
  }) {
    const x = props.payload?.x;
    if (x === undefined || !series.isolatedX.has(x) || props.cx === undefined || props.cy === undefined) {
      return <g key={props.key} />;
    }
    return (
      <Symbols
        key={props.key}
        cx={props.cx}
        cy={props.cy}
        type={series.style.shape}
        size={40}
        fill={series.style.color}
        stroke="var(--bg-raised)"
        strokeWidth={1}
      />
    );
  };
}

interface TooltipCardProps {
  readonly chart: PreparedChart;
  readonly formatX: (x: number) => string;
  /** Injected by Recharts when it clones this element. */
  readonly active?: boolean;
  readonly payload?: readonly { readonly payload?: Row }[];
}

/**
 * Built from the row rather than from Recharts' payload, because the payload
 * omits a series that has no value at this x — which would silently drop the
 * one fact the reader is hovering to find out.
 */
function TooltipCard(props: TooltipCardProps) {
  const row = props.payload?.[0]?.payload;
  if (props.active !== true || row === undefined) return null;
  return (
    <div className="rounded-md border border-border bg-bg-raised px-3 py-2 text-small shadow-lg">
      <p className="m-0 mb-1 text-text-dim">{props.formatX(row.x)}</p>
      <ul className="m-0 list-none p-0">
        {props.chart.series.map((s) => (
          <li key={s.id} className="flex items-baseline justify-between gap-4">
            <span className="flex items-center gap-2 text-text-dim">
              <span
                aria-hidden="true"
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: s.style.color }}
              />
              {s.label}
            </span>
            <span className="font-mono text-text">
              {formatValue(row[s.id] ?? null, props.chart.unit)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TimeSeriesChart(props: TimeSeriesProps) {
  const hatch = useHatch();
  const variant = props.variant ?? "line";
  const stacked = variant === "stacked-area";
  const formatX = props.formatX ?? defaultFormatX;
  const formatXTick = props.formatXTick ?? defaultFormatXTick;
  const xLabel = props.xLabel ?? "time";

  const chart = useMemo(
    () =>
      prepareChart(props.series, {
        unit: props.unit,
        overflow: props.overflow,
        overflowNoun: props.overflowNoun,
        stack: stacked,
      }),
    [props.series, props.unit, props.overflow, props.overflowNoun, stacked],
  );

  const xs = useMemo(() => chart.rows.map((r) => r.x), [chart.rows]);
  const reducer = useMemo(() => createZoomReducer(xs), [xs]);
  const [zoom, dispatch] = useReducer(reducer, INITIAL_ZOOM);

  const visible = useMemo(() => applyView(chart.rows, zoom.view), [chart.rows, zoom.view]);

  const onViewChange = props.onViewChange;
  useEffect(() => {
    onViewChange?.(zoom.view);
  }, [onViewChange, zoom.view]);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowRight":
      case "Home":
      case "End":
        event.preventDefault();
        dispatch({ type: "key", key: event.key, extend: event.shiftKey });
        return;
      case "Enter":
        event.preventDefault();
        dispatch({ type: "zoom-in" });
        return;
      case "Escape":
        dispatch({ type: "clear" });
        return;
      default:
    }
  }, []);

  const legend: LegendItem[] = chart.series.map((s) => ({
    id: s.id,
    label: s.label,
    style: s.style,
    mark: variant === "line" ? "line" : "fill",
  }));

  const summary = chartSummary(chart, {
    kind: stacked ? "Stacked area chart" : variant === "area" ? "Area chart" : "Line chart",
    title: props.title,
    xLabel,
    formatX,
  });

  const cursorX = zoom.cursor === null ? null : (xs[zoom.cursor] ?? null);

  return (
    <ChartFrame
      title={props.title}
      subtitle={props.subtitle}
      notes={notes(
        [coverageNote(chart), "caveat"],
        [stackGapNote(chart), "caveat"],
        [omittedNote(chart), "info"],
      )}
      legend={legend}
      summary={summary}
      table={chartTable(chart, { title: props.title, xLabel, formatX })}
      state={chart.state}
      bucketCount={chart.rows.length}
      actions={
        <>
          <ChartButton
            onClick={() => dispatch({ type: "zoom-in" })}
            disabled={!canZoomIn(zoom)}
          >
            Zoom in
          </ChartButton>
          <ChartButton
            onClick={() => dispatch({ type: "zoom-out" })}
            disabled={!canZoomOut(zoom)}
          >
            Zoom out
          </ChartButton>
        </>
      }
    >
      <div
        role="application"
        aria-roledescription="interactive chart"
        aria-label={`${props.title}. Arrow keys move the cursor, Shift and arrow keys select a range, Enter zooms in, Escape clears the selection.`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        style={{ height: props.height ?? 260 }}
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={visible}
            margin={{ top: 8, right: 8, bottom: 4, left: 4 }}
            onMouseDown={(next) => {
              if (typeof next.activeLabel === "number") {
                dispatch({ type: "pointer-down", x: next.activeLabel });
              }
            }}
            onMouseMove={(next) => {
              if (typeof next.activeLabel === "number") {
                dispatch({ type: "pointer-move", x: next.activeLabel });
              }
            }}
            onMouseUp={(next) => {
              if (typeof next.activeLabel === "number") {
                dispatch({ type: "pointer-up", x: next.activeLabel });
              }
            }}
          >
            {hatch.defs}
            <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" vertical={false} />
            <XAxis
              dataKey="x"
              type="number"
              domain={["dataMin", "dataMax"]}
              tickFormatter={formatXTick}
              stroke="var(--text-faint)"
              tick={{ fontSize: 11 }}
              tickLine={false}
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
              cursor={{ stroke: "var(--text-faint)", strokeDasharray: "3 3" }}
              content={<TooltipCard chart={chart} formatX={formatX} />}
            />
            {chart.series.map((s, i) =>
              variant === "line" ? (
                <Line
                  key={s.id}
                  type="linear"
                  dataKey={s.id}
                  name={s.label}
                  stroke={s.style.color}
                  strokeWidth={2}
                  strokeDasharray={s.style.dash ?? undefined}
                  dot={isolatedDot(s)}
                  activeDot={{ r: 3 }}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              ) : (
                <Area
                  key={s.id}
                  type="linear"
                  dataKey={s.id}
                  name={s.label}
                  stackId={stacked ? "stack" : undefined}
                  stroke={s.style.color}
                  strokeWidth={2}
                  fill={hatch.fill(i)}
                  fillOpacity={1}
                  dot={isolatedDot(s)}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              ),
            )}
            {zoom.selection === null ? null : (
              <ReferenceArea
                x1={zoom.selection.from}
                x2={zoom.selection.to}
                fill="var(--accent)"
                fillOpacity={0.15}
                stroke="var(--accent)"
                strokeOpacity={0.5}
              />
            )}
            {cursorX === null || zoom.dragging ? null : (
              <ReferenceLine x={cursorX} stroke="var(--accent)" strokeDasharray="4 2" />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p aria-live="polite" className="sr-only">
        {describeView(zoom.view, visible.length, chart.rows.length, formatX)}
      </p>
    </ChartFrame>
  );
}

/**
 * The one button style in this directory. It is here rather than in a `ui/`
 * directory because it is the only button the charts draw and a second file
 * for it would be a file nothing else imports.
 */
export function ChartButton(props: {
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly pressed?: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      aria-pressed={props.pressed}
      className="rounded-sm border border-border bg-bg px-2 py-1 text-micro text-text-dim hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-40 aria-pressed:border-accent aria-pressed:text-text"
    >
      {props.children}
    </button>
  );
}
