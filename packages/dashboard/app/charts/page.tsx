"use client";

/**
 * The chart primitives, on one page, in development only.
 *
 * It exists for one reason that a test cannot cover: Recharts renders nothing
 * without a browser, so `renderToStaticMarkup` proves the frame, the notes,
 * the legend, the table and every ARIA attribute, and proves nothing at all
 * about whether a line appears. This route is where that gets looked at — and
 * it is also the only caller these components have until the pages that use
 * them land, which is what keeps "does this actually work" from being a
 * question nobody can answer for a wave.
 *
 * Every fixture below is deliberately unpleasant: a series with a hole in it,
 * a lone point with no neighbour, a model with no price, a metric over 3% of
 * the fleet, a category that reported nothing next to one that reported zero,
 * a heatmap with dead cells. A gallery of clean data proves the easy half.
 *
 * `notFound()` in production: this is a development surface, not a feature.
 */

import { notFound } from "next/navigation";
import { useState } from "react";

import {
  BarChart,
  Heatmap,
  HistogramChart,
  QueryValue,
  QueryValueRow,
  Sparkline,
  TimeSeriesChart,
  TopList,
  type HeatCell,
  type Range,
} from "@/components/charts";

/** A fixed sequence, so the page looks the same on every reload. */
function pseudoRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

const HOUR = 3_600_000;
const START = Date.UTC(2026, 6, 6, 0, 0, 0);
const BUCKETS = 30;
const random = pseudoRandom(20260806);

/** Turns per hour, with a hole where the exporter was down. */
const turns = Array.from({ length: BUCKETS }, (_, i) => ({
  x: START + i * HOUR,
  y: i >= 11 && i <= 13 ? null : Math.round(40 + 30 * random()),
}));

/** Errors, mostly zero, spiking in one window: zero is a value, not a gap. */
const errors = Array.from({ length: BUCKETS }, (_, i) => ({
  x: START + i * HOUR,
  y: i >= 18 && i <= 21 ? Math.round(4 + 8 * random()) : 0,
}));

/** One measurement, alone, in the middle of nothing: a line cannot draw it. */
const cancelled = Array.from({ length: BUCKETS }, (_, i) => ({
  x: START + i * HOUR,
  y: i === 16 ? 3 : null,
}));

const costByModel = ["sonnet", "gpt-5-mini", "ollama/qwen3"].map((model, slot) => ({
  id: model,
  label: model,
  points: Array.from({ length: BUCKETS }, (_, i) => ({
    x: START + i * HOUR,
    y: slot === 2 ? 0 : Number(((slot === 0 ? 0.4 : 0.12) * random()).toFixed(4)),
  })),
}));

const durations = Array.from({ length: 400 }, (_, i) =>
  i % 9 === 0 ? null : Math.round(500 + 40_000 * random() ** 3),
);

const heatCells: HeatCell[] = [];
for (const day of ["mon", "tue", "wed", "thu", "fri"]) {
  for (let hour = 8; hour <= 18; hour += 2) {
    const label = `${String(hour).padStart(2, "0")}:00`;
    // Thursday afternoon the agent was not running at all: no cells, which is
    // not the same as zero errors.
    if (day === "thu" && hour >= 14) continue;
    heatCells.push({ row: day, col: label, value: Math.round(6 * random() ** 2) });
  }
}

const tools = [
  { id: "read_file", label: "read_file", value: 412, errors: 2, total: 412, durationMs: 14 },
  { id: "bash", label: "bash", value: 208, errors: 31, total: 208, durationMs: 2_400 },
  { id: "web_search", label: "web_search", value: 96, errors: 0, total: 96, durationMs: 8_100 },
  { id: "write_file", label: "write_file", value: 74, errors: 1, total: 74, durationMs: 21 },
  { id: "custom_tool", label: "custom_tool", value: 5, errors: null, total: null, durationMs: null },
];

export default function ChartGallery() {
  if (process.env.NODE_ENV === "production") notFound();
  const [view, setView] = useState<Range | null>(null);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="m-0 text-title font-medium text-text">Chart primitives</h1>
        <p className="m-0 text-small text-text-dim">
          Development only. Every fixture here is awkward on purpose: gaps, lone points, unpriced
          models, partial coverage, and cells nobody reported.
        </p>
      </header>

      <QueryValueRow>
        <QueryValue
          label="Turns"
          unit="count"
          value={1_922}
          previous={1_704}
          previousLabel="the previous 30 days"
          better="neutral"
          spark={turns.map((p) => p.y)}
        />
        <QueryValue
          label="Spend"
          unit="cost"
          value={11.05}
          previous={9.4}
          previousLabel="the previous 30 days"
          better="lower"
        />
        <QueryValue label="acme/experimental-v1 spend" unit="cost" value={0} priced={false} />
        <QueryValue
          label="TTFT p50"
          unit="duration"
          value={412}
          previous={508}
          better="lower"
          coverage={{ observed: 41, total: 1_203, noun: "turns" }}
        />
      </QueryValueRow>

      <TimeSeriesChart
        title="Turns, errors and cancellations"
        subtitle="Drag across the plot, or focus it and hold Shift with the arrow keys, then Zoom in."
        unit="count"
        onViewChange={setView}
        series={[
          { id: "turns", label: "turns", points: turns },
          { id: "errors", label: "errors", points: errors },
          { id: "cancelled", label: "cancelled", points: cancelled },
        ]}
      />
      <p className="m-0 text-small text-text-dim">
        Zoom callback:{" "}
        {view === null
          ? "the full extent"
          : `${new Date(view.from).toISOString()} → ${new Date(view.to).toISOString()}`}
      </p>

      <TimeSeriesChart
        title="Cost by model"
        subtitle="Stacked. ollama/qwen3 is local inference, so its zero is a measured zero."
        unit="cost"
        variant="stacked-area"
        overflow="sum"
        overflowNoun="model"
        series={costByModel}
      />

      <BarChart
        title="Spend by model"
        xLabel="model"
        unit="cost"
        categories={["sonnet", "gpt-5-mini", "ollama/qwen3", "acme/experimental-v1"]}
        series={[{ id: "spend", label: "spend", values: [8.14, 2.91, 0, null] }]}
      />

      <HistogramChart
        title="Turn duration"
        subtitle="Nice bin edges, so two windows can be compared."
        unit="duration"
        noun="turns"
        values={durations}
      />

      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(320px,1fr))]">
        <Heatmap
          title="Errors by day and hour"
          subtitle="Thursday afternoon has no cells at all."
          unit="count"
          rowLabel="day"
          colLabel="hour"
          rowKeys={["mon", "tue", "wed", "thu", "fri"]}
          cells={heatCells}
        />
        <TopList
          title="Tools"
          subtitle="Sort by error rate or duration. custom_tool recorded neither."
          unit="count"
          valueLabel="calls"
          durationLabel="p95"
          rows={tools}
        />
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="m-0 text-section font-medium text-text">Sparklines in a table</h2>
        <table className="w-full border-collapse text-small">
          <thead>
            <tr>
              <th scope="col" className="py-1 pr-3 text-left font-medium text-text-dim">
                series
              </th>
              <th scope="col" className="py-1 pr-3 text-left font-medium text-text-dim">
                last 30 hours
              </th>
            </tr>
          </thead>
          <tbody>
            {[
              { label: "turns", values: turns.map((p) => p.y) },
              { label: "errors", values: errors.map((p) => p.y) },
              { label: "cancelled", values: cancelled.map((p) => p.y) },
              { label: "nothing measured", values: [null, null, null] },
            ].map((row, slot) => (
              <tr key={row.label} className="border-t border-border">
                <td className="py-1 pr-3 text-text">{row.label}</td>
                <td className="py-1 pr-3">
                  <Sparkline label={row.label} unit="count" values={row.values} slot={slot} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="m-0 text-section font-medium text-text">The three empties</h2>
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(300px,1fr))]">
          <TimeSeriesChart title="Zero rows" unit="count" height={160} series={[]} />
          <TimeSeriesChart
            title="One row"
            unit="count"
            height={160}
            series={[{ id: "a", label: "turns", points: [{ x: START, y: 7 }] }]}
          />
          <TimeSeriesChart
            title="Every value absent"
            unit="count"
            height={160}
            series={[
              {
                id: "a",
                label: "turns",
                points: [
                  { x: START, y: null },
                  { x: START + HOUR, y: null },
                ],
              },
            ]}
          />
        </div>
      </section>
    </div>
  );
}
