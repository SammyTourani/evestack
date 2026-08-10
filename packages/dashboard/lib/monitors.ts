import { query } from "./db";
// One definition of "open long enough to be suspicious". lib/facts.ts exports
// it, passes the same number into sql/facts.sql's `wedged` arm, and lib/alerts.ts
// imports it from there too. Three surfaces, one number, on purpose: a threshold
// that exists twice is a threshold that will differ.
import { STUCK_TURN_MS } from "./facts";

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
 *
 * **An unfinished turn is not a successful one.** The failure rate is `failed /
 * finished` and a turn that has not reached a verdict is in neither half. It
 * used to be `failed / total`, which put every running and every wedged turn in
 * the denominator scoring zero — so a crashed agent IMPROVED the number on the
 * page you open to find out whether the agent has crashed. They are counted and
 * reported instead, as `unfinished` and the `stalled` subset of it, because the
 * fix for "counted as good news" is being visible, not being dropped.
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
  /** Turns in this bucket that have not reached a verdict. */
  readonly unfinished: number;
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
    /**
     * Turns that reached a verdict, whatever it was. The failure rate's
     * denominator, and NOT `total`.
     */
    readonly finished: number;
    /**
     * Turns that have not. `total - finished`, reported rather than folded into
     * either side of the rate.
     */
    readonly unfinished: number;
    /**
     * The unfinished ones that have been unfinished for longer than
     * lib/facts.ts's STUCK_TURN_MS — the same threshold `sql/facts.sql` calls
     * `wedged` and lib/alerts.ts alerts on. A subset of `unfinished`, never
     * added to it.
     */
    readonly stalled: number;
    /** Turns whose workflow row carries an error_code. */
    readonly errored: number;
    /** Finished turns that never recorded a model call. See the header. */
    readonly noModelCall: number;
    /**
     * Turns failing EITHER test, counted once. Not `errored + noModelCall` —
     * a turn can be both, and usually is when a provider rejects the call.
     */
    readonly failed: number;
    /** `failed` over `finished`. 0 when nothing finished. */
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

/**
 * The three tests, written once, because two of them were written twice.
 *
 * `failed` was already spelled out separately in the summary query and in the
 * bucket query, and this file's own comments record that the two once
 * disagreed. The unfinished test is new and would have been the third copy.
 * Each is evaluated over the `turns` CTE below, which projects `status`,
 * `error_code`, `model`, `completed_at` and `opened_at`.
 */

/**
 * A turn that has not reached a verdict.
 *
 * The mirror of `sql/facts.sql`'s `running` and `wedged` arms, which are the
 * last two of its CASE and so are only reachable once error_code, the
 * no-model-call test, a budget stop and a cancellation have all been ruled out:
 *
 *   error_code IS NOT NULL      a verdict, whatever `completed_at` says
 *   status = 'cancelled'        a verdict — and how @evestack/budget's `cancel`
 *                               mode lands, so this covers `budget_stopped`
 *                               without reading evestack.budget_events; its
 *                               `fail` mode sets error_code and is covered above
 *   completed_at IS NOT NULL    finished, including finished-with-no-model-call
 *
 * `IS DISTINCT FROM` rather than a plain inequality: against a NULL status the
 * comparison would evaluate to NULL and the row would silently leave the
 * unfinished set.
 *
 * ONE THING THIS CANNOT SEE, said out loud rather than implying the denominator
 * is cleaner than it is: eve's turn workflow RETURNS when it parks on a human.
 * `emitTurnEpilogue` puts `turn.completed` on the stream and the run row
 * completes with it, so a turn sitting on an unanswered approval has
 * `completed_at` set and counts as FINISHED here — as `ok`, since it errored on
 * nothing. lib/fleet.ts documents the same limit from the other side: a pending
 * request is a fact only the agent's stream carries, and eve exposes no
 * fleet-wide feed of them. So `finished` here means the workflow row is done,
 * which is the strongest claim these tables support. It does not mean the work
 * is done, and the rate must not be read as if it did.
 */
const UNFINISHED_SQL =
  "completed_at IS NULL AND error_code IS NULL AND status IS DISTINCT FROM 'cancelled'";

/** Reached a verdict. The failure rate's denominator. */
const FINISHED_SQL = `NOT (${UNFINISHED_SQL})`;

/**
 * Failed, counted once. `sql/facts.sql` folds exactly this population into
 * `outcome`'s first two arms and lib/metrics.ts averages those, so the fact
 * table, the metric catalog and this page cannot disagree about who failed.
 *
 * Every row this matches also satisfies FINISHED_SQL — `error_code IS NOT NULL`
 * and `completed_at IS NOT NULL` are each enough on their own — so the numerator
 * cannot escape the denominator and the rate cannot exceed 100%.
 */
const FAILED_SQL = "error_code IS NOT NULL OR (completed_at IS NOT NULL AND model IS NULL)";

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
 * Failure rate as a fraction of the turns in the window that FINISHED.
 *
 * The denominator is `finished`, not `total`, and that is the whole reason this
 * is a function rather than a division at the call site. With `total`
 * underneath it a turn that was still running scored as a success, so every
 * wedged agent pushed the number DOWN — the metric moved the wrong way during
 * exactly the incident it exists to surface.
 *
 * Exported and pure so it can be tested without a database — the arithmetic is
 * where an off-by-one lands, and dividing by a zero denominator is the specific
 * way an empty dashboard would render `NaN%`.
 *
 * `failed` is a count of DISTINCT turns, not the sum of the two failure
 * counters. This used to take `(errored, noModelCall, total)` and add them,
 * which double-counts a turn that both carries an `error_code` and never
 * reached the provider — the single most common real failure shape, since a
 * provider that rejects the call records the error and no usage. That version
 * returned 200% for a window where every turn was both, and its own test
 * (`failureRate(10, 15, 25) === 1`) only passed because it assumed the two sets
 * are disjoint. They are not, and the seeded fixture happens to contain zero
 * overlap, which is why nothing caught it.
 *
 * The bucket query in this same file already used `OR` for its per-bucket
 * `failed` count, so the summary and the chart underneath it disagreed with
 * each other whenever an overlap existed.
 */
export function failureRate(failed: number, finished: number): number {
  if (finished <= 0) return 0;
  return failed / finished;
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
             -- started_at is null on a run created and never picked up, so the
             -- age of an unfinished turn falls back to when it was created.
             -- lib/fleet.ts makes the same substitution for the same reason.
             COALESCE(started_at, created_at) AS opened_at,
             CASE WHEN completed_at IS NOT NULL AND started_at IS NOT NULL
                  THEN EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000
             END AS ms
      FROM workflow.workflow_runs
      WHERE attributes->>'$eve.type' IN ('turn', 'subagent')
        AND created_at >= (now() AT TIME ZONE 'utc') - $1::interval
    )
    SELECT
      (SELECT count(*) FROM turns) AS total,
      (SELECT count(*) FROM turns WHERE ${FINISHED_SQL}) AS finished,
      (SELECT count(*) FROM turns WHERE ${UNFINISHED_SQL}) AS unfinished,
      -- A SUBSET of unfinished, never a separate population: the same
      -- STUCK_TURN_MS that sql/facts.sql calls wedged and lib/alerts.ts pages on.
      (SELECT count(*) FROM turns
        WHERE (${UNFINISHED_SQL})
          AND (now() AT TIME ZONE 'utc') - opened_at
                > make_interval(secs => $2::double precision)) AS stalled,
      (SELECT count(*) FROM turns WHERE error_code IS NOT NULL) AS errored,
      (SELECT count(*) FROM turns
        WHERE completed_at IS NOT NULL AND model IS NULL) AS no_model_call,
      -- DISTINCT, not errored + no_model_call: a turn can be both, and adding
      -- them reports one failure twice. The bucket query's FILTER below is the
      -- same constant, so the summary and the chart cannot drift apart.
      (SELECT count(*) FROM turns WHERE ${FAILED_SQL}) AS failed,
      ${PERCENTILES}
    FROM turns WHERE ms IS NOT NULL
    `,
    [since, STUCK_TURN_MS / 1000],
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
        AND created_at >= (now() AT TIME ZONE 'utc') - $1::interval
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
   *
   * THE BOUNDS BELOW USE A BARE now() ON PURPOSE, and it is not an oversight
   * left behind by the (now() AT TIME ZONE 'utc') conversions in the WHERE
   * clauses. The two are different operations:
   *
   *   COMPARISON   `created_at >= now() - interval` puts a naive timestamp
   *                beside a timestamptz, so Postgres reads the stored value in
   *                the server's zone. That is the bug — four hours in
   *                America/New_York, and in the wrong direction.
   *   EXTRACT      `extract(epoch from <naive>)` treats the value as UTC, which
   *                is what it is. Measured against the running database:
   *                extract(epoch from timestamp '2026-08-09 05:31:00') and
   *                extract(epoch from timestamptz '2026-08-09 05:31:00+00')
   *                are the same number, under TimeZone='America/New_York'.
   *
   * So `lo`/`hi` and `extract(epoch from created_at)` are already on one scale.
   * Converting them "for consistency" would subtract the offset from one side
   * only and shift every bucket boundary — turning a correct chart into a wrong
   * one while looking like a tidy-up.
   */
  const bucketRows = await query<Record<string, unknown>>(
    `
    WITH bounds AS (
      SELECT extract(epoch from now() - $1::interval) AS lo,
             extract(epoch from now()) AS hi
    ), turns AS (
      -- status is projected because UNFINISHED_SQL reads it. The summary
      -- query above and this one share those predicates, so they share the
      -- columns the predicates name.
      SELECT status, error_code,
             attributes->>'$eve.model' AS model,
             completed_at,
             width_bucket(extract(epoch from created_at),
                          (SELECT lo FROM bounds), (SELECT hi FROM bounds), $2) AS bucket,
             CASE WHEN completed_at IS NOT NULL AND started_at IS NOT NULL
                  THEN EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000
             END AS ms
      FROM workflow.workflow_runs
      WHERE attributes->>'$eve.type' IN ('turn', 'subagent')
        AND created_at >= (now() AT TIME ZONE 'utc') - $1::interval
    )
    SELECT bucket,
           count(*) AS turns,
           count(*) FILTER (WHERE ${FAILED_SQL}) AS failed,
           count(*) FILTER (WHERE ${UNFINISHED_SQL}) AS unfinished,
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
      unfinished: num(row?.unfinished),
      p95Ms: row?.p95 == null ? null : num(row.p95),
    };
  });

  const errored = num(turnStats?.errored);
  const noModelCall = num(turnStats?.no_model_call);
  const failed = num(turnStats?.failed);
  const total = num(turnStats?.total);
  const finished = num(turnStats?.finished);
  const unfinished = num(turnStats?.unfinished);
  const stalled = num(turnStats?.stalled);

  return {
    windowHours: hours,
    turnLatencyMs: toPercentiles(turnStats),
    sessionDurationMs: toPercentiles(sessionStats),
    turns: {
      total,
      finished,
      unfinished,
      stalled,
      errored,
      noModelCall,
      failed,
      failureRate: failureRate(failed, finished),
    },
    sessions: {
      total: num(sessionStats?.total),
      completed: num(sessionStats?.completed),
      running: num(sessionStats?.running),
    },
    buckets,
  };
}
