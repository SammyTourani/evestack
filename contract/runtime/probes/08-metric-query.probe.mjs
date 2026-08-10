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
 *    lib/monitors.ts's `failed / finished`, computed here from
 *    `workflow.workflow_runs` rather than from the fact table, so a drift in
 *    either direction shows up. The denominator is FINISHED turns: a running or
 *    wedged turn is judged neither way, and the version of this that divided by
 *    every turn in the window scored each of them as a success — so a crashed
 *    agent lowered the reported failure rate. The turns left out are checked
 *    twice over, as their own measure and as the rate's coverage, because an
 *    exclusion nobody can see is the same lie in a quieter voice.
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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  WORKFLOW_RUNS_DDL,
  createFixtureDatabase,
  fixtureDatabaseUnavailable,
} from "../lib/fixture-db.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DASHBOARD = join(HERE, "../../../packages/dashboard");

async function connect(connectionString) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString });
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

  available: fixtureDatabaseUnavailable,

  async run(t) {
    // `runMetricQuery` refreshes the facts first, and lib/facts.ts reads its
    // DDL relative to the working directory — which is how the dashboard runs.
    // Restored in the `finally` below. Same move as probe 07.
    const cwd = process.cwd();
    const ambient = process.env.WORKFLOW_POSTGRES_URL;
    process.chdir(DASHBOARD);
    // The repo's one TypeScript-resolution shim; importing it registers an
    // in-thread resolve hook.
    await import(join(DASHBOARD, "test/register-ts-resolve.mjs"));
    const metrics = await import(join(DASHBOARD, "lib/metrics.ts"));
    const db = await import(join(DASHBOARD, "lib/db.ts"));

    // A window wide enough to hold the whole fixture.
    const now = Date.now();
    const WINDOW = {
      from: new Date(now - 60 * 86_400_000).toISOString(),
      to: new Date(now + 86_400_000).toISOString(),
    };
    const WHERE_WINDOW = "created_at >= $1::timestamptz AND created_at < $2::timestamptz";
    const bounds = [WINDOW.from, WINDOW.to];

    // One query against the CONFIGURED database before anything is repointed.
    // It is the same refresh this probe has always done there, and it doubles
    // as the warm-up for three once-per-process bootstraps — sql/traces.sql,
    // sql/facts.sql and sql/query-indexes.sql — which every later probe in this
    // shared process would otherwise inherit as "already applied" against a
    // database that no longer exists.
    await metrics.runMetricQuery({ view: "turns", timeDimension: WINDOW });

    const fixture = await createFixtureDatabase("metric-query");
    let client = null;
    try {
      client = await connect(fixture.url);
      await client.query(WORKFLOW_RUNS_DDL);
      // The shipped DDL, unmodified, at its real schema names.
      await client.query(readFileSync(join(DASHBOARD, "sql", "traces.sql"), "utf8"));
      await client.query(readFileSync(join(DASHBOARD, "sql", "facts.sql"), "utf8"));
      await seed(client, now);
      await db.closePool();
      process.env.WORKFLOW_POSTGRES_URL = fixture.url;

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

      // lib/monitors.ts's own predicates, spelled out against workflow_runs. The
      // denominator is FINISHED turns, not every turn in the window: a running
      // or wedged turn is judged neither way, and counting it as a success is
      // what used to make a crashed agent improve the reported failure rate.
      const [monitors] = (
        await client.query(
          `SELECT count(*)::int AS total,
                  count(*) FILTER (
                    WHERE NOT (completed_at IS NULL AND error_code IS NULL
                               AND status IS DISTINCT FROM 'cancelled')
                  )::int AS finished,
                  count(*) FILTER (
                    WHERE completed_at IS NULL AND error_code IS NULL
                      AND status IS DISTINCT FROM 'cancelled'
                  )::int AS unfinished,
                  count(*) FILTER (WHERE error_code IS NOT NULL)::int AS errored,
                  count(*) FILTER (
                    WHERE completed_at IS NOT NULL AND attributes ->> '$eve.model' IS NULL
                  )::int AS no_model_call,
                  count(*) FILTER (
                    WHERE error_code IS NOT NULL
                       OR (completed_at IS NOT NULL AND attributes ->> '$eve.model' IS NULL)
                  )::int AS failed
             FROM workflow.workflow_runs
            WHERE attributes ->> '$eve.type' IN ('turn', 'subagent')
              AND created_at >= ($1::timestamptz AT TIME ZONE 'utc')
              AND created_at <  ($2::timestamptz AT TIME ZONE 'utc')`,
          bounds,
        )
      ).rows;

      const rateResult = await metrics.runMetricQuery({
        view: "turns",
        measures: [
          { measure: "failure_rate", aggregation: "avg" },
          { measure: "unfinished", aggregation: "count" },
        ],
        timeDimension: WINDOW,
      });
      const reported = num(rateResult.data[0]?.avg_failure_rate);
      const expected = monitors.finished === 0 ? null : monitors.failed / monitors.finished;
      const agrees =
        expected === null
          ? reported === null
          : reported !== null && Math.abs(reported - expected) < 1e-12;
      t.ok(
        agrees,
        "failure_rate is lib/monitors.ts's failure rate, computed from workflow_runs directly",
        agrees
          ? {
              actual: `${((reported ?? 0) * 100).toFixed(2)}% of ${monitors.finished} finished turns`,
            }
          : { expected, actual: reported },
      );

      // The exclusion has to be visible, or "not judged" quietly becomes "fine".
      // Two independent statements of the same number: the measure asked for
      // directly, and the coverage of the rate above.
      const unfinishedReported = num(rateResult.data[0]?.count_unfinished);
      const judged = rateResult.coverage.byMeasure.avg_failure_rate;
      t.ok(
        unfinishedReported === monitors.unfinished,
        "the turns left out of the rate are reported as a count of their own",
        { expected: monitors.unfinished, actual: unfinishedReported },
      );
      t.ok(
        judged !== undefined && judged.rows === monitors.finished && judged.of === monitors.total,
        "…and the rate states its own denominator: finished turns of all turns in the window",
        {
          expected: `${monitors.finished} of ${monitors.total}`,
          actual: judged === undefined ? "no coverage" : `${judged.rows} of ${judged.of}`,
        },
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
      // closePool(), not getPool().end(). Both close the sockets; only one
      // clears the module global, and every probe in this tier shares a
      // process. Ending it here without forgetting it left the next probe that
      // imports a querying lib module — 16-schedule-streaks — holding a pool
      // that rejects everything with "Cannot use a pool after calling end on
      // the pool", before its first assertion. It failed on ordering, so it was
      // invisible to a single --only run and appeared the first time the whole
      // tier ran together in CI.
      //
      // It also has to happen BEFORE the fixture database is dropped, or the
      // pool is still holding a socket to it.
      await db.closePool().catch(() => {});
      if (ambient === undefined) delete process.env.WORKFLOW_POSTGRES_URL;
      else process.env.WORKFLOW_POSTGRES_URL = ambient;
      await client?.end().catch(() => {});
      const leaked = await fixture.dispose();
      if (leaked) t.note(leaked);
      process.chdir(cwd);
    }
  },
};

/**
 * The population, and why each row is here.
 *
 * ─ Why a fixture at all ─
 *
 * This probe used to read whatever database it was pointed at, and three of its
 * assertions were about the SHAPE of that data rather than about the code:
 * partial TTFT coverage, an unpriced model existing, and enough distinct models
 * for a LIMIT to truncate. On a real install those are properties of the
 * traffic. Two of them held on a seeded corpus and stopped holding on a small
 * one — and the TTFT one is worse than that: it was passing BECAUSE span
 * attribution was broken, so once turns were fully traced, every turn had a
 * TTFT and "partial coverage" became unsatisfiable. An anti-vacuity check that
 * fails when the product improves is a check nobody will keep.
 *
 * So the conditions are constructed here instead. Every one of them is now a
 * property of eight rows written three lines apart, which means the assertion
 * that reads it is about the query and not about the weather.
 *
 * ─ The eight turns ─
 *
 *   ok_ttft        priced model, chat span WITH a time-to-first-chunk
 *   ok_nottft      priced model, chat span WITHOUT one   <- partial TTFT coverage
 *   free           ollama, which the catalog prices at a REAL zero
 *   unpriced       a model the catalog has never heard of <- null, not $0.00
 *   no_model       finished, never called a model         <- outcome no_model_call
 *   errored        error_code set                         <- outcome failed
 *   running        no completed_at, no error              <- excluded from the rate
 *   yesterday      a second calendar day                  <- more than one daily bucket
 *
 * Three distinct model ids plus the null one is what makes `limit: 2` truncate,
 * and the first three sit inside the trailing three hours so the minute series
 * has both full and empty buckets in it.
 */
async function seed(client, now) {
  const stamp = (ms) => new Date(ms).toISOString().replace("T", " ").replace("Z", "");
  const SESSION = "wrun_fx_session";

  await client.query(
    `INSERT INTO workflow.workflow_runs (id, status, created_at, started_at, updated_at, attributes)
     VALUES ($1, 'completed', $2::timestamp, $2::timestamp, $2::timestamp,
             jsonb_build_object('$eve.type','session','$eve.trigger','http'))`,
    [SESSION, stamp(now - 40 * 3_600_000)],
  );

  let nano = BigInt(now - 40 * 3_600_000) * 1_000_000n;

  const addTurn = async (id, { model, at, done = true, errorCode = null, ttft = null }) => {
    const created = stamp(at);
    const completed = done ? stamp(at + 4_000) : null;
    const attributes = {
      "$eve.type": "turn",
      "$eve.root": SESSION,
      "$eve.parent": SESSION,
      "$eve.tool_count": "14",
      ...(model === null
        ? {}
        : {
            "$eve.model": model,
            "$eve.input_tokens": "1200",
            "$eve.output_tokens": "300",
            "$eve.cache_read_tokens": "100",
            "$eve.cache_write_tokens": "0",
          }),
    };
    await client.query(
      `INSERT INTO workflow.workflow_runs
         (id, status, error_code, created_at, started_at, completed_at, updated_at, attributes)
       VALUES ($1, $2, $3, $4::timestamp, $4::timestamp, $5::timestamp, $4::timestamp, $6::jsonb)`,
      [
        id,
        done ? (errorCode === null ? "completed" : "failed") : "running",
        errorCode,
        created,
        completed,
        JSON.stringify(attributes),
      ],
    );
    // One engine step per turn, so the LEFT JOIN LATERAL in sql/facts.sql has
    // something to count rather than proving only that it tolerates nothing.
    await client.query(
      `INSERT INTO workflow.workflow_steps (run_id, step_id, step_name, started_at, completed_at)
       VALUES ($1::varchar, $2::text, 'turnStep', $3::timestamp, $3::timestamp)`,
      [id, `${id}:1`, created],
    );
    if (model === null) return;

    nano += 1_000_000n;
    const chat = {
      "agent.turn.id": id,
      "agent.session.id": SESSION,
      "eve.environment": "production",
      "gen_ai.provider.name": model.split("/")[0],
      "gen_ai.response.finish_reasons": ["stop"],
      "gen_ai.client.operation.time_per_output_chunk": 0.02,
      ...(ttft === null ? {} : { "gen_ai.client.operation.time_to_first_chunk": ttft }),
    };
    await client.query(
      `INSERT INTO evestack.spans
         (trace_id, span_id, name, start_unix_nano, end_unix_nano, start_time, end_time, attributes)
       VALUES ($1, $2, $3, $4::bigint, $4::bigint + 1000000000, to_timestamp($4::bigint / 1e9),
               to_timestamp($4::bigint / 1e9) + interval '1 second', $5::jsonb)`,
      [`trace_${id}`, `${id}_chat`.slice(-16), `chat ${model.split("/")[1]}`, nano.toString(), JSON.stringify(chat)],
    );
    nano += 1_000_000n;
    await client.query(
      `INSERT INTO evestack.spans
         (trace_id, span_id, name, start_unix_nano, end_unix_nano, start_time, end_time, attributes)
       VALUES ($1, $2, 'execute_tool bash', $3::bigint, $3::bigint + 500000000,
               to_timestamp($3::bigint / 1e9),
               to_timestamp($3::bigint / 1e9) + interval '0.5 second', $4::jsonb)`,
      [`trace_${id}`, `${id}_tool`.slice(-16), nano.toString(), JSON.stringify({ "agent.turn.id": id })],
    );
  };

  await addTurn("wrun_fx_ok_ttft", { model: "openai/gpt-5-mini", at: now - 10 * 60_000, ttft: 0.42 });
  await addTurn("wrun_fx_ok_nottft", { model: "openai/gpt-5-mini", at: now - 45 * 60_000 });
  await addTurn("wrun_fx_free", { model: "ollama/qwen3", at: now - 2 * 3_600_000, ttft: 1.1 });
  await addTurn("wrun_fx_unpriced", { model: "acme/not-in-the-catalog", at: now - 5 * 3_600_000, ttft: 0.9 });
  await addTurn("wrun_fx_no_model", { model: null, at: now - 6 * 3_600_000 });
  await addTurn("wrun_fx_errored", {
    model: "openai/gpt-5-mini",
    at: now - 7 * 3_600_000,
    errorCode: "MODEL_CALL_FAILED",
    ttft: 0.5,
  });
  await addTurn("wrun_fx_running", { model: "openai/gpt-5-mini", at: now - 8 * 3_600_000, done: false });
  await addTurn("wrun_fx_yesterday", { model: "ollama/qwen3", at: now - 30 * 3_600_000, ttft: 0.7 });

  await client.query("ANALYZE workflow.workflow_runs");
  await client.query("ANALYZE evestack.spans");
}
