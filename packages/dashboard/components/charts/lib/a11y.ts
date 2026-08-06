/**
 * The numbers, in a form that is not a picture.
 *
 * An `<svg>` is opaque to a screen reader, to a text browser, to anyone
 * copying a figure into a ticket, and to a person who simply cannot read a
 * 3-pixel difference in bar height. Every primitive in this directory renders
 * the output of this module inside a `<details>` next to the chart, so the
 * underlying values are always one keypress away and always in the DOM. That
 * is cheap here and expensive later, which is why it is here.
 *
 * `<details>` rather than a visually-hidden table because it serves both
 * audiences with one implementation: assistive technology reaches the table
 * either way, and a sighted reader gets a disclosure they can open instead of
 * a table they cannot see and cannot copy.
 *
 * Every cell goes through the same formatter the chart uses, so an em dash in
 * the table means exactly what a gap in the line means.
 */

import { formatValue } from "./format";
import {
  coverageNote,
  omittedNote,
  stackGapNote,
  type PreparedChart,
} from "./series";

export interface DataTable {
  readonly caption: string;
  readonly columns: string[];
  readonly rows: string[][];
}

export interface TableOptions {
  readonly title: string;
  /** Heading for the x column: "time", "duration", "hour". */
  readonly xLabel: string;
  readonly formatX: (x: number) => string;
}

export function chartTable(chart: PreparedChart, options: TableOptions): DataTable {
  const columns = [options.xLabel, ...chart.series.map((s) => s.label)];
  const rows = chart.rows.map((row) => [
    options.formatX(row.x),
    ...chart.series.map((s) => formatValue(row[s.id] ?? null, chart.unit)),
  ]);
  return { caption: `${options.title}: underlying values`, columns, rows };
}

/**
 * The one sentence read out when focus lands on the chart. It states the
 * shape, the extent, and — before anything else a reader might act on — every
 * caveat the chart is carrying, because a caveat that only exists in a
 * tooltip does not exist for a keyboard user at all.
 */
export function chartSummary(
  chart: PreparedChart,
  options: TableOptions & { readonly kind: string },
): string {
  const head = `${options.kind}: ${options.title}.`;
  if (chart.state === "no-rows") return `${head} No data in this range.`;
  if (chart.state === "all-absent") {
    return `${head} ${chart.rows.length} ${options.xLabel} buckets, none of which reported a value.`;
  }
  const extent =
    chart.xDomain === null
      ? ""
      : ` from ${options.formatX(chart.xDomain[0])} to ${options.formatX(chart.xDomain[1])}`;
  const series =
    chart.series.length === 1
      ? (chart.series[0]?.label ?? "one series")
      : `${chart.series.length} series (${chart.series.map((s) => s.label).join(", ")})`;
  const notes = [coverageNote(chart), omittedNote(chart), stackGapNote(chart)]
    .filter((n): n is string => n !== null)
    .join(" ");
  return `${head} ${series} over ${chart.rows.length} buckets${extent}.${notes === "" ? "" : ` ${notes}`}`;
}
