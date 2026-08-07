/**
 * The dashboard's Monitors page must report the distribution that is actually
 * there.
 *
 * `packages/dashboard/lib/monitors.ts` computes p50/p75/p95/p99 with
 * `percentile_cont` and counts failures with `FILTER`. Both are PostgreSQL
 * semantics, so a JavaScript test would only assert a restatement of them. This
 * runs the same shapes against a real server.
 *
 * Two of these assertions are the ones that matter:
 *
 * 1. **Unfinished turns must not count as zero.** A running turn has
 *    `completed_at IS NULL`, so its duration expression yields NULL.
 *    `percentile_cont` ignores NULLs; `coalesce(..., 0)` would not, and the
 *    dashboard would report a p50 dragged toward zero — a busy agent looking
 *    faster the more work it has in flight. The fixtures below make that
 *    failure mode numerically obvious: 5500ms correct, 3000ms if NULLs are
 *    counted as zero.
 *
 * 2. **`status` alone undercounts failures.** A turn killed by a provider rate
 *    limit still lands as `status = 'completed'` with no `$eve.model` tag. The
 *    page counts those; a naive `WHERE status = 'failed'` does not. The probe
 *    asserts the two disagree, so the cheaper query can never be quietly
 *    substituted.
 *
 * Mirrors the expressions in lib/monitors.ts. Drift between them should be read
 * as this probe going stale rather than as a discovery.
 */
import { randomUUID } from "node:crypto";

/** Ten finished turns, 1s … 10s. Percentiles below are derived from these. */
const FINISHED_MS = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000];

/** Unfinished turns, which must be excluded rather than treated as 0ms. */
const UNFINISHED = 5;

/**
 * `percentile_cont(p)` interpolates at the fractional index `(N-1) * p` into
 * the sorted values. With N=10 and the values above:
 *   p50 → idx 4.50 → 5000 + 0.50 * 1000 = 5500
 *   p75 → idx 6.75 → 7000 + 0.75 * 1000 = 7750
 *   p95 → idx 8.55 → 9000 + 0.55 * 1000 = 9550
 *   p99 → idx 8.91 → 9000 + 0.91 * 1000 = 9910
 */
const EXPECTED = { p50: 5500, p75: 7750, p95: 9550, p99: 9910, max: 10000, count: 10 };

/** Had NULLs been coalesced to zero, p50 would land here instead. */
const P50_IF_NULLS_COUNTED_AS_ZERO = 3000;

async function connect() {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.WORKFLOW_POSTGRES_URL });
  await client.connect();
  // A pg.Client with no 'error' listener turns a dead socket into an
  // uncaughtException, and in a probe runner that does not fail THIS probe — it
  // kills the process and takes every other probe's result with it. A Postgres
  // blip mid-suite would then report as "the suite crashed" instead of as one red
  // line. Every long-lived client under probes/ was missing it; the same listener
  // already exists in templates/default/scripts/checks.mjs connectPostgres(), for
  // the same reason and with the same body.
  //
  // A no-op, not `client.destroy()`: pg.Client has no `destroy`, only `end`, and
  // there is nothing useful to do here anyway — the next query rejects on its own
  // with pg's "Client has encountered a connection error and is not queryable",
  // which the runner reports as this probe failing, which is what it is.
  client.on("error", () => {});
  return client;
}

export default {
  id: "monitors/percentiles-describe-what-finished",
  title: "the Monitors page's percentiles and failure counts match the rows underneath",
  needs: ["postgres"],
  why:
    "The marketing site rendered p50/p75/p95/p99 under the caption 'read straight from your own " +
    "postgres' while the dashboard had no percentile code at all. Now that it does, the numbers " +
    "have to be right: counting unfinished turns as 0ms would make a busy agent look faster the " +
    "more work it has in flight, and counting only status='failed' would hide every turn a " +
    "provider rate limit killed.",

  async available() {
    if (!process.env.WORKFLOW_POSTGRES_URL) return ["WORKFLOW_POSTGRES_URL is not set"];
    try {
      const client = await connect();
      await client.end();
      return [];
    } catch (error) {
      return [`cannot reach Postgres: ${error.message}`];
    }
  },

  async run(t) {
    const client = await connect();
    const schema = `probe_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      // The columns lib/queries.ts documents, and only those.
      await client.query(`
        CREATE TABLE ${schema}.workflow_runs (
          id           text PRIMARY KEY,
          status       text NOT NULL,
          error_code   text,
          created_at   timestamptz NOT NULL DEFAULT now(),
          started_at   timestamptz,
          completed_at timestamptz,
          attributes   jsonb NOT NULL DEFAULT '{}'::jsonb
        )
      `);

      // Both ends of every duration come from the SERVER's clock.
      //
      // This used to pass `new Date().toISOString()` for completed_at while
      // started_at was `now() - interval`, which measures the gap between two
      // different clocks rather than a duration. Measured on this machine: the
      // container's Postgres runs 73ms ahead of the host (three samples, 0-1ms
      // round trip), so every duration came back 73ms short and all five
      // percentile assertions failed together against a ±50ms tolerance — with
      // nothing whatsoever wrong in the code under test. A probe that fails on VM
      // clock skew is a probe that flakes on any virtualised CI runner, and the
      // subject here is `percentile_cont`, not clock agreement.
      //
      // `now()` is transaction-start time and both references sit in one
      // statement, so the recorded duration is now EXACTLY the fixture.
      const insert = async (row) => {
        await client.query(
          `INSERT INTO ${schema}.workflow_runs
             (id, status, error_code, created_at, started_at, completed_at, attributes)
           VALUES ($1,$2,$3, now(), now() - $4::interval,
                   CASE WHEN $5::boolean THEN now() END, $6::jsonb)`,
          [
            row.id,
            row.status,
            row.errorCode ?? null,
            `${(row.ms ?? 0) / 1000} seconds`,
            row.ms !== null,
            JSON.stringify(row.attributes),
          ],
        );
      };

      for (const [i, ms] of FINISHED_MS.entries()) {
        await insert({
          id: `turn-${i}`,
          status: "completed",
          ms,
          attributes: { "$eve.type": "turn", "$eve.model": "openai/gpt-5-mini" },
        });
      }
      for (let i = 0; i < UNFINISHED; i += 1) {
        await insert({
          id: `running-${i}`,
          status: "running",
          ms: null,
          attributes: { "$eve.type": "turn", "$eve.model": "openai/gpt-5-mini" },
        });
      }

      const { rows } = await client.query(`
        WITH turns AS (
          SELECT CASE WHEN completed_at IS NOT NULL AND started_at IS NOT NULL
                      THEN EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000
                 END AS ms
          FROM ${schema}.workflow_runs
          WHERE attributes->>'$eve.type' IN ('turn', 'subagent')
        )
        SELECT percentile_cont(0.50) WITHIN GROUP (ORDER BY ms) AS p50,
               percentile_cont(0.75) WITHIN GROUP (ORDER BY ms) AS p75,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY ms) AS p95,
               percentile_cont(0.99) WITHIN GROUP (ORDER BY ms) AS p99,
               max(ms) AS max, count(*) AS count
        FROM turns WHERE ms IS NOT NULL
      `);
      const got = rows[0];

      // ±50ms is headroom now, not a requirement: both ends of each duration are
      // one `now()` inside one statement, so these come back exact. It used to be
      // load-bearing and was not wide enough — see the note on `insert`.
      for (const [key, want] of Object.entries(EXPECTED)) {
        const actual = Number(got[key]);
        const tolerance = key === "count" ? 0 : 50;
        const matches = Math.abs(actual - want) <= tolerance;
        t.ok(
          matches,
          `${key} is ${want}${key === "count" ? "" : "ms"}`,
          matches ? {} : { expected: `${want} (±${tolerance})`, actual },
        );
      }

      const excluded = Math.abs(Number(got.p50) - P50_IF_NULLS_COUNTED_AS_ZERO) > 1000;
      t.ok(
        excluded,
        "unfinished turns are excluded from the distribution, not counted as 0ms",
        excluded
          ? {}
          : {
              expected: `a p50 far from ${P50_IF_NULLS_COUNTED_AS_ZERO}ms`,
              actual: `${Number(got.p50)}ms — the ${UNFINISHED} running turns are being counted as zero, which makes a busier agent look faster`,
            },
      );

      // Now the failure counting. One turn errors outright; one finishes
      // "successfully" having never reached the provider.
      await insert({
        id: "errored",
        status: "failed",
        ms: 500,
        errorCode: "PROVIDER_ERROR",
        attributes: { "$eve.type": "turn", "$eve.model": "openai/gpt-5-mini" },
      });
      await insert({
        id: "rate-limited",
        status: "completed",
        ms: 120,
        attributes: { "$eve.type": "turn" },
      });

      const { rows: counted } = await client.query(`
        SELECT
          count(*) FILTER (WHERE error_code IS NOT NULL) AS errored,
          count(*) FILTER (WHERE completed_at IS NOT NULL
                             AND attributes->>'$eve.model' IS NULL) AS no_model_call,
          count(*) FILTER (WHERE status = 'failed') AS status_failed
        FROM ${schema}.workflow_runs
        WHERE attributes->>'$eve.type' IN ('turn', 'subagent')
      `);
      const c = counted[0];

      const errored = Number(c.errored);
      const noModelCall = Number(c.no_model_call);
      const statusFailed = Number(c.status_failed);

      t.ok(errored === 1, "a turn carrying error_code is counted", errored === 1 ? {} : {
        expected: 1,
        actual: errored,
      });
      t.ok(
        noModelCall === 1,
        "a finished turn with no $eve.model is counted as a failure",
        noModelCall === 1
          ? {}
          : {
              expected: "1 — the rate-limited turn the workflow calls 'completed'",
              actual: noModelCall,
            },
      );

      const undercounts = errored + noModelCall > statusFailed;
      t.ok(
        undercounts,
        "status alone undercounts failures, so the page must not use it",
        undercounts
          ? {}
          : {
              expected: `more real failures than the ${statusFailed} status='failed' finds`,
              actual: `${errored + noModelCall} real vs ${statusFailed} by status — if these agree, the cheaper query could be substituted unnoticed`,
            },
      );
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
      await client.end();
    }
  },
};
