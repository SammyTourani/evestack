/**
 * The metric catalog has to be true about a real database.
 *
 * `packages/dashboard/lib/metrics.ts` is a table of SQL fragments and a
 * compiler. `tsc` cannot see inside a fragment: a column that was renamed, a
 * cast Postgres refuses, an aggregate that does not exist for a type — all of
 * them type-check perfectly and fail at the first chart. Worse, some of them do
 * not fail at all. They return a number.
 *
 * So this probe runs the SHIPPED compiler against the configured server and
 * checks the five things a JavaScript test structurally cannot:
 *
 * 1. EVERY ENTRY IN THE CATALOG EXECUTES. Every measure at every aggregation it
 *    declares, every groupable dimension as a group, every dimension as a
 *    filter. The catalog is the product's whole extensibility story — "adding a
 *    chart is a config object" is only true if every config object works — and
 *    an entry nobody has run is a chart that will 500 the first time someone
 *    asks for it.
 *
 * 2. THE BUCKETS ADD BACK UP. `width_bucket` returns 0 below the low bound and
 *    n+1 at or above the high one, and a row in either lands in no bucket the
 *    densifier emits. It would vanish from the chart silently, which is the
 *    failure mode that looks like a quiet Tuesday.
 *
 * 3. THE COVERAGE NUMBERS ARE THE REAL ONES. `coverage.byMeasure` is what stops
 *    a p95 TTFT over 370 turns being read as the p95 of 1,922. It is checked
 *    here against `count(<column>)` taken straight from the table.
 *
 * 4. THERE IS NO THIRD DEFINITION OF FAILURE. `failure_rate` must equal
 *    lib/monitors.ts's `(errored + noModelCall) / total`, computed here from
 *    `workflow.workflow_runs` rather than from the fact table, so a drift in
 *    either direction shows up.
 *
 * 5. A HOSTILE VALUE IS A PARAMETER. The unit tests prove it is not in the
 *    statement text. Only a server can prove that what does reach it is inert.
 *
 * ── What this probe writes ───────────────────────────────────────────────────
 *
 * `runMetricQuery` refreshes the fact tables first, so this writes
 * `evestack.fact_turn`, `evestack.fact_tool_call` and `evestack.fact_watermark`
 * — exactly as probe 07 does, and for the same reason: those three hold nothing
 * that is not derived from `workflow.workflow_runs` and `evestack.spans`, and
 * probing a copy of the code instead of the code is how a probe stays green
 * while the product is broken. Nothing in the `workflow` schema is touched.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DASHBOARD = join(HERE, "../../../packages/dashboard");

async function connect() {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.WORKFLOW_POSTGRES_URL });
  await client.connect();
  await client.query("SET statement_timeout = '60s'");
  return client;
}

const num = (value) => (value === null || value === undefined ? null : Number(value));

export default {
  id: "metrics/catalog-is-true-about-the-database",
  title: "every metric in the catalog runs, adds up, and states its own coverage",
  needs: ["postgres"],
  why:
    "The point of the metric catalog is that a new chart is a config object rather than a code " +
    "change. That is only true if every entry in it executes — and a SQL fragment in a table is " +
    "invisible to the type checker. The rest of the probe defends the numbers themselves: a row " +
    "that falls outside every bucket disappears from a chart without a word, a coverage count " +
    "that is wrong presents 3% of the fleet as the fleet, and a failure rate that drifts from " +
    "lib/monitors.ts means the same turn is a failure on one page and a success on another.",

  async available() {
    if (!process.env.WORKFLOW_POSTGRES_URL) return ["WORKFLOW_POSTGRES_URL is not set"];
    try {
      const client = await connect();
      const { rows } = await client.query(
        "SELECT to_regclass('workflow.workflow_runs')::text AS runs",
      );
      await client.end();
      if (!rows[0]?.runs) return ["workflow.workflow_runs does not exist"];
      return [];
    } catch (error) {
      return [`cannot reach Postgres: ${error.message}`];
    }
  },

  async run(t) {
    // `runMetricQuery` refreshes the facts first, and lib/facts.ts reads its
    // DDL relative to the working directory — which is how the dashboard runs.
    // Restored in the `finally` below. Same move as probe 07.
    const cwd = process.cwd();
    process.chdir(DASHBOARD);
    // The repo's one TypeScript-resolution shim; importing it registers an
    // in-thread resolve hook.
    await import(join(DASHBOARD, "test/register-ts-resolve.mjs"));
    const metrics = await import(join(DASHBOARD, "lib/metrics.ts"));
    const db = await import(join(DASHBOARD, "lib/db.ts"));
    const client = await connect();

    // A window wide enough to hold the whole seeded month and any live traffic.
    const now = Date.now();
    const WINDOW = {
      from: new Date(now - 60 * 86_400_000).toISOString(),
      to: new Date(now + 86_400_000).toISOString(),
    };
    const WHERE_WINDOW = "created_at >= $1::timestamptz AND created_at < $2::timestamptz";
    const bounds = [WINDOW.from, WINDOW.to];

    try {
      /* ── 1. every catalog entry executes ──────────────────────────────── */

      for (const [viewName, view] of Object.entries(metrics.CATALOG)) {
        // Grouped by aggregation rather than one query per measure: same
        // coverage, a tenth of the round trips, and a failure still names the
        // aggregation and the view it came from.
        const byAggregation = new Map();
        for (const [name, measure] of Object.entries(view.measures)) {
          for (const aggregation of measure.aggregations) {
            if (!byAggregation.has(aggregation)) byAggregation.set(aggregation, []);
            byAggregation.get(aggregation).push({ measure: name, aggregation });
          }
        }
        for (const [aggregation, measures] of byAggregation) {
          try {
            const result = await metrics.runMetricQuery({
              view: viewName,
              measures,
              timeDimension: WINDOW,
            });
            t.ok(
              result.data.length === 1,
              `${viewName}: all ${measures.length} measures run as '${aggregation}'`,
              result.data.length === 1 ? {} : { actual: `${result.data.length} rows` },
            );
          } catch (error) {
            t.ok(false, `${viewName}: all measures run as '${aggregation}'`, {
              actual: error.message,
            });
          }
        }

        const groupable = Object.entries(view.dimensions).filter(([, d]) => d.groupable);
        for (const [name] of groupable) {
          try {
            const result = await metrics.runMetricQuery({
              view: viewName,
              dimensions: [name],
              timeDimension: WINDOW,
            });
            t.note(`${viewName} by ${name}: ${result.data.length} groups`);
            t.ok(true, `${viewName}: dimension '${name}' groups`);
          } catch (error) {
            t.ok(false, `${viewName}: dimension '${name}' groups`, { actual: error.message });
          }
        }

        // Every dimension, groupable or not, has to survive being filtered on —
        // that is the only way a high-cardinality field is reachable at all.
        for (const name of Object.keys(view.dimensions)) {
          try {
            await metrics.runMetricQuery({
              view: viewName,
              filters: [{ field: name, operator: "is_not_null" }],
              timeDimension: WINDOW,
            });
            t.ok(true, `${viewName}: dimension '${name}' filters`);
          } catch (error) {
            t.ok(false, `${viewName}: dimension '${name}' filters`, { actual: error.message });
          }
        }
      }

      /* ── 2. the buckets add back up ───────────────────────────────────── */

      const [{ turns_in_window }] = (
        await client.query(
          `SELECT count(*)::int AS turns_in_window FROM evestack.fact_turn WHERE ${WHERE_WINDOW}`,
          bounds,
        )
      ).rows;

      const bucketed = await metrics.runMetricQuery({
        view: "turns",
        timeDimension: { ...WINDOW, granularity: "day" },
      });
      const summed = bucketed.data.reduce((n, row) => n + row.rows, 0);
      t.ok(
        summed === turns_in_window,
        "every turn in the window lands in a bucket the response emits",
        summed === turns_in_window
          ? { actual: `${summed} across ${bucketed.data.length} daily buckets` }
          : {
              expected: turns_in_window,
              actual: `${summed} — ${turns_in_window - summed} rows fell outside width_bucket's range and would be missing from the chart`,
            },
      );

      const flat = await metrics.runMetricQuery({ view: "turns", timeDimension: WINDOW });
      t.ok(
        flat.coverage.matchedRows === turns_in_window,
        "the same window without bucketing counts the same rows",
        { actual: flat.coverage.matchedRows },
      );

      /* ── 3. coverage is the real count ────────────────────────────────── */

      const [truth] = (
        await client.query(
          `SELECT count(*)::int          AS total,
                  count(ttft_ms)::int    AS with_ttft,
                  count(cost_usd)::int   AS with_cost,
                  count(*) FILTER (WHERE priced IS FALSE)::int AS unpriced,
                  count(*) FILTER (WHERE outcome IN ('failed','no_model_call'))::int AS failed
             FROM evestack.fact_turn WHERE ${WHERE_WINDOW}`,
          bounds,
        )
      ).rows;

      const covered = await metrics.runMetricQuery({
        view: "turns",
        measures: [
          { measure: "ttft", aggregation: "p95" },
          { measure: "cost", aggregation: "sum" },
        ],
        timeDimension: WINDOW,
      });
      const ttftCoverage = covered.coverage.byMeasure.p95_ttft;
      t.ok(
        ttftCoverage.rows === truth.with_ttft && ttftCoverage.of === truth.total,
        "a TTFT chart reports how few turns it was computed from",
        {
          expected: `${truth.with_ttft} of ${truth.total}`,
          actual: `${ttftCoverage.rows} of ${ttftCoverage.of}`,
        },
      );
      const costCoverage = covered.coverage.byMeasure.sum_cost;
      t.ok(
        costCoverage.rows === truth.with_cost && costCoverage.of === truth.total,
        "a cost chart reports the turns it could not price",
        {
          expected: `${truth.with_cost} of ${truth.total}`,
          actual: `${costCoverage.rows} of ${costCoverage.of}`,
        },
      );
      t.ok(
        truth.with_ttft < truth.total,
        "the fixture actually exercises partial coverage rather than asserting a tautology",
        { actual: `${truth.with_ttft} of ${truth.total} turns have a TTFT` },
      );

      /* ── unpriced is not free ─────────────────────────────────────────── */

      const byModel = await metrics.runMetricQuery({
        view: "turns",
        measures: [{ measure: "cost", aggregation: "sum" }],
        dimensions: ["model"],
        timeDimension: WINDOW,
      });
      const unpriced = byModel.data.filter((row) => row.coverage.sum_cost === 0 && row.rows > 0);
      const free = byModel.data.filter((row) => row.sum_cost === 0 && row.coverage.sum_cost > 0);
      if (truth.unpriced > 0) {
        t.ok(
          unpriced.length > 0 && unpriced.every((row) => row.sum_cost === null),
          "a model nobody has priced comes back null, never $0.00",
          {
            actual: unpriced
              .map((row) => `${row.model}=${row.sum_cost} (${row.coverage.sum_cost}/${row.rows})`)
              .join(", "),
          },
        );
        t.ok(
          free.length > 0,
          "…and a model that really is free comes back as a priced zero, so the two are distinguishable",
          { actual: free.map((row) => `${row.model}=${row.sum_cost}`).join(", ") },
        );
      } else {
        t.note("no unpriced turns in this database — the free/unpriced split is unexercised");
      }

      /* ── 4. no third definition of failure ────────────────────────────── */

      const [monitors] = (
        await client.query(
          `SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE error_code IS NOT NULL)::int AS errored,
                  count(*) FILTER (
                    WHERE completed_at IS NOT NULL AND attributes ->> '$eve.model' IS NULL
                  )::int AS no_model_call
             FROM workflow.workflow_runs
            WHERE attributes ->> '$eve.type' IN ('turn', 'subagent')
              AND created_at >= ($1::timestamptz AT TIME ZONE 'utc')
              AND created_at <  ($2::timestamptz AT TIME ZONE 'utc')`,
          bounds,
        )
      ).rows;

      const rateResult = await metrics.runMetricQuery({
        view: "turns",
        measures: [{ measure: "failure_rate", aggregation: "avg" }],
        timeDimension: WINDOW,
      });
      const reported = num(rateResult.data[0]?.avg_failure_rate);
      const expected =
        monitors.total === 0 ? 0 : (monitors.errored + monitors.no_model_call) / monitors.total;
      const agrees = reported !== null && Math.abs(reported - expected) < 1e-12;
      t.ok(
        agrees,
        "failure_rate is lib/monitors.ts's failure rate, computed from workflow_runs directly",
        agrees
          ? { actual: `${(reported * 100).toFixed(2)}% of ${monitors.total} turns` }
          : { expected, actual: reported },
      );
      t.ok(
        monitors.no_model_call > 0,
        "…and the check is not vacuous: turns that finished without ever calling a model exist here",
        { actual: `${monitors.no_model_call} of ${monitors.total}` },
      );

      /* ── 5. a hostile value is inert ──────────────────────────────────── */

      const HOSTILE = "x'); DROP TABLE evestack.fact_turn; --";
      const hostile = await metrics.runMetricQuery({
        view: "turns",
        filters: [{ field: "model", operator: "eq", value: HOSTILE }],
        timeDimension: WINDOW,
      });
      t.ok(
        hostile.coverage.matchedRows === 0,
        "a SQL fragment used as a filter value matches nothing — it was compared, not executed",
        { actual: hostile.coverage.matchedRows },
      );
      // `to_regclass` renders unqualified when the schema is on the search
      // path, so the assertion is on existence rather than on the text.
      const [{ still_there }] = (
        await client.query("SELECT to_regclass('evestack.fact_turn') IS NOT NULL AS still_there")
      ).rows;
      t.ok(still_there === true, "…and the table it named is still there", {
        actual: still_there,
      });

      /* ── densification and ordering, on real rows ─────────────────────── */

      const fine = await metrics.runMetricQuery({
        view: "turns",
        measures: [
          { measure: "duration", aggregation: "p95" },
          { measure: "cost", aggregation: "sum" },
        ],
        timeDimension: {
          from: new Date(now - 3 * 3_600_000).toISOString(),
          to: new Date(now).toISOString(),
          granularity: "minute",
        },
      });
      t.ok(fine.data.length === 180, "a three-hour minute series is 180 buckets, present or not", {
        actual: fine.data.length,
      });
      const emptyBuckets = fine.data.filter((row) => row.rows === 0);
      t.ok(emptyBuckets.length > 0, "…and quiet minutes are emitted rather than skipped", {
        actual: `${emptyBuckets.length} of ${fine.data.length}`,
      });
      t.ok(
        emptyBuckets.every((row) => row.p95_duration === null && row.sum_cost === 0),
        "an empty bucket costs zero dollars and has no p95 — not a p95 of zero",
        {
          actual: emptyBuckets
            .slice(0, 1)
            .map((row) => `p95=${row.p95_duration} cost=${row.sum_cost}`)
            .join(""),
        },
      );

      const ranked = await metrics.runMetricQuery({
        view: "turns",
        measures: [{ measure: "ttft", aggregation: "p95" }],
        dimensions: ["model"],
        timeDimension: WINDOW,
        orderBy: [{ field: "p95_ttft", direction: "desc" }],
      });
      const nullsPresent = ranked.data.some((row) => row.p95_ttft === null);
      t.ok(
        !nullsPresent || ranked.data[0].p95_ttft !== null,
        "a top list by p95 does not open with the groups that have no p95",
        { actual: ranked.data.map((row) => `${row.model}=${row.p95_ttft}`).join(", ") },
      );

      /* ── truncation ───────────────────────────────────────────────────── */

      const cut = await metrics.runMetricQuery({
        view: "turns",
        dimensions: ["model"],
        timeDimension: WINDOW,
        limit: 2,
      });
      t.ok(
        cut.truncated === true && cut.data.length === 2,
        "a limit that cuts the result says so instead of looking complete",
        { actual: `truncated=${cut.truncated} rows=${cut.data.length}` },
      );

      /* ── filters actually filter ──────────────────────────────────────── */

      const failedOnly = await metrics.runMetricQuery({
        view: "turns",
        filters: [{ field: "outcome", operator: "in", value: ["failed", "no_model_call"] }],
        timeDimension: WINDOW,
      });
      t.ok(
        failedOnly.coverage.matchedRows === truth.failed,
        "an 'in' filter selects exactly the rows the same predicate selects in SQL",
        { expected: truth.failed, actual: failedOnly.coverage.matchedRows },
      );

      /* ── cost, so the next person knows whether to index ──────────────── */

      const started = performance.now();
      await metrics.runMetricQuery({
        view: "turns",
        measures: [
          { measure: "cost", aggregation: "sum" },
          { measure: "duration", aggregation: "p95" },
          { measure: "ttft", aggregation: "p95" },
        ],
        dimensions: ["model", "outcome"],
        timeDimension: { ...WINDOW, granularity: "day" },
      });
      const elapsed = performance.now() - started;
      t.note(
        `heaviest shape (3 measures, 2 dimensions, 61 daily buckets, ${turns_in_window} turns): ` +
          `${elapsed.toFixed(0)}ms including the fact refresh`,
      );
      t.ok(
        elapsed < 5_000,
        "a chart query answers without an index on fact_turn",
        { actual: `${elapsed.toFixed(0)}ms` },
      );
    } finally {
      process.chdir(cwd);
      await client.end();
      await db.getPool().end();
    }
  },
};
