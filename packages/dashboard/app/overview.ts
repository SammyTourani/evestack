/**
 * The queries behind the front door.
 *
 * Every one of these goes through `lib/metrics.ts` rather than writing its own
 * SQL, which is the whole point of having shipped a query API: a chart here is
 * a config object, and a new one is not a code change in a data layer. If
 * something on the overview cannot be expressed as a metric query, that is a
 * gap in the catalog and should be fixed there, not routed around here.
 *
 * ── Why the period-over-period pair is two queries, not one ──────────────────
 *
 * A delta needs the same measure over the window before this one. Expressing
 * that as a single query means a CASE over two date ranges inside every
 * aggregate, which the catalog deliberately cannot emit — it would put a
 * date literal inside a measure. Two queries with different `from`/`to` is the
 * honest shape, and at these row counts it costs nothing measurable.
 *
 * ── Coverage is carried, not dropped ────────────────────────────────────────
 *
 * `runMetricQuery` returns how many rows contributed to each measure next to
 * the value. TTFT exists on roughly a fifth of turns because spans are opt-in,
 * so a TTFT tile that does not say so is the exact lie `span_coverage` was
 * added to prevent. Every tile below forwards its coverage to the component,
 * which renders the note.
 */

// Relative, not `@/`: the alias only resolves through the bundler, and this
// module holds the arithmetic behind every tile on the front door — the part
// most worth being able to run under `node --test` without one. Same reason
// components/ui/format.ts gives for its own imports.
import { MetricQueryError, runMetricQuery, type MetricResult } from "../lib/metrics";

/** Windows the overview offers, in hours. Matches lib/monitors.ts's set. */
export const OVERVIEW_WINDOWS = [1, 6, 12, 24, 24 * 7, 24 * 30] as const;
export type OverviewWindow = (typeof OVERVIEW_WINDOWS)[number];

export function windowLabel(hours: number): string {
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return days === 1 ? "24h" : `${days}d`;
}

/**
 * Bucket width for the time series.
 *
 * Chosen so a window draws between 12 and 48 buckets. Fewer and a spike hides
 * inside a bucket; more and the chart is noise at the width it renders. The
 * catalog only accepts fixed-width granularities — `lib/metrics.ts` explains
 * that a month is not a fixed number of seconds — so this list is deliberately
 * short of anything calendar-shaped.
 */
function granularityFor(hours: number): "minute" | "hour" | "day" {
  if (hours <= 6) return "minute";
  if (hours <= 24 * 7) return "hour";
  return "day";
}

export interface Window {
  readonly hours: number;
  readonly from: string;
  readonly to: string;
  /** The window of the same length immediately before this one. */
  readonly prevFrom: string;
  readonly prevTo: string;
  readonly granularity: "minute" | "hour" | "day";
}

export function makeWindow(hours: number, now = Date.now()): Window {
  const ms = hours * 3_600_000;
  return {
    hours,
    from: new Date(now - ms).toISOString(),
    to: new Date(now).toISOString(),
    prevFrom: new Date(now - 2 * ms).toISOString(),
    prevTo: new Date(now - ms).toISOString(),
    granularity: granularityFor(hours),
  };
}

/* -------------------------------------------------------------------------- */

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** One measure over one window, plus the same measure over the one before. */
export interface Headline {
  readonly value: number | null;
  readonly previous: number | null;
  readonly spark: readonly (number | null)[];
  readonly coverage: { readonly rows: number; readonly of: number };
  /**
   * Why `value` is null, when it is.
   *
   * `null` is ambiguous and the ambiguity is the whole problem: it means "the
   * window is empty" and "the query failed" equally well, and those are
   * opposite facts. Caught live — with Postgres down and five real turns on
   * disk, every tile rendered an em dash, which reads as "your agent did
   * nothing" rather than "this dashboard cannot see". Exactly the class of
   * defect this project has spent forty commits removing from other people's
   * code, built here by me.
   */
  readonly failed: boolean;

  /**
   * WHY the current-window query was rejected, when it was.
   *
   * `failed` alone says the tile is blind; it does not say what to do about it,
   * and the page has to tell someone. Discarding the reason meant app/page.tsx
   * had nothing real to hand DatabaseError, so it synthesised
   * `new Error("Every measure on this page failed to read from Postgres.")` —
   * true, and stripped of the one detail that distinguishes a stopped container
   * from a database that is running and has never been bootstrapped.
   * describeDbFailure() can tell those apart from a pg error code and cannot
   * tell them apart from a sentence, so the overview said "Can't reach the
   * database" while /monitors and /evals, reading the same dead database in the
   * same second, correctly said "The database has no agent schema yet".
   */
  readonly error?: unknown;
}

const EMPTY: Headline = { value: null, previous: null, spark: [], coverage: { rows: 0, of: 0 }, failed: false };

/** Ask `headline` for the row count rather than an aggregate. See its body. */
export const ROWS = "__rows__";

/**
 * A headline number, its predecessor, and its trend.
 *
 * Three queries rather than one: the value, the same measure over the previous
 * window, and a bucketed series for the sparkline. They are issued together and
 * a failure in any one degrades that part to null rather than taking the tile
 * down — a dashboard whose spend tile is missing is still worth looking at.
 */
export async function headline(
  window: Window,
  measure: string,
  aggregation: string,
  options: { view?: string; filters?: readonly unknown[] } = {},
): Promise<Headline> {
  const view = options.view ?? "turns";
  const filters = options.filters ?? [];

  /*
   * ROWS is a sentinel, not a measure. "How many turns" is the row count of the
   * group, which `MetricRow.rows` already carries — the catalog has no `turns`
   * measure, and `count` of any real one counts the rows where THAT column is
   * non-null. `count(duration)` would silently answer "how many turns finished",
   * which is a different and smaller number, and would make the headline
   * disagree with the sessions list for exactly the unfinished runs a reader is
   * most likely to be looking for.
   */
  const countsRows = measure === ROWS;
  const key = countsRows ? "rows" : `${aggregation}_${measure}`;
  const measures = countsRows
    ? [{ measure: "duration", aggregation: "count" }]
    : [{ measure, aggregation }];

  const base = { view, measures, filters };

  const [current, previous, series] = await Promise.allSettled([
    runMetricQuery({ ...base, timeDimension: { from: window.from, to: window.to } }),
    runMetricQuery({ ...base, timeDimension: { from: window.prevFrom, to: window.prevTo } }),
    runMetricQuery({
      ...base,
      timeDimension: { from: window.from, to: window.to, granularity: window.granularity },
    }),
  ]);

  const one = (r: PromiseSettledResult<MetricResult>): MetricResult | null =>
    r.status === "fulfilled" ? r.value : null;

  const cur = one(current);
  // Only the CURRENT window decides this. A missing previous window is an
  // ordinary fact about a new install; a missing current one means we are blind.
  const failed = current.status === "rejected";
  const row = cur?.data[0];
  const cov = cur?.coverage.byMeasure[key];

  return {
    value: row === undefined ? null : num(row[key]),
    previous: (() => {
      const p = one(previous)?.data[0];
      return p === undefined ? null : num(p[key]);
    })(),
    spark: (one(series)?.data ?? []).map((r) => num(r[key])),
    failed,
    error: current.status === "rejected" ? current.reason : undefined,
    /*
     * `{rows, of}` is the shape lib/metrics.ts returns, and reading the wrong
     * key here is not a cosmetic bug: the fallback is `matchedRows`, so a
     * mis-read makes every tile claim it was computed over the whole window.
     * Measured on the seeded month, p95 TTFT is computed from 359 of 1,922
     * turns because spans are opt-in — a tile reporting 1,922 of 1,922 would
     * be the precise lie `span_coverage` exists to prevent, printed on the
     * front door. No `??` fallback to matchedRows for that reason: if the
     * measure did not report coverage, the honest answer is zero, not "all".
     */
    coverage: countsRows
      ? // A row count is complete by construction: the rows ARE the population,
        // so there is nothing for it to be partial over. Without this branch the
        // sentinel has no `byMeasure` entry, reads 0, and the tile claims it
        // counted none of 1,922 turns while displaying 1,922.
        { rows: cur?.coverage.matchedRows ?? 0, of: cur?.coverage.matchedRows ?? 0 }
      : { rows: cov?.rows ?? 0, of: cov?.of ?? cur?.coverage.matchedRows ?? 0 },
  };
}

/** A bucketed series split by a dimension, shaped for TimeSeriesChart. */
export async function stacked(
  window: Window,
  measure: string,
  aggregation: string,
  dimension: string,
  options: { view?: string } = {},
): Promise<{ series: { id: string; label: string; points: { x: number; y: number | null }[] }[]; truncated: boolean }> {
  let result: MetricResult;
  try {
    result = await runMetricQuery({
      view: options.view ?? "turns",
      measures: measure === ROWS ? [{ measure: "duration", aggregation: "count" }] : [{ measure, aggregation }],
      dimensions: [dimension],
      timeDimension: { from: window.from, to: window.to, granularity: window.granularity },
    });
  } catch (error) {
    // Same rule as `ranked` below: a query this file built wrong is a bug and
    // must be seen; a database that is unreachable degrades to an empty chart.
    if (error instanceof MetricQueryError) throw error;
    return { series: [], truncated: false };
  }

  const key = measure === ROWS ? "rows" : `${aggregation}_${measure}`;
  // Group by dimension value, keeping every bucket the query returned so a
  // series with a hole draws a gap rather than closing over it.
  const byGroup = new Map<string, Map<number, number | null>>();
  const allX = new Set<number>();

  for (const row of result.data) {
    if (row.time === undefined) continue;
    const x = Date.parse(row.time);
    allX.add(x);
    // A densified bucket carries the dimension as null; label it once, here,
    // rather than letting six charts each invent their own word for it.
    const raw = row[dimension];
    const group = raw === null || raw === undefined ? "(none)" : String(raw);
    const points = byGroup.get(group) ?? new Map<number, number | null>();
    points.set(x, num(row[key]));
    byGroup.set(group, points);
  }

  const xs = [...allX].sort((a, b) => a - b);
  const series = [...byGroup.entries()]
    .map(([group, points]) => ({
      id: group,
      label: group,
      points: xs.map((x) => ({ x, y: points.get(x) ?? null })),
      total: [...points.values()].reduce<number>((sum, v) => sum + (v ?? 0), 0),
    }))
    // Largest first, so the palette's most legible colours land on the series a
    // reader is most likely to be looking for.
    .sort((a, b) => b.total - a.total)
    .map(({ total: _total, ...rest }) => rest);

  return { series, truncated: result.truncated };
}

export interface Ranked {
  readonly id: string;
  readonly label: string;
  readonly value: number | null;
  readonly errors?: number | null;
  readonly total?: number | null;
  readonly durationMs?: number | null;
}

/** A top-N list over one dimension, shaped for TopList. */
export async function ranked(
  window: Window,
  options: {
    view?: string;
    dimension: string;
    measure: string;
    aggregation: string;
    withFailures?: boolean;
    withDuration?: { measure: string; aggregation: string };
    limit?: number;
  },
): Promise<Ranked[]> {
  const measures: { measure: string; aggregation: string }[] = [
    options.measure === ROWS
      ? { measure: "duration", aggregation: "count" }
      : { measure: options.measure, aggregation: options.aggregation },
  ];
  if (options.withFailures) measures.push({ measure: "failure_rate", aggregation: "avg" });
  if (options.withDuration) measures.push(options.withDuration);

  const valueKey = options.measure === ROWS ? "rows" : `${options.aggregation}_${options.measure}`;

  let result: MetricResult;
  try {
    result = await runMetricQuery({
      view: options.view ?? "turns",
      measures,
      dimensions: [options.dimension],
      timeDimension: { from: window.from, to: window.to },
      // `rows` is orderable by that name; the sentinel is not a measure and has
      // no `agg_measure` key to sort on.
      orderBy: [{ field: valueKey, direction: "desc" }],
      limit: options.limit ?? 8,
      // A bounded ordered list is what this function IS, so it says so and the
      // catalog can keep refusing high-cardinality dimensions on chart axes.
      // Without it /costs' "most expensive sessions" compiled to a throw.
      topN: true,
    });
  } catch (error) {
    // A malformed query is a bug in this file, not a condition of the data, and
    // returning [] for one renders "Nothing to rank" — indistinguishable from a
    // quiet month. That is how the /costs panel stayed empty on every install
    // since it shipped: the dimension was refused, the error became an empty
    // array, and the UI had a sentence ready for it.
    //
    // Runtime failures still degrade, because a chart is not worth taking a page
    // down for. MetricQueryError is deterministic and reachable in CI, so it is
    // raised where someone will see it.
    if (error instanceof MetricQueryError) throw error;
    return [];
  }

  const durationKey = options.withDuration
    ? `${options.withDuration.aggregation}_${options.withDuration.measure}`
    : null;

  return result.data.map((row) => {
    const raw = row[options.dimension];
    const label = raw === null || raw === undefined ? "(none)" : String(raw);
    const rate = options.withFailures ? num(row.avg_failure_rate) : null;
    /*
     * The denominator is the measure's COVERAGE, not the group's row count.
     *
     * `failure_rate` is NULL for a turn that has not reached a verdict, so the
     * rate is over the finished ones and `coverage.avg_failure_rate` is exactly
     * how many those were. Multiplying by `rows` instead would rebuild the
     * numerator against a bigger population and report more failures than
     * happened — the mirror image of the bug that made unfinished turns count as
     * successes. `rows` is still what a caller without `withFailures` sees.
     */
    const judged = rate === null ? 0 : (row.coverage.avg_failure_rate ?? 0);
    const rows = row.rows;
    return {
      id: label,
      label,
      value: num(row[valueKey]),
      // TopList wants a numerator and a denominator, not a rate, so it can show
      // "3 of 214" rather than a bare percentage nobody can weigh.
      ...(rate === null ? {} : { errors: Math.round(rate * judged), total: judged }),
      ...(durationKey === null ? {} : { durationMs: num(row[durationKey]) }),
    };
  });
}

/**
 * Everything the front door needs, in one round of queries.
 *
 * `Promise.all` rather than sequential awaits: they are independent reads
 * against the same connection pool, and serialising them would make the page
 * as slow as the sum rather than as the slowest. The whole set is well under a
 * second on the seeded month.
 */
export async function loadOverview(window: Window) {
  const [runs, failureRate, latency, spend, tokens, ttft, runsByTrigger, spendByModel, topModels, topTools] =
    await Promise.all([
      headline(window, ROWS, "count"),
      headline(window, "failure_rate", "avg"),
      headline(window, "duration", "p95"),
      headline(window, "cost", "sum"),
      headline(window, "output_tokens", "sum"),
      headline(window, "ttft", "p95"),
      stacked(window, ROWS, "count", "trigger"),
      stacked(window, "cost", "sum", "model"),
      ranked(window, {
        dimension: "model",
        measure: "cost",
        aggregation: "sum",
        withFailures: true,
        withDuration: { measure: "duration", aggregation: "p95" },
      }),
      ranked(window, {
        view: "tool_calls",
        dimension: "tool",
        measure: ROWS,
        aggregation: "count",
        withDuration: { measure: "duration", aggregation: "p95" },
      }),
    ]);

  return { runs, failureRate, latency, spend, tokens, ttft, runsByTrigger, spendByModel, topModels, topTools };
}

export { EMPTY as EMPTY_HEADLINE };
