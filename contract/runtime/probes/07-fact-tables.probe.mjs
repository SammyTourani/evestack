/**
 * The fact tables must classify a turn the way the rest of the dashboard does,
 * and the incremental refresh must never lose a row or double one.
 *
 * ── Why a probe and not a unit test ──────────────────────────────────────────
 *
 * Nothing here is arithmetic. `outcome` is a CASE over four tables, `>=` versus
 * `>` on a shared timestamp is a property of how Postgres compares rows,
 * `ON CONFLICT DO UPDATE … WHERE ROW(…) IS DISTINCT FROM ROW(…)` is what makes a
 * repeat refresh free, and a watermark that skips a row skips it silently and
 * forever. Restating any of that in JavaScript would assert the restatement.
 *
 * ── The four things that go wrong ────────────────────────────────────────────
 *
 * 1. A THIRD DEFINITION OF FAILURE. `lib/monitors.ts` counts a turn as failed on
 *    `error_code`, and separately counts a FINISHED turn with no `$eve.model` as
 *    never having reached a provider. `lib/fleet.ts` was made to conform in W1.
 *    If `outcome` drifts from those two, the same turn is a failure on one page
 *    and a success on another. The outcome map below pins every arm, and the
 *    reconciliation at the end proves the populations are identical on real data.
 *
 * 2. THE STRICT WATERMARK. Rows share an `updated_at` — all 32,863 seeded spans
 *    share a `received_at` to the microsecond, because one COPY inserted them —
 *    and `>` drops every row after the first at a shared instant, permanently.
 *    Part 3 measures the strict comparison against the same data and shows it
 *    returning zero where the shipped `>=` returns the rows.
 *
 * 3. A FACT THAT GOES STALE. A run row is mutated after insert as its status
 *    changes, and spans for a turn land after the turn's row has stopped moving.
 *    Miss either and the table quietly describes a state the system left hours
 *    ago: a completed turn stuck at `running`, or a turn with full telemetry
 *    reported as having none.
 *
 * 4. A NUMBER THAT LIES. Zero tool calls and no telemetry at all are different
 *    facts. An unpriced model and a free one are different facts. Part 4 checks
 *    both against the real database, and checks every materialized dollar
 *    against `lib/pricing.ts` row by row.
 *
 * ── What this probe writes ───────────────────────────────────────────────────
 *
 * Parts 1–3 live in a scratch schema that is dropped at the end, including their
 * own copies of the `workflow` tables — that schema is world-postgres's and is
 * never written by us, so a probe that needs to complete a run has to own the
 * rows it mutates.
 *
 * Part 4 runs the SHIPPED `refreshFacts()` against the configured database and
 * therefore writes `evestack.fact_turn`, `evestack.fact_tool_call` and
 * `evestack.fact_watermark` for real. That is deliberate: those three tables
 * hold nothing that is not derived from `workflow.workflow_runs` and
 * `evestack.spans`, so building them costs nothing and cannot lose anything —
 * and testing a copy of the refresh instead of the refresh is how a probe passes
 * while the product is broken.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DASHBOARD = join(HERE, "../../../packages/dashboard");
const FACTS_SQL = join(DASHBOARD, "sql/facts.sql");
const TRACES_SQL = join(DASHBOARD, "sql/traces.sql");

/** Milliseconds, mirroring lib/facts.ts STUCK_TURN_MS. */
const STUCK_TURN_SECONDS = 3600;

/**
 * The schema version sql/facts.sql installs, read out of the file.
 *
 * Hardcoded here as `1` until the derivation of `environment` changed and the
 * file went to 2, at which point this probe failed on a correct change. The
 * number is the file's, not the probe's: reading it keeps the assertion about
 * what it is for — that a bump DROPS the tables — instead of about whether
 * someone remembered to edit two places.
 */
const FACTS_TARGET_VERSION = Number(
  /VALUES \('facts', (\d+)\)/.exec(readFileSync(FACTS_SQL, "utf8"))?.[1],
);

async function connect() {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.WORKFLOW_POSTGRES_URL });
  await client.connect();
  await client.query("SET statement_timeout = '60s'");
  return client;
}

/**
 * The real schema files, retargeted at a scratch schema.
 *
 * `sql/facts.sql` reads two schemas: everything it creates is `evestack.<name>`
 * and everything it reads from world-postgres is `workflow.workflow_<name>`.
 * Both prefixes are substituted, so the probe exercises the file that ships
 * rather than a paraphrase of it — the one property a probe cannot fake.
 */
function relocate(path, schema) {
  return readFileSync(path, "utf8")
    .replace("CREATE SCHEMA IF NOT EXISTS evestack;", `CREATE SCHEMA IF NOT EXISTS ${schema};`)
    .replaceAll("evestack.", `${schema}.`)
    .replaceAll("workflow.workflow_", `${schema}.workflow_`);
}

/**
 * Stand-ins for the two world-postgres tables the fact layer reads.
 *
 * Only the columns `sql/facts.sql` names, with the types the live database
 * reports (`\d workflow.workflow_runs`). Drift between this and the real table
 * should be read as this probe being stale, not as licence to widen it: the real
 * schema is not ours and this is a mirror of the part we depend on.
 */
function sourceTables(schema) {
  return `
    CREATE TABLE ${schema}.workflow_runs (
      id           varchar PRIMARY KEY,
      status       text      NOT NULL,
      error_code   varchar,
      error        text,
      created_at   timestamp NOT NULL,
      updated_at   timestamp NOT NULL,
      started_at   timestamp,
      completed_at timestamp,
      attributes   jsonb     NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE TABLE ${schema}.workflow_steps (
      run_id       varchar NOT NULL,
      step_id      varchar PRIMARY KEY,
      step_name    varchar NOT NULL,
      status       text    NOT NULL,
      attempt      integer NOT NULL,
      started_at   timestamp,
      completed_at timestamp
    );
    CREATE TABLE ${schema}.budget_events (
      id         bigserial PRIMARY KEY,
      session_id text NOT NULL,
      turn_id    text,
      action     text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `;
}

/** Rates in the shape lib/facts.ts sends: USD per million tokens, per class. */
const PRICES = JSON.stringify({
  "openai/gpt-5-mini": { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.25 },
});

/**
 * `minutesAgo` is relative to statement time, so a "wedged" turn is genuinely
 * older than the threshold rather than sitting at a hard-coded date that ages
 * into or out of the window depending on when the suite runs.
 */
async function addRun(client, schema, run) {
  const {
    id,
    type = "turn",
    session = "sess_1",
    model = "openai/gpt-5-mini",
    status = "completed",
    errorCode = null,
    error = null,
    startedMinutesAgo = 10,
    durationSeconds = 5,
    open = false,
    tokens = { input: 1000, output: 200, cacheRead: 100, cacheWrite: 50 },
    toolCount = 12,
  } = run;

  const attributes = {
    "$eve.type": type,
    "$eve.root": session,
    "$eve.parent": session,
    "$eve.tool_count": String(toolCount),
  };
  if (model !== null) {
    attributes["$eve.model"] = model;
    attributes["$eve.input_tokens"] = String(tokens.input);
    attributes["$eve.output_tokens"] = String(tokens.output);
    attributes["$eve.cache_read_tokens"] = String(tokens.cacheRead);
    attributes["$eve.cache_write_tokens"] = String(tokens.cacheWrite);
  }

  await client.query(
    `INSERT INTO ${schema}.workflow_runs
       (id, status, error_code, error, created_at, started_at, completed_at, updated_at, attributes)
     VALUES (
       $1, $2, $3, $4,
       (now() AT TIME ZONE 'utc') - make_interval(mins => $5::int),
       (now() AT TIME ZONE 'utc') - make_interval(mins => $5::int),
       CASE WHEN $6::boolean THEN NULL
            ELSE (now() AT TIME ZONE 'utc') - make_interval(mins => $5::int)
                 + make_interval(secs => $7::double precision)
       END,
       (now() AT TIME ZONE 'utc') - make_interval(mins => $5::int)
         + make_interval(secs => $7::double precision),
       $8::jsonb
     )`,
    [id, status, errorCode, error, startedMinutesAgo, open, durationSeconds, JSON.stringify(attributes)],
  );
}

async function addSession(client, schema, id, trigger) {
  await client.query(
    `INSERT INTO ${schema}.workflow_runs
       (id, status, created_at, started_at, updated_at, attributes)
     VALUES ($1, 'running', now() AT TIME ZONE 'utc', now() AT TIME ZONE 'utc',
             now() AT TIME ZONE 'utc',
             jsonb_build_object('$eve.type', 'session', '$eve.trigger', $2::text,
                                '$eve.title', 'probe session'))`,
    [id, trigger],
  );
}

async function addSpan(client, schema, span) {
  const { traceId, spanId, parent = null, name, attributes = {}, statusCode = 1, durationMs = 40 } = span;
  await client.query(
    `INSERT INTO ${schema}.spans
       (trace_id, span_id, parent_span_id, name, start_unix_nano, end_unix_nano,
        start_time, end_time, status_code, status_message, attributes)
     VALUES ($1, $2, $3, $4, 1000000, 1000000 + ($5::double precision * 1000000)::bigint,
             now(), now(), $6::int, CASE WHEN $6::int = 2 THEN 'tool exploded' END, $7::jsonb)`,
    [traceId, spanId, parent, name, durationMs, statusCode, JSON.stringify(attributes)],
  );
}

async function refresh(client, schema, { full = false } = {}) {
  const { rows } = await client.query(
    `SELECT * FROM ${schema}.refresh_facts(
       ${full ? "NULL::timestamp" : `(SELECT runs_watermark FROM ${schema}.fact_watermark WHERE component = 'fact_turn')`},
       ${full ? "NULL::timestamptz" : `(SELECT spans_watermark FROM ${schema}.fact_watermark WHERE component = 'fact_turn')`},
       $1::jsonb, $2::double precision)`,
    [PRICES, STUCK_TURN_SECONDS],
  );
  return rows[0];
}

async function outcomes(client, schema) {
  const { rows } = await client.query(`SELECT * FROM ${schema}.fact_turn`);
  return new Map(rows.map((r) => [r.run_id, r]));
}

const ids = (session, turn) => ({
  "ai.settings.context.eve.session.id": session,
  "ai.settings.context.eve.turn.id": turn,
});

export default {
  id: "facts/turn-and-tool-call-tables",
  title: "fact_turn classifies a turn the way monitors.ts does, and the watermark refresh loses nothing",
  needs: ["postgres"],
  why:
    "The fact layer is what every chart from W3 onwards reads, so a wrong classification or a dropped " +
    "row is wrong everywhere at once and looks confident doing it. Three specific ways it goes wrong " +
    "are silent: `outcome` becoming a third opinion on what a failure is, a strict `>` watermark " +
    "dropping every row that shares a timestamp with the last one processed, and a turn whose spans " +
    "arrived after its run row stopped moving being reported forever as having no telemetry.",

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
    const cwd = process.cwd();

    try {
      await client.query(relocate(TRACES_SQL, schema));
      await client.query(sourceTables(schema));
      await client.query(relocate(FACTS_SQL, schema));

      /* ------------------------------------------------------------------ */
      /* 1. outcome: every arm, and the precedence between them              */
      /* ------------------------------------------------------------------ */

      await addSession(client, schema, "sess_1", "slack");

      // The two lib/monitors.ts arms, first and untouchable.
      await addRun(client, schema, { id: "t_ok" });
      await addRun(client, schema, { id: "t_failed", status: "failed", errorCode: "provider_overloaded", error: "529" });
      await addRun(client, schema, { id: "t_nomodel", model: null });

      // error_code outranks an open turn: a turn that errored and never closed
      // is a failure, not a wedge. lib/fleet.ts makes the same distinction and
      // says so — "one written on error_code IS NOT NULL would call a failure a
      // wedge".
      await addRun(client, schema, {
        id: "t_failed_open",
        status: "running",
        errorCode: "provider_overloaded",
        open: true,
        startedMinutesAgo: 180,
      });

      await addRun(client, schema, { id: "t_cancelled", status: "cancelled" });

      // budget_stopped outranks cancelled, because @evestack/budget's default
      // mode cancels the turn: matching `cancelled` first would make every real
      // budget stop invisible and leave the arm reachable only from fixtures.
      await addRun(client, schema, { id: "t_budget", status: "completed" });
      await addRun(client, schema, { id: "t_budget_cancel", status: "cancelled" });
      await client.query(
        `INSERT INTO ${schema}.budget_events (session_id, turn_id, action) VALUES
           ('sess_1', 't_budget', 'cancel:cancelled'),
           ('sess_1', 't_budget_cancel', 'cancel:cancelled')`,
      );

      await addRun(client, schema, { id: "t_wedged", status: "running", open: true, startedMinutesAgo: 180 });
      await addRun(client, schema, { id: "t_running", status: "running", open: true, startedMinutesAgo: 1 });
      await addRun(client, schema, { id: "t_sub", type: "subagent" });

      // Steps, to prove the retry count survives both shapes a retry can take.
      await client.query(
        `INSERT INTO ${schema}.workflow_steps (run_id, step_id, step_name, status, attempt) VALUES
           ('t_ok', 's1', 'turnStep', 'completed', 1),
           ('t_ok', 's2', 'turnStep', 'failed', 2),
           ('t_ok', 's3', 'turnStep', 'completed', 3),
           ('t_ok', 's4', 'dispatchTurnStep', 'completed', 1)`,
      );

      await refresh(client, schema, { full: true });
      let facts = await outcomes(client, schema);

      const expected = {
        t_ok: "ok",
        t_failed: "failed",
        t_nomodel: "no_model_call",
        t_failed_open: "failed",
        t_cancelled: "cancelled",
        t_budget: "budget_stopped",
        t_budget_cancel: "budget_stopped",
        t_wedged: "wedged",
        t_running: "running",
        t_sub: "ok",
      };
      for (const [id, want] of Object.entries(expected)) {
        const got = facts.get(id)?.outcome;
        t.ok(got === want, `${id} is outcome "${want}"`, got === want ? {} : { expected: want, actual: got });
      }

      t.ok(
        facts.get("t_sub")?.run_type === "subagent" && facts.get("t_ok")?.run_type === "turn",
        "a subagent run is a fact row too, tagged so a caller can exclude it — lib/monitors.ts counts both",
        { actual: `${facts.get("t_sub")?.run_type} / ${facts.get("t_ok")?.run_type}` },
      );

      t.ok(
        facts.get("t_ok")?.trigger === "slack",
        "the session's $eve.trigger is joined onto the turn — a turn row carries no trigger of its own",
        { actual: facts.get("t_ok")?.trigger },
      );

      t.ok(
        facts.get("t_ok")?.step_count === 2 && facts.get("t_ok")?.retry_count === 2,
        "two distinct steps, two retries: attempts are collapsed per step name, so one-row-per-attempt " +
          "and attempt-bumped-in-place give the same answer",
        { expected: "2 steps / 2 retries", actual: `${facts.get("t_ok")?.step_count} / ${facts.get("t_ok")?.retry_count}` },
      );

      t.ok(
        facts.get("t_ok")?.provider === "openai" && facts.get("t_nomodel")?.provider === null,
        "provider is the half of $eve.model before the slash, and absent when no model was called",
        { actual: `${facts.get("t_ok")?.provider} / ${facts.get("t_nomodel")?.provider}` },
      );
      t.ok(
        facts.get("t_failed")?.error_code === "provider_overloaded" && facts.get("t_failed")?.error === "529",
        "the run row's error code and message are carried through, not just folded into outcome",
        { actual: `${facts.get("t_failed")?.error_code} / ${facts.get("t_failed")?.error}` },
      );
      t.ok(
        facts.get("t_ok")?.tools_offered === 12,
        "$eve.tool_count lands as tools_offered — the count of tools the model was GIVEN, which W1 " +
          "renamed because it had been rendered as the number it called",
        { expected: 12, actual: facts.get("t_ok")?.tools_offered },
      );

      // Timestamps and the two things derived from them. `workflow_runs` keeps
      // UTC in zone-less columns; the fact table keeps timestamptz, so a
      // conversion that guessed the server's zone would move every row by the
      // offset. This compares the two directly rather than trusting the cast.
      const { rows: clock } = await client.query(
        `SELECT count(*)::int AS n
           FROM ${schema}.fact_turn f
           JOIN ${schema}.workflow_runs r ON r.id = f.run_id
          WHERE f.created_at   = (r.created_at   AT TIME ZONE 'utc')
            AND f.started_at   IS NOT DISTINCT FROM (r.started_at   AT TIME ZONE 'utc')
            AND f.completed_at IS NOT DISTINCT FROM (r.completed_at AT TIME ZONE 'utc')`,
      );
      t.ok(
        clock[0].n === facts.size,
        "every timestamp is the zone-less UTC of its source read as UTC, not as the server's zone",
        { expected: facts.size, actual: clock[0].n },
      );
      t.ok(
        Math.round(facts.get("t_ok")?.duration_ms) === 5000 &&
          Math.round(facts.get("t_ok")?.output_tokens_per_second) === 40 &&
          facts.get("t_wedged")?.duration_ms === null,
        "duration is completed_at - started_at in milliseconds, throughput is derived from it, and an " +
          "unfinished turn has neither",
        {
          actual: `${facts.get("t_ok")?.duration_ms}ms / ${facts.get("t_ok")?.output_tokens_per_second} tok-s / ${facts.get("t_wedged")?.duration_ms}`,
        },
      );

      /* ------------------------------------------------------------------ */
      /* 2. span_coverage, and the difference between none and zero          */
      /* ------------------------------------------------------------------ */

      // A complete trace: the ids live on the ancestors, the model call and the
      // tool call declare nothing and inherit. That shape is not incidental —
      // it is what a real exporting install emits, pinned by
      // 06-span-attribution.probe.mjs.
      await addRun(client, schema, { id: "t_full" });
      await addSpan(client, schema, { traceId: "a".repeat(32), spanId: "a1".padEnd(16, "0"), name: "ai.eve.turn", attributes: { ...ids("sess_1", "t_full"), "eve.environment": "production" } });
      await addSpan(client, schema, { traceId: "a".repeat(32), spanId: "a2".padEnd(16, "0"), parent: "a1".padEnd(16, "0"), name: "step 1", attributes: ids("sess_1", "t_full") });
      await addSpan(client, schema, {
        traceId: "a".repeat(32),
        spanId: "a3".padEnd(16, "0"),
        parent: "a2".padEnd(16, "0"),
        name: "chat gpt-5-mini",
        attributes: {
          "gen_ai.client.operation.time_to_first_chunk": 0.42,
          "gen_ai.client.operation.time_per_output_chunk": 0.011,
          "gen_ai.response.finish_reasons": ["stop"],
        },
      });
      await addSpan(client, schema, {
        traceId: "a".repeat(32),
        spanId: "a4".padEnd(16, "0"),
        parent: "a2".padEnd(16, "0"),
        name: "execute_tool bash",
        attributes: {
          "gen_ai.tool.name": "bash",
          "gen_ai.tool.call.arguments": '{"command":"ls -la"}',
          "gen_ai.tool.call.result": "total 0",
        },
      });
      await addSpan(client, schema, {
        traceId: "a".repeat(32),
        spanId: "a5".padEnd(16, "0"),
        parent: "a2".padEnd(16, "0"),
        name: "execute_tool grep",
        statusCode: 2,
        attributes: { "gen_ai.tool.name": "grep" },
      });
      // Status 0, UNSET, and it is the common case rather than an edge one: a
      // tracer that only sets a status when something goes wrong emits UNSET for
      // every call that worked. Until facts v3 this fixture had no such span, so
      // `ok = status_code <> 2` recorded UNSET as a SUCCESS and nothing here
      // could see it — the assertion below said 0 and 1 were both "not a
      // failure" while only ever exercising 1. The column is nullable now and
      // the third state needs a row that reaches it. `zz` so the ORDER BY
      // tool_name below puts it last and the other two keep their indices.
      await addSpan(client, schema, {
        traceId: "a".repeat(32),
        spanId: "a6".padEnd(16, "0"),
        parent: "a2".padEnd(16, "0"),
        name: "execute_tool zz-unjudged",
        statusCode: 0,
        attributes: { "gen_ai.tool.name": "zz-unjudged" },
      });

      // The same trace with its tail gone: the run row proves a model call
      // happened and no span for it survived. This is what retention pruning or
      // a dropped exporter batch leaves behind.
      await addRun(client, schema, { id: "t_partial" });
      await addSpan(client, schema, { traceId: "b".repeat(32), spanId: "b1".padEnd(16, "0"), name: "ai.eve.turn", attributes: ids("sess_1", "t_partial") });
      await addSpan(client, schema, { traceId: "b".repeat(32), spanId: "b2".padEnd(16, "0"), parent: "b1".padEnd(16, "0"), name: "step 1", attributes: ids("sess_1", "t_partial") });

      // eve's OTHER telemetry vocabulary. A project with no
      // agent/instrumentation.ts gets the local tracer, whose model and tool
      // spans are called `ai.streamText.doStream` and `ai.toolCall` and whose
      // ids are `agent.*` rather than `ai.settings.context.eve.*`. Matching only
      // the exported names reads zero here — the mistake `getTraceStats()` was
      // deleted in W1 for making.
      await addRun(client, schema, { id: "t_local" });
      await addSpan(client, schema, { traceId: "c".repeat(32), spanId: "c1".padEnd(16, "0"), name: "agent.turn", attributes: { "agent.session.id": "sess_1", "agent.turn.id": "t_local" } });
      await addSpan(client, schema, { traceId: "c".repeat(32), spanId: "c2".padEnd(16, "0"), parent: "c1".padEnd(16, "0"), name: "ai.streamText.doStream", attributes: { "gen_ai.client.operation.time_to_first_chunk": 0.25 } });
      await addSpan(client, schema, { traceId: "c".repeat(32), spanId: "c3".padEnd(16, "0"), parent: "c1".padEnd(16, "0"), name: "ai.toolCall", attributes: { "gen_ai.tool.name": "recall" } });

      // A turn with two model calls, which is what a turn that used a tool looks
      // like: one call per step.
      await addRun(client, schema, { id: "t_multi" });
      await addSpan(client, schema, { traceId: "d".repeat(32), spanId: "d1".padEnd(16, "0"), name: "ai.eve.turn", attributes: ids("sess_1", "t_multi") });
      await addSpan(client, schema, {
        traceId: "d".repeat(32),
        spanId: "d2".padEnd(16, "0"),
        parent: "d1".padEnd(16, "0"),
        name: "chat gpt-5-mini",
        attributes: {
          "gen_ai.client.operation.time_to_first_chunk": 0.42,
          "gen_ai.client.operation.time_per_output_chunk": 0.01,
          "gen_ai.response.finish_reasons": ["tool-calls"],
        },
      });
      await addSpan(client, schema, {
        traceId: "d".repeat(32),
        spanId: "d3".padEnd(16, "0"),
        parent: "d1".padEnd(16, "0"),
        name: "chat gpt-5-mini",
        attributes: {
          "gen_ai.client.operation.time_to_first_chunk": 0.9,
          "gen_ai.client.operation.time_per_output_chunk": 0.02,
          "gen_ai.response.finish_reasons": ["stop"],
        },
      });
      // Later in wall-clock order, so "last model call" is unambiguous.
      await client.query(
        `UPDATE ${schema}.spans SET start_unix_nano = 9000000 WHERE span_id = $1`,
        ["d3".padEnd(16, "0")],
      );

      // A span that resolves to something that is not a turn. The refresh's
      // pending set is a union and its span arm contributes whatever
      // resolved_turn_id says, so this has to be filtered rather than left to
      // fail the run_type CHECK at 3am.
      await addSpan(client, schema, {
        traceId: "e".repeat(32),
        spanId: "e1".padEnd(16, "0"),
        name: "chat gpt-5-mini",
        attributes: ids("sess_1", "sess_1"),
      });

      await refresh(client, schema, { full: true });
      facts = await outcomes(client, schema);

      t.ok(
        !facts.has("sess_1"),
        "a span that resolves to a run which is not a turn is filtered out, not materialized as one",
        { actual: facts.has("sess_1") ? "sess_1 became a fact_turn row" : "absent" },
      );
      t.ok(
        facts.get("t_local")?.span_coverage === "full" &&
          facts.get("t_local")?.tools_called === 1 &&
          Math.round(facts.get("t_local")?.ttft_ms) === 250,
        "the local tracer's `ai.streamText.doStream` and `ai.toolCall` count as a model call and a tool " +
          "call — matching only the exported names reads zero on a laptop",
        { actual: `${facts.get("t_local")?.span_coverage} / ${facts.get("t_local")?.tools_called} / ${facts.get("t_local")?.ttft_ms}` },
      );
      t.ok(
        Math.round(facts.get("t_multi")?.ttft_ms) === 420 &&
          facts.get("t_multi")?.finish_reason === "stop" &&
          Math.round(facts.get("t_multi")?.time_per_output_chunk_ms) === 15,
        "over a turn's several model calls: TTFT is the first call's, the finish reason is the last " +
          "call's, and time-per-output-chunk is the mean",
        {
          expected: "420 / stop / 15",
          actual: `${facts.get("t_multi")?.ttft_ms} / ${facts.get("t_multi")?.finish_reason} / ${facts.get("t_multi")?.time_per_output_chunk_ms}`,
        },
      );

      t.ok(facts.get("t_full")?.span_coverage === "full", "a turn whose model call exported a span is `full`", {
        actual: facts.get("t_full")?.span_coverage,
      });
      t.ok(
        facts.get("t_partial")?.span_coverage === "partial",
        "a turn whose run row records a model but whose model span is missing is `partial`, not `full` — " +
          "this is the field that stops a TTFT chart averaging the turns that happened to export spans",
        { actual: facts.get("t_partial")?.span_coverage },
      );
      t.ok(facts.get("t_ok")?.span_coverage === "none", "a turn with no spans at all is `none`", {
        actual: facts.get("t_ok")?.span_coverage,
      });
      t.ok(
        facts.get("t_nomodel")?.span_coverage === "none" && facts.get("t_ok")?.tools_called === null,
        "and its tools_called is NULL, not 0 — no telemetry is not the same fact as no tool calls",
        { actual: `${facts.get("t_ok")?.tools_called}` },
      );
      // Three now, not two: bash (status 1), grep (status 2) and zz-unjudged
      // (status 0). The count is of execute_tool SPANS regardless of how they
      // ended — a call nobody judged still happened, and leaving it out here
      // would make `tools_called` disagree with the rows in fact_tool_call.
      t.ok(
        facts.get("t_full")?.tools_called === 3,
        "tools_called counts execute_tool spans, which is not $eve.tool_count — that is tools OFFERED",
        { expected: 3, actual: facts.get("t_full")?.tools_called },
      );
      t.ok(
        Math.round(facts.get("t_full")?.ttft_ms) === 420 &&
          Math.round(facts.get("t_full")?.time_per_output_chunk_ms) === 11,
        "TTFT and time-per-output-chunk arrive in seconds and are stored in milliseconds, like every " +
          "other duration here — @evestack/schedules summed MILLISECONDS and SECONDS once already",
        { expected: "420ms / 11ms", actual: `${facts.get("t_full")?.ttft_ms} / ${facts.get("t_full")?.time_per_output_chunk_ms}` },
      );
      t.ok(
        facts.get("t_full")?.finish_reason === "stop" && facts.get("t_full")?.environment === "production",
        "the finish reason and the environment come off the spans, and only off the spans",
        { actual: `${facts.get("t_full")?.finish_reason} / ${facts.get("t_full")?.environment}` },
      );

      const { rows: toolRows } = await client.query(
        `SELECT tool_name, ok, error_message, arguments_bytes, result_bytes, run_id, session_id,
                duration_ms, started_at
           FROM ${schema}.fact_tool_call WHERE run_id = 't_full' ORDER BY tool_name`,
      );
      const { rows: localTool } = await client.query(
        `SELECT tool_name FROM ${schema}.fact_tool_call WHERE run_id = 't_local'`,
      );
      t.ok(
        localTool.length === 1 && localTool[0].tool_name === "recall",
        "an `ai.toolCall` span names its tool in gen_ai.tool.name, not in the span name, and still lands",
        { actual: JSON.stringify(localTool) },
      );
      t.ok(
        toolRows.length === 3 &&
          toolRows[0].tool_name === "bash" &&
          toolRows[1].tool_name === "grep" &&
          toolRows[2].tool_name === "zz-unjudged",
        "each execute_tool span becomes one fact_tool_call row, resolved to its turn",
        { actual: JSON.stringify(toolRows.map((r) => r.tool_name)) },
      );
      t.ok(
        toolRows[0].ok === true && toolRows[1].ok === false && toolRows[1].error_message === "tool exploded",
        "OTel status 1 is a success and status 2 is a failure, with its message",
        { actual: `${toolRows[0].ok} / ${toolRows[1].ok} / ${toolRows[1].error_message}` },
      );
      t.ok(
        toolRows[2].ok === null,
        "OTel status 0 (UNSET) is recorded as unknown, not as a success",
        {
          expected: "ok === null",
          actual: `ok is ${JSON.stringify(toolRows[2].ok)}. ` +
            "`ok` was NOT NULL and computed as `status_code <> 2` until facts v3, so an " +
            "UNSET span — what every tracer that only sets a status on failure emits for a " +
            "call that WORKED — was stored as a success and averaged into a tool failure " +
            "rate that claimed 100% coverage.",
        },
      );
      t.ok(
        toolRows[0].arguments_bytes === 20 && toolRows[0].result_bytes === 7 && toolRows[1].arguments_bytes === null,
        "argument and result sizes are recorded where the exporter wrote them and NULL where it did not",
        { actual: `${toolRows[0].arguments_bytes}/${toolRows[0].result_bytes} vs ${toolRows[1].arguments_bytes}` },
      );
      t.ok(
        toolRows[0].run_id === "t_full" && toolRows[0].session_id === "sess_1",
        "an execute_tool span declares no ids at all; both come from W1's ancestor walk",
        { actual: `${toolRows[0].run_id} / ${toolRows[0].session_id}` },
      );
      t.ok(
        toolRows[0].duration_ms === 40 && toolRows[0].started_at instanceof Date,
        "a tool call carries the span's own duration and start, so a slow tool is findable without the trace",
        { actual: `${toolRows[0].duration_ms}ms at ${toolRows[0].started_at}` },
      );

      /* ------------------------------------------------------------------ */
      /* 3. the watermark                                                    */
      /* ------------------------------------------------------------------ */

      const before = await refresh(client, schema);
      t.ok(
        Number(before.turns_changed) === 0 && Number(before.tool_calls_changed) === 0,
        "re-running the refresh changes nothing — the boundary rows are re-read on purpose and rewriting " +
          "them has to be free",
        { actual: `${before.turns_changed} turns / ${before.tool_calls_changed} tool calls changed` },
      );

      const { rows: dupBefore } = await client.query(`SELECT count(*)::int AS n FROM ${schema}.fact_turn`);

      // Two runs stamped with EXACTLY the watermark's timestamp. This is not a
      // contrivance: `updated_at` is written by the engine at second-to-
      // microsecond resolution and concurrent turns collide there constantly.
      //
      // Stamped by sub-select rather than by reading the watermark into
      // JavaScript and sending it back, because that round trip is lossy in two
      // separate ways — node-pg parses a zone-less column in the host's zone,
      // and a JS Date holds milliseconds where Postgres holds microseconds. Both
      // move the value, which is why lib/facts.ts never lets it leave the server
      // either. Measured: doing it the other way put these rows BEHIND the
      // watermark and the refresh correctly ignored them, which reads exactly
      // like the bug this check is looking for.
      await addRun(client, schema, { id: "t_tie_a" });
      await addRun(client, schema, { id: "t_tie_b" });
      await client.query(
        `UPDATE ${schema}.workflow_runs
            SET updated_at = (SELECT runs_watermark FROM ${schema}.fact_watermark
                               WHERE component = 'fact_turn')
          WHERE id IN ('t_tie_a', 't_tie_b')`,
      );

      const { rows: strict } = await client.query(
        `SELECT count(*) FILTER (WHERE updated_at >  w.mark)::int AS gt,
                count(*) FILTER (WHERE updated_at >= w.mark)::int AS gte
           FROM ${schema}.workflow_runs,
                LATERAL (SELECT runs_watermark AS mark FROM ${schema}.fact_watermark
                          WHERE component = 'fact_turn') w
          WHERE attributes ->> '$eve.type' IN ('turn', 'subagent')`,
      );
      t.ok(
        strict[0].gt === 0 && strict[0].gte === 3,
        "the hazard is real on this data: a strict `>` sees none of the rows sharing the watermark instant, " +
          "`>=` sees all three",
        { expected: "gt=0 gte=3", actual: `gt=${strict[0].gt} gte=${strict[0].gte}` },
      );

      await refresh(client, schema);
      facts = await outcomes(client, schema);
      t.ok(
        facts.has("t_tie_a") && facts.has("t_tie_b"),
        "…and the shipped refresh materializes both of them. A `>` watermark would have lost them forever",
        { actual: `${facts.has("t_tie_a")} / ${facts.has("t_tie_b")}` },
      );

      const { rows: dupAfter } = await client.query(`SELECT count(*)::int AS n FROM ${schema}.fact_turn`);
      t.ok(
        dupAfter[0].n === dupBefore[0].n + 2,
        "re-reading the boundary rows adds no duplicates — the upsert is keyed on the run id",
        { expected: dupBefore[0].n + 2, actual: dupAfter[0].n },
      );

      // A run that completes AFTER its first refresh.
      const staleBefore = facts.get("t_running");
      await client.query(
        `UPDATE ${schema}.workflow_runs
            SET status = 'completed',
                completed_at = (now() AT TIME ZONE 'utc'),
                updated_at   = (now() AT TIME ZONE 'utc')
          WHERE id = 't_running'`,
      );
      const late = await refresh(client, schema);
      facts = await outcomes(client, schema);
      t.ok(
        facts.get("t_running")?.outcome === "ok" && facts.get("t_running")?.completed_at !== null,
        "a turn that finishes after its first refresh is updated, not left stale — this is the whole reason " +
          "the watermark is updated_at and not created_at",
        { expected: "ok", actual: facts.get("t_running")?.outcome },
      );
      t.ok(
        facts.get("t_running").source_updated_at > staleBefore.source_updated_at &&
          Number(late.turns_changed) >= 1,
        "…and the row records the newer updated_at it was rebuilt from",
        { actual: `${staleBefore.source_updated_at?.toISOString()} → ${facts.get("t_running").source_updated_at?.toISOString()}` },
      );

      // Spans that land after the run row stopped moving. Nothing about
      // t_partial's run row changes here; only the span watermark can see this.
      await addSpan(client, schema, {
        traceId: "b".repeat(32),
        spanId: "b3".padEnd(16, "0"),
        parent: "b2".padEnd(16, "0"),
        name: "chat gpt-5-mini",
        attributes: { "gen_ai.client.operation.time_to_first_chunk": 0.9 },
      });
      await addSpan(client, schema, {
        traceId: "b".repeat(32),
        spanId: "b4".padEnd(16, "0"),
        parent: "b2".padEnd(16, "0"),
        name: "execute_tool read",
        attributes: { "gen_ai.tool.name": "read" },
      });
      await refresh(client, schema);
      facts = await outcomes(client, schema);
      t.ok(
        facts.get("t_partial")?.span_coverage === "full" && facts.get("t_partial")?.tools_called === 1,
        "spans that arrive after the run row stopped moving still land: a batching exporter always delivers " +
          "them late, and a runs-only watermark would freeze span_coverage at `partial` forever",
        { actual: `${facts.get("t_partial")?.span_coverage} / ${facts.get("t_partial")?.tools_called}` },
      );

      // A tool span that goes away — retention pruning is a DELETE, and a
      // delete moves no watermark, so this only reconciles for a turn the
      // refresh is looking at anyway.
      await client.query(`DELETE FROM ${schema}.spans WHERE span_id = $1`, ["a5".padEnd(16, "0")]);
      await client.query(
        `UPDATE ${schema}.workflow_runs SET updated_at = (now() AT TIME ZONE 'utc') WHERE id = 't_full'`,
      );
      await refresh(client, schema);
      const { rows: afterPrune } = await client.query(
        `SELECT count(*)::int AS n FROM ${schema}.fact_tool_call WHERE run_id = 't_full'`,
      );
      // Two survive the prune of `a5`: bash and zz-unjudged. The number moves
      // with the fixture; what the assertion is about is that it moves DOWN by
      // exactly the one span that was deleted.
      t.ok(
        afterPrune[0].n === 2,
        "a tool call whose span was pruned is removed rather than left behind as a phantom invocation",
        { expected: 2, actual: afterPrune[0].n },
      );

      /* ------------------------------------------------------------------ */
      /* 3b. the two things that must not break the build                    */
      /* ------------------------------------------------------------------ */

      // @evestack/budget is optional and creates its tables on first use, so a
      // healthy install can have no budget_events at all.
      await client.query(`DROP TABLE ${schema}.budget_events`);
      await refresh(client, schema, { full: true });
      facts = await outcomes(client, schema);
      t.ok(
        facts.get("t_budget")?.outcome === "ok" && facts.get("t_budget_cancel")?.outcome === "cancelled",
        "an install that has never used @evestack/budget refreshes anyway, with no budget_events table to read",
        { actual: `${facts.get("t_budget")?.outcome} / ${facts.get("t_budget_cancel")?.outcome}` },
      );

      // The migration. These tables are a cache of a join, so a schema change
      // drops and rebuilds them; the version comparison is what fires, rather
      // than a probe of the shape being installed, because a guard that reads
      // the change it guards is false on every database that already has it.
      await client.query(`UPDATE ${schema}.schema_version SET version = 0 WHERE component = 'facts'`);
      await client.query(relocate(FACTS_SQL, schema));
      const { rows: rebuilt } = await client.query(
        `SELECT (SELECT count(*)::int FROM ${schema}.fact_turn) AS turns,
                (SELECT count(*)::int FROM ${schema}.fact_watermark) AS marks,
                (SELECT version FROM ${schema}.schema_version WHERE component = 'facts') AS version`,
      );
      t.ok(
        rebuilt[0].turns === 0 &&
          rebuilt[0].marks === 0 &&
          rebuilt[0].version === FACTS_TARGET_VERSION,
        "a version bump drops the derived tables and the watermark with them, so the next refresh is a full rebuild",
        { expected: `0 turns, 0 marks, version ${FACTS_TARGET_VERSION}`, actual: JSON.stringify(rebuilt[0]) },
      );

      await client.query(relocate(FACTS_SQL, schema));
      const { rows: reapplied } = await client.query(
        `SELECT (SELECT count(*)::int FROM ${schema}.fact_turn) AS facts,
                (SELECT count(*)::int FROM ${schema}.workflow_runs
                  WHERE attributes ->> '$eve.type' IN ('turn', 'subagent')) AS runs`,
      );
      await refresh(client, schema, { full: true });
      const { rows: rebuiltAgain } = await client.query(
        `SELECT (SELECT count(*)::int FROM ${schema}.fact_turn) AS facts,
                (SELECT count(*)::int FROM ${schema}.workflow_runs
                  WHERE attributes ->> '$eve.type' IN ('turn', 'subagent')) AS runs`,
      );
      t.ok(
        reapplied[0].facts === 0 && rebuiltAgain[0].facts === rebuiltAgain[0].runs,
        "applying the file a third time changes nothing, and the rebuild finds every turn in the source",
        { actual: `${reapplied[0].facts} before, ${rebuiltAgain[0].facts} of ${rebuiltAgain[0].runs} after` },
      );

      /* ------------------------------------------------------------------ */
      /* 4. the shipped refresh, against the real database                   */
      /* ------------------------------------------------------------------ */

      // lib/facts.ts and lib/traces.ts both read their DDL relative to the
      // working directory, which is how the dashboard runs. Restored below.
      process.chdir(DASHBOARD);
      // The repo's one TypeScript-resolution shim; importing it registers an
      // in-thread resolve hook. Copying it here instead would be a second copy
      // of the thing it exists to be the only copy of.
      await import(join(DASHBOARD, "test/register-ts-resolve.mjs"));
      const facts_ts = await import(join(DASHBOARD, "lib/facts.ts"));
      const pricing = await import(join(DASHBOARD, "lib/pricing.ts"));
      const db = await import(join(DASHBOARD, "lib/db.ts"));

      const first = await facts_ts.refreshFacts();
      t.note(
        `refreshed ${first.turnsExamined} turns and ${first.toolCallsExamined} tool calls in ` +
          `${first.elapsedMs.toFixed(0)}ms (${first.pricedModels} priced models, unpriced: ` +
          `${first.unpricedModels.join(", ") || "none"})`,
      );

      const [{ n: turnRows }] = await db.query("SELECT count(*)::int AS n FROM evestack.fact_turn");
      const second = await facts_ts.refreshFacts();
      const [{ n: turnRowsAgain }] = await db.query("SELECT count(*)::int AS n FROM evestack.fact_turn");
      t.ok(
        second.turnsChanged === 0 && second.toolCallsChanged === 0 && turnRowsAgain === turnRows,
        `a second refresh against the real database is a no-op: ${turnRows} rows before, ${turnRowsAgain} after, ` +
          `${second.turnsChanged} turns and ${second.toolCallsChanged} tool calls changed`,
        { actual: `${second.turnsChanged}/${second.toolCallsChanged} changed, ${turnRows} → ${turnRowsAgain}` },
      );

      const reconciliation = await facts_ts.reconcileFacts();
      t.ok(
        reconciliation.disagreements.length === 0,
        "every total in fact_turn equals the same total computed straight from workflow.workflow_runs: " +
          JSON.stringify(reconciliation.fact),
        { expected: "no disagreements", actual: reconciliation.disagreements.join(", ") },
      );
      t.ok(
        reconciliation.fact.errored === reconciliation.source.errored &&
          reconciliation.fact.noModelCall === reconciliation.source.noModelCall,
        "outcome `failed` and `no_model_call` reproduce lib/monitors.ts's two failure counts exactly — " +
          `${reconciliation.fact.errored} errored, ${reconciliation.fact.noModelCall} never reached a provider`,
        { actual: `${reconciliation.fact.errored}/${reconciliation.fact.noModelCall}` },
      );

      // Every materialized dollar, against lib/pricing.ts itself. The SQL does
      // the multiplication; this is the only thing that proves it is multiplying
      // by the rates pricing.ts would have charged.
      const costRows = await db.query(
        `SELECT run_id, model, priced, input_tokens, output_tokens, cache_read_tokens,
                cache_write_tokens, cost_usd, cost_input_usd, cost_output_usd,
                cost_cache_read_usd, cost_cache_write_usd
           FROM evestack.fact_turn`,
      );
      let worstDiff = 0;
      let partsMismatch = 0;
      let unpricedWithDollars = 0;
      let freeAndPriced = 0;
      for (const row of costRows) {
        if (row.priced === false && row.cost_usd !== null) unpricedWithDollars += 1;
        if (row.priced !== true) continue;
        const expectedCost = pricing.costUsd(
          row.model,
          Number(row.input_tokens ?? 0),
          Number(row.output_tokens ?? 0),
          Number(row.cache_read_tokens ?? 0),
          Number(row.cache_write_tokens ?? 0),
        );
        worstDiff = Math.max(worstDiff, Math.abs(expectedCost - Number(row.cost_usd)));
        const parts =
          Number(row.cost_input_usd) +
          Number(row.cost_output_usd) +
          Number(row.cost_cache_read_usd) +
          Number(row.cost_cache_write_usd);
        if (Math.abs(parts - Number(row.cost_usd)) > 1e-12) partsMismatch += 1;
        if (expectedCost === 0) freeAndPriced += 1;
      }
      t.ok(
        worstDiff < 1e-9 && partsMismatch === 0,
        `every cost in fact_turn equals lib/pricing.ts's costUsd() for the same tokens ` +
          `(${costRows.length} rows, worst difference ${worstDiff.toExponential(2)}), and the four ` +
          `decomposed classes sum to the total`,
        { actual: `worst ${worstDiff}, ${partsMismatch} rows whose parts miss the total` },
      );
      t.ok(
        unpricedWithDollars === 0 && (costRows.length === 0 || freeAndPriced > 0),
        "an unpriced model carries NULL rather than $0.00, and a model priced AT zero is still priced — " +
          `${costRows.filter((r) => r.priced === false).length} unpriced turns, ${freeAndPriced} free ones`,
        { actual: `${unpricedWithDollars} unpriced rows carrying a cost` },
      );

      const coverage = await db.query(
        `SELECT span_coverage, count(*)::int AS n, count(ttft_ms)::int AS with_ttft
           FROM evestack.fact_turn GROUP BY 1 ORDER BY 1`,
      );
      t.note(
        `span coverage on the real database: ${coverage
          .map((r) => `${r.span_coverage}=${r.n} (${r.with_ttft} with TTFT)`)
          .join(", ")}`,
      );
      const outcomeMix = await db.query(
        "SELECT outcome, count(*)::int AS n FROM evestack.fact_turn GROUP BY 1 ORDER BY 2 DESC",
      );
      t.note(`outcomes: ${outcomeMix.map((r) => `${r.outcome}=${r.n}`).join(", ")}`);
      t.ok(
        (await db.query("SELECT count(*)::int AS n FROM evestack.fact_tool_call"))[0].n ===
          (await db.query(
            "SELECT COALESCE(sum(tools_called), 0)::int AS n FROM evestack.fact_turn",
          ))[0].n,
        "every tool call counted on a turn has a row of its own, and vice versa",
      );
    } finally {
      process.chdir(cwd);
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
      await client.end();
    }
  },
};
