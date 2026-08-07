/**
 * The chart primitives, and nothing else.
 *
 * Every page that draws a number should import from here rather than from
 * Recharts, because everything that makes these charts honest — the em dash
 * for an absence, the coverage note on the face of the chart, the data table,
 * the keyboard path — lives in the wrappers and not in the library.
 */

export { TimeSeriesChart } from "./time-series";
export { BarChart } from "./bar-chart";
export { HistogramChart } from "./histogram-chart";
export { Heatmap } from "./heatmap";
export { TopList } from "./top-list";
export { Sparkline } from "./sparkline";
export { QueryValue, QueryValueRow } from "./query-value";

export type { TimeSeriesProps, TimeSeriesVariant } from "./time-series";
export type { BarChartProps, BarSeries } from "./bar-chart";
export type { HistogramChartProps } from "./histogram-chart";
export type { HeatmapProps } from "./heatmap";
export type { TopListProps } from "./top-list";
export type { SparklineProps } from "./sparkline";
export type { QueryValueProps } from "./query-value";

export type { Unit, Value } from "./lib/format";
export type { Coverage, SeriesInput, Point } from "./lib/series";
export type { HeatCell } from "./lib/heatmap";
export type { RankRow, RankKey } from "./lib/rank";
export type { Better } from "./lib/delta";
export type { Range } from "./lib/zoom";
