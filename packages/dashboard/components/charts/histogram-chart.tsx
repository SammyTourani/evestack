"use client";

/**
 * A distribution: how long turns took, how big tool results were.
 *
 * It is a thin thing on purpose. Binning is `lib/histogram.ts`, drawing bars
 * is `BarChart`, and what remains here is the one fact a histogram normally
 * discards — the values that had no measurement. Those cannot be binned and
 * must not be dropped in silence: a duration histogram over 500 turns where
 * 480 never reported one is a picture of twenty turns.
 *
 * The bins are the "nice" 1–2–5 edges rather than the data's exact range, so
 * two histograms of adjacent windows can be compared.
 */

import { useMemo } from "react";

import { BarChart } from "./bar-chart";
import type { FrameNote } from "./chart-frame";
import { formatValue, type Unit, type Value } from "./lib/format";
import { absentNote, histogram } from "./lib/histogram";

export interface HistogramChartProps {
  readonly title: string;
  readonly subtitle?: string;
  /** The raw measurements. `null` entries are counted, not discarded. */
  readonly values: readonly Value[];
  /** The unit of the measurements, i.e. of the x axis. */
  readonly unit: Unit;
  /** What each value is one of: "turns", "tool calls". */
  readonly noun?: string;
  readonly bins?: number;
  readonly height?: number;
}

export function HistogramChart(props: HistogramChartProps) {
  const noun = props.noun ?? "values";
  const bins = useMemo(
    () => histogram(props.values, { bins: props.bins }),
    [props.values, props.bins],
  );

  const categories = bins.bins.map((b) =>
    b.from === b.to
      ? formatValue(b.from, props.unit)
      : `${formatValue(b.from, props.unit)}–${formatValue(b.to, props.unit)}`,
  );

  const extra: FrameNote[] = [];
  const missing = absentNote(bins, noun);
  if (missing !== null) extra.push({ text: missing, tone: "caveat" });

  return (
    <BarChart
      title={props.title}
      subtitle={props.subtitle}
      categories={categories}
      series={[{ id: "count", label: `${noun} in bin`, values: bins.bins.map((b) => b.count) }]}
      // The bars count occurrences; the bin labels carry the measured unit.
      unit="count"
      xLabel={props.unit === "duration" ? "duration" : "bucket"}
      height={props.height}
      extraNotes={extra}
    />
  );
}
