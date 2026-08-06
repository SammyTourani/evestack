import { query } from "./db";

/**
 * Latency and failure rates, read from the same `workflow.workflow_runs` every
 * other page reads.
 *
 * This exists because the marketing site rendered a panel of p50/p75/p95/p99
 * session durations and an error series under the caption "read straight from
 * your own postgres", and the dashboard had no percentile code anywhere. The
 * honest options were to delete the claim or to make it true. This is the
 * second one.
 *
 * ── Two things here are easy to get wrong ────────────────────────────────────
 *
 * **A session's duration is not a latency.** `$eve.type = 'session'` stays
 * `running` for as long as the conversation is open — lib/queries.ts records
 * that at the top — so a session that a human left open overnight is a 9-hour
 * "session duration" that measures the human, not the agent. Turns are the unit
 * that starts and finishes around one model exchange, so turn latency is the
 * number worth alerting on. Session duration is still reported, over completed
 * sessions only, because that is what the site's panel names — but they are
 * separate fields and never averaged together.
 *
 * **`status` alone undercounts failures.** A turn killed by a provider rate
 * limit emits `turn.failed` on the stream while its workflow row still reads
 * `status = 'completed'`: the workflow handled the error, so nothing failed as
 * far as it is concerned. lib/queries.ts calls the surviving evidence
 * `noModelCall` — eve writes `$eve.model` only once a model call reports usage,
 * so a finished turn without it never reached the provider. An error rate built
 * on `error_code` alone reports those as successes, which is the direction that
 * flatters us, so both are counted and reported separately.
 */

/** Percentiles are computed by Postgres; this is the row it hands back. */
export interface Percentiles {
  readonly p50: number;
  readonly p75: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  /** How many finished rows the percentiles were computed from. */
  readonly count: number;
}

export interface MonitorBucket {
  /** Start of the bucket, ISO. */
  readonly start: string;
  readonly turns: number;
  readonly failed: number;
  /** Null when nothing in the bucket finished. */
  readonly p95Ms: number | null;
}

export interface MonitorSummary {
  readonly windowHours: number;
  /** Turn latency — the actionable signal. Null when nothing finished. */
  readonly turnLatencyMs: Percentiles | null;
  /** Duration of sessions that actually ended. Null when none did. */
  readonly sessionDurationMs: Percentiles | null;
  readonly turns: {
    readonly total: number;
    /** Turns whose workflow row carries an error_code. */
    readonly errored: number;
    /** Finished turns that never recorded a model call. See the header. */
    readonly noModelCall: number;
    /** errored + noModelCall, over total. 0 when there were no turns. */
    readonly failureRate: number;
  };
  readonly sessions: {
    readonly total: number;
    readonly completed: number;
    readonly running: number;
  };
  readonly buckets: readonly MonitorBucket[];
}

/** Windows the UI offers. Hours, because eve's own session default is 30 days. */
export const WINDOWS = [1, 6, 12, 24, 24 * 7] as const;
export type WindowHours = (typeof WINDOWS)[number];

/**
 * Bucket count for the series. Twelve keeps every window's bucket a round
 * number of minutes and keeps the chart readable at the width it renders.
 */
const BUCKETS = 12;

/**
 * `percentile_cont` interpolates between the two nearest rows, which is what
 * "the p95 is 4.2s" normally means, and it ignores NULLs — so unfinished rows
 * drop out rather than counting as zero. `FILTER` is doing real work in the
 * failure counts: it keeps one pass over the window instead of three.
 *
 * Durations come from `completed_at - started_at`, not `created_at`: a run can
 * sit queued, and queue time is not latency. EXTRACT(EPOCH ...) carries the
 * whole interval — the same trap @evestack/schedules fell into by summing
 * MILLISECONDS and SECONDS, which double-counts under a minute and drops whole
 * minutes above one.
 */
const PERCENTILES = `
  percentile_cont(0.50) WITHIN GROUP (ORDER BY ms) AS p50,
  percentile_cont(0.75) WITHIN GROUP (ORDER BY ms) AS p75,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY ms) AS p95,
  percentile_cont(0.99) WITHIN GROUP (ORDER BY ms) AS p99,
  max(ms) AS max,
  count(*) AS count
`;

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** A percentile row is only meaningful when something finished. */
function toPercentiles(row: Record<string, unknown> | undefined): Percentiles | null {
  if (!row) return null;
  const count = num(row.count);
  if (count === 0) return null;
  return {
    p50: num(row.p50),
    p75: num(row.p75),
    p95: num(row.p95),
    p99: num(row.p99),
    max: num(row.max),
    count,
  };
}

/**
 * Failure rate as a fraction of turns in the window.
 *
 * Exported and pure so it can be tested without a database — the arithmetic is
 * where an off-by-one lands, and dividing by a zero denominator is the specific
 * way an empty dashboard would render `NaN%`.
 */
export function failureRate(errored: number, noModelCall: number, total: number): number {
  if (total <= 0) return 0;
  return (errored + noModelCall) / total;
}

export async function getMonitorSummary(windowHours = 24): Promise<MonitorSummary> {
  const hours = Number.isFinite(windowHours) && windowHours > 0 ? windowHours : 24;
  const since = `${hours} hours`;

  const [turnStats] = await query<Record<string, unknown>>(
    `
    WITH turns AS (
      SELECT status, error_code,
             attributes->>'$eve.model' AS model,
             completed_at,
             CASE WHEN completed_at IS NOT NULL AND started_at IS NOT NULL
                  THEN EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000
             END AS ms
      FROM workflow.workflow_runs
      WHERE attributes->>'$eve.type' IN ('turn', 'subagent')
        AND created_at >= now() - $1::interval
    )
    SELECT
      (SELECT count(*) FROM turns) AS total,
      (SELECT count(*) FROM turns WHERE error_code IS NOT NULL) AS errored,
      (SELECT count(*) FROM turns
        WHERE completed_at IS NOT NULL AND model IS NULL) AS no_model_call,
      ${PERCENTILES}
    FROM turns WHERE ms IS NOT NULL
    `,
    [since],
  );

  const [sessionStats] = await query<Record<string, unknown>>(
    `
    WITH sessions AS (
      SELECT status,
             CASE WHEN completed_at IS NOT NULL AND started_at IS NOT NULL
                  THEN EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000
             END AS ms
      FROM workflow.workflow_runs
      WHERE attributes->>'$eve.type' = 'session'
        AND created_at >= now() - $1::interval
    )
    SELECT
      (SELECT count(*) FROM sessions) AS total,
      (SELECT count(*) FROM sessions WHERE ms IS NOT NULL) AS completed,
      (SELECT count(*) FROM sessions WHERE ms IS NULL) AS running,
      ${PERCENTILES}
    FROM sessions WHERE ms IS NOT NULL
    `,
    [since],
  );

  /**
   * width_bucket over epoch seconds rather than date_trunc, because the window
   * is a rolling "last N hours" and date_trunc would produce a short leading
   * bucket whose lower count reads as a dip in throughput.
   */
  const bucketRows = await query<Record<string, unknown>>(
    `
    WITH bounds AS (
      SELECT extract(epoch from now() - $1::interval) AS lo,
             extract(epoch from now()) AS hi
    ), turns AS (
      SELECT error_code,
             attributes->>'$eve.model' AS model,
             completed_at,
             width_bucket(extract(epoch from created_at),
                          (SELECT lo FROM bounds), (SELECT hi FROM bounds), $2) AS bucket,
             CASE WHEN completed_at IS NOT NULL AND started_at IS NOT NULL
                  THEN EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000
             END AS ms
      FROM workflow.workflow_runs
      WHERE attributes->>'$eve.type' IN ('turn', 'subagent')
        AND created_at >= now() - $1::interval
    )
    SELECT bucket,
           count(*) AS turns,
           count(*) FILTER (
             WHERE error_code IS NOT NULL
                OR (completed_at IS NOT NULL AND model IS NULL)
           ) AS failed,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY ms) AS p95
    FROM turns
    WHERE bucket BETWEEN 1 AND $2
    GROUP BY bucket
    ORDER BY bucket
    `,
    [since, BUCKETS],
  );

  // Densify. A bucket with no traffic is a real zero and must draw as one;
  // letting the chart skip it silently redraws a quiet hour as continuous load.
  const byBucket = new Map(bucketRows.map((r) => [num(r.bucket), r]));
  const now = Date.now();
  const spanMs = hours * 3600 * 1000;
  const buckets: MonitorBucket[] = Array.from({ length: BUCKETS }, (_, i) => {
    const row = byBucket.get(i + 1);
    return {
      start: new Date(now - spanMs + (spanMs / BUCKETS) * i).toISOString(),
      turns: num(row?.turns),
      failed: num(row?.failed),
      p95Ms: row?.p95 == null ? null : num(row.p95),
    };
  });

  const errored = num(turnStats?.errored);
  const noModelCall = num(turnStats?.no_model_call);
  const total = num(turnStats?.total);

  return {
    windowHours: hours,
    turnLatencyMs: toPercentiles(turnStats),
    sessionDurationMs: toPercentiles(sessionStats),
    turns: { total, errored, noModelCall, failureRate: failureRate(errored, noModelCall, total) },
    sessions: {
      total: num(sessionStats?.total),
      completed: num(sessionStats?.completed),
      running: num(sessionStats?.running),
    },
    buckets,
  };
}
