-- The fact layer: one row per turn, one row per tool invocation.
--
-- ── Why a table and not a view ───────────────────────────────────────────────
--
-- Every page in this dashboard is a full scan over `workflow.workflow_runs` with
-- the `$eve.*` attributes dug out of JSONB, joined to `evestack.spans` for
-- anything a run row does not know. That is fine for a list of 25 sessions and
-- hopeless for `percentile_cont` over a month, which is the shape every chart in
-- W3 onwards wants. So the join is done once, on write, and the charts read
-- columns.
--
-- These tables hold NOTHING you cannot rebuild. `DROP SCHEMA evestack CASCADE`
-- must never cost a durable session, and it does not cost one here: every value
-- below is derived from `workflow.workflow_runs`, `workflow.workflow_steps`,
-- `evestack.spans` and `evestack.budget_events`. That is also the migration
-- strategy — see the version guard at the top, which drops and rebuilds rather
-- than trying to ALTER a derived table into a new shape.
--
-- ── What this file may and may not touch ─────────────────────────────────────
--
-- The `workflow` schema belongs to `@workflow/world-postgres`. It is read here
-- and never written. Everything created below is `evestack.*`.
--
-- ── The refresh, and why the watermark is `>=` ───────────────────────────────
--
-- `evestack.refresh_facts` takes two watermarks because the facts have two
-- sources that move independently:
--
--   workflow_runs.updated_at   the run row, mutated in place as a turn runs
--   evestack.spans.received_at when the OTLP batch carrying its spans landed
--
-- The run watermark is the one W2's brief specifies, and it was verified against
-- 171 real non-seeded runs on 2026-08-06: 127 had moved past `created_at`, zero
-- had never moved, and all 171 sat within two seconds of their last known state
-- change. `created_at` would have missed every completion.
--
-- The span watermark is not optional either. Spans for a turn arrive after the
-- turn's run row has stopped moving — that is what a batching exporter does — so
-- a refresh driven by `updated_at` alone would freeze `span_coverage` at 'none'
-- for turns that did export spans, which is the "a metric over partial data must
-- say so" rule failing in the direction that lies.
--
-- BOTH comparisons are `>=`, never `>`. `updated_at` has sub-second resolution
-- but rows genuinely share a timestamp — 3,322 seeded runs land on 3,038
-- distinct `updated_at` values — and a strict `>` drops every row after the
-- first one at a shared instant, permanently. `>=` re-reads the boundary rows
-- instead, and the upsert makes re-reading a row free. The probe proves this by
-- running the strict comparison against the same data and watching rows vanish.
--
-- ── One thing the incremental path does NOT see ──────────────────────────────
--
-- Deletes. `evestack.prune_spans()` removes spans on a retention window, and a
-- delete moves no watermark, so tool-call rows for pruned spans survive until a
-- full rebuild. A full rebuild is `DELETE FROM evestack.fact_watermark` followed
-- by a refresh, and it is cheap: 3,322 runs and 32,863 spans rebuild in ~100ms.
--
-- One cost worth knowing before this meets a large table: each refresh reads
-- `max(received_at)` over `evestack.spans` and scans it once for the turns whose
-- spans moved, and there is no index on `received_at` — measured at 32,863 spans
-- that is not worth one. Whoever builds the query API will index this table for
-- its own access patterns and can add it there, with a plan to point at.
--
-- ── Fields deliberately absent ───────────────────────────────────────────────
--
-- W2's brief lists three more identity fields and one more cost class. They are
-- not here because nothing emits them, and a column that is NULL on every row of
-- every install is worse than an absent one — it looks like data that failed to
-- arrive.
--
--   agent        eve writes `$eve.subagent` (a subagent's node id) and nothing
--                else. A top-level turn has no agent name in the run row at all.
--   channel      eve records `$eve.trigger` on the session and
--                `$eve.channel_request_id` on the turn. Neither is a channel
--                name. `trigger` below is the honest version of this dimension.
--   reasoning    no reasoning token count exists anywhere in eve's run
--                attributes or in the AI SDK's `gen_ai.usage.*`. Datadog splits
--                cost five ways; we can honestly split it four.

/*
 * ONE TRANSACTION, AND THAT IS LOAD-BEARING.
 *
 * The guard below refuses to touch a database newer than this file. The refusal
 * is only worth anything if the statements AFTER it cannot run anyway, and the
 * two ways this file gets applied disagree about that:
 *
 *   the dashboard  sends the whole file as one query, which Postgres already
 *                  runs as a single implicit transaction
 *   `psql -f`      runs a statement per transaction and, without
 *                  `ON_ERROR_STOP`, keeps going after an error — so the guard
 *                  raised, psql printed it, and psql ran every statement after
 *                  it anyway. Measured against a live v4 database and
 *                  sql/traces.sql, which duly put its v3 resolver back. The
 *                  behaviour is psql's, not one file's, so both files carry this.
 *
 * BEGIN/COMMIT makes both paths agree: after the guard raises, everything else
 * is a no-op inside an aborted transaction and the COMMIT rolls it back. Piping
 * this into `psql -1` adds two harmless "already/no transaction in progress"
 * warnings; nothing else changes.
 *
 * Nothing in this file refuses a transaction block — no CONCURRENTLY, no
 * VACUUM. Anything added that does has to be moved out past the COMMIT, and
 * then it is outside the guard and has to be safe on any version.
 *
 * Applying by hand: `psql -v ON_ERROR_STOP=1 -f <this file>`. Without the flag
 * the outcome is identical, it just prints one "current transaction is aborted"
 * line per skipped statement under the one error that matters.
 */
BEGIN;

CREATE SCHEMA IF NOT EXISTS evestack;

CREATE TABLE IF NOT EXISTS evestack.schema_version (
  component  text PRIMARY KEY,
  version    integer NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

/*
 * REFUSE TO RUN AT ALL AGAINST A DATABASE NEWER THAN THIS FILE.
 *
 * Same guard, same position and the same reasoning as `sql/traces.sql`'s, and
 * this file needed it more: the block below DROPS all three fact tables
 * whenever the marker is not the version it expects, and `CREATE OR REPLACE
 * FUNCTION evestack.refresh_facts` at the bottom is unconditional. So an older
 * image did not merely fail to upgrade a newer database — it dropped that
 * database's fact tables, rebuilt them in the older shape, put the older
 * refresh function back and then stamped the marker back down to its own
 * version, all without a word.
 *
 * First in the file for the reason traces.sql gives: piped into `psql` this is
 * a statement per transaction, so a guard placed after the DDL would only ever
 * be an opinion about work already committed.
 */
DO $guard$
DECLARE
  -- Must equal the `target` in the migration immediately below and the version
  -- stamped further down; test/schema-guard.test.mjs reads all three out of the
  -- file and fails if they part.
  target    constant integer := 3;
  installed integer;
BEGIN
  SELECT version INTO installed FROM evestack.schema_version WHERE component = 'facts';
  IF COALESCE(installed, 0) > target THEN
    RAISE EXCEPTION
      'evestack fact tables are at schema version %, and this build of evestack only understands version %. Nothing was applied: an older image must leave a newer database alone rather than half-downgrade it. Run the image that installed version %, or drop the evestack schema to rebuild the fact layer from scratch.',
      installed, target, installed
      USING ERRCODE = 'EV001';
  END IF;
END $guard$;

-- The migration, such as it is. These tables are a cache of a join, so a schema
-- change drops them and lets the next refresh rebuild — which is both correct
-- and the only strategy that cannot leave a column half-populated.
--
-- Written as a version comparison rather than as a probe of the current shape.
-- `sql/traces.sql` learned that the hard way: its first migration was gated on
-- the text of the expression it was about to install, so the guard was false on
-- every database that already had the change and the migration was silently
-- inert exactly where it was needed.
--
-- Version 2 changed no column. It changed how `environment` is DERIVED — the
-- old expression read a key that is on none of the spans an exporting install
-- sends — and a derivation change is exactly what this mechanism is for: the
-- watermark would otherwise leave every already-materialized row holding the
-- old answer forever, which is the same "silently inert on the databases that
-- need it" failure the comment above describes.
--
-- Version 3 changes both. `fact_tool_call.ok` goes from `boolean NOT NULL` to
-- nullable, because `status_code <> 2` recorded OTel UNSET — the status every
-- tracer that only reports failures emits — as a tool SUCCESS, and a NOT NULL
-- column made the coverage count 100% while it did it. Every row already
-- materialized holds that wrong answer, and no watermark would ever revisit it,
-- so the table has to be rebuilt rather than left to catch up. The DROP below
-- does that for all three tables, and dropping fact_watermark with them is what
-- turns the next refresh into a full rebuild rather than an incremental pass
-- over a table that no longer exists.
--
-- `IS DISTINCT FROM` and not `<`, because NULL — never refreshed — has to drop
-- too. The downgrade half of it is unreachable: the guard above has already
-- refused anything ahead of `target`.
DO $$
DECLARE
  target    constant integer := 3;
  installed integer;
BEGIN
  SELECT version INTO installed FROM evestack.schema_version WHERE component = 'facts';
  IF installed IS DISTINCT FROM target THEN
    DROP TABLE IF EXISTS evestack.fact_tool_call;
    DROP TABLE IF EXISTS evestack.fact_turn;
    DROP TABLE IF EXISTS evestack.fact_watermark;
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* fact_turn                                                                   */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS evestack.fact_turn (
  run_id      text PRIMARY KEY,
  -- 'turn' or 'subagent'. Both are units of work and lib/monitors.ts counts
  -- both; a caller that wants only top-level turns filters on this.
  run_type    text NOT NULL,
  -- `$eve.root`, which is the session for a turn AND for a subagent. `$eve.parent`
  -- is not usable here: on a subagent it points at the turn, not the session.
  session_id  text,
  -- The session's `$eve.trigger`: slack, http, webhook, schedule.
  trigger     text,
  -- `eve.environment`, from the turn's root span. NULL where no spans landed.
  environment text,
  model       text,
  -- The half of `$eve.model` before the slash. eve's model ids are always
  -- `provider/model`, and the provider is also on the spans as
  -- `gen_ai.provider.name` — but only where spans landed, and this is needed on
  -- every row.
  provider    text,

  created_at   timestamptz NOT NULL,
  started_at   timestamptz,
  completed_at timestamptz,
  -- completed_at - started_at, never created_at: a run can sit queued and queue
  -- time is not latency. Same rule as lib/monitors.ts.
  duration_ms  double precision,

  -- Span-derived, so NULL on the ~80% of a realistic month that has no spans.
  -- Seconds on the wire, milliseconds here, because every other duration in this
  -- schema is milliseconds and a mixed-unit table is how @evestack/schedules
  -- summed MILLISECONDS and SECONDS into one number.
  ttft_ms                  double precision,
  time_per_output_chunk_ms double precision,
  -- Derived from the run row, so it survives having no spans.
  output_tokens_per_second double precision,

  -- As eve reports them. `input_tokens` is the TOTAL and already contains the
  -- two cache classes; the non-cached remainder is derived in the cost columns
  -- rather than stored, so there is exactly one place that subtraction happens.
  input_tokens       bigint,
  output_tokens      bigint,
  cache_read_tokens  bigint,
  cache_write_tokens bigint,

  -- TRUE priced, FALSE the catalog has no entry, NULL no model call happened.
  -- Three states because two would lie: an unpriced model is not a free one, and
  -- a turn that never reached a provider is neither.
  priced              boolean,
  -- NULL, never 0, when `priced` is not TRUE. SUM() skips NULLs, so an unpriced
  -- model contributes nothing to spend instead of contributing a confident zero.
  cost_input_usd      numeric(20,10),
  cost_output_usd     numeric(20,10),
  cost_cache_read_usd numeric(20,10),
  cost_cache_write_usd numeric(20,10),
  cost_usd            numeric(20,10),

  step_count  integer,
  retry_count integer,

  -- `$eve.tool_count` is how many tools the model was OFFERED. It is not how
  -- many it called, and the two were the same column until W1.
  tools_offered integer,
  -- Counted from `execute_tool` spans, so NULL — not 0 — when no spans landed.
  tools_called  integer,

  finish_reason text,
  error_code    text,
  error         text,

  outcome       text NOT NULL,
  span_coverage text NOT NULL,

  -- The `workflow_runs.updated_at` this row was built from. Naive UTC, like its
  -- source: see the note on the watermark table.
  source_updated_at timestamp NOT NULL,

  CONSTRAINT fact_turn_run_type CHECK (run_type IN ('turn', 'subagent')),
  CONSTRAINT fact_turn_outcome CHECK (
    outcome IN ('ok', 'failed', 'no_model_call', 'cancelled', 'budget_stopped', 'wedged', 'running')
  ),
  CONSTRAINT fact_turn_span_coverage CHECK (span_coverage IN ('none', 'partial', 'full'))
);

-- No secondary indexes on this table yet, on purpose. The obvious four
-- (created_at, session, model, outcome) would all be guesses: nothing queries
-- fact_turn today except the refresh, which goes through the primary key, and
-- the reconciliation, which aggregates the whole table. The query API is what
-- knows its own access patterns, and an index nobody's plan uses is write cost
-- with no read to pay for it.

/* -------------------------------------------------------------------------- */
/* fact_tool_call                                                              */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS evestack.fact_tool_call (
  -- The span's own key. `evestack.spans` is keyed on (trace_id, span_id) and a
  -- tool call IS a span, so this table inherits that identity rather than
  -- inventing one that could disagree with it.
  trace_id text NOT NULL,
  span_id  text NOT NULL,
  -- The turn and session the span RESOLVES to. An `execute_tool` span declares
  -- neither; W1's ancestor walk puts them on the row. A tool span that resolves
  -- to no turn is not materialized at all — it cannot be attributed, grouped or
  -- charted, and inventing a turn for it is the "missing is not zero" failure
  -- applied to ids. `session_id` is separately nullable: the walk can find a
  -- turn on a trace whose session id was never declared.
  run_id     text NOT NULL,
  session_id text,

  tool_name   text NOT NULL,
  started_at  timestamptz NOT NULL,
  duration_ms double precision,
  /*
   * OTel status: 2 is ERROR, 1 is OK, and 0 is UNSET — WHICH IS NOT A VERDICT.
   *
   * NULLABLE, and that is the whole column. This was `boolean NOT NULL` written
   * as `status_code <> 2`, so UNSET recorded as a SUCCESS — and UNSET is what
   * every tracer that only sets a status on failure emits, which is most of
   * them and all of eve's exported tool spans. The failure rate over such an
   * install was therefore 0% by construction, and because the column could not
   * be NULL the coverage count said 100%: a confident answer, complete,
   * unanimous and derived from nothing. That is the same defect as the turn
   * failure rate one view over, which lib/metrics.ts fixed by making its first
   * arm NULL so `avg()` drops the unjudged rows from the numerator AND the
   * denominator instead of scoring them as wins.
   *
   * A reader has to handle three states, and every one of them is real:
   * true (the tracer said OK), false (the tracer said ERROR), NULL (the tracer
   * said nothing, so this dashboard does not know). Aggregations must exclude
   * NULL rather than bucket it — `avg(CASE WHEN ok IS NULL THEN NULL ...)` —
   * and anything rendering a badge must have an "unknown" that is not "failed".
   */
  ok            boolean,
  error_message text,
  -- Byte length of the recorded call arguments and result. NULL when the
  -- exporter did not record them, which is the common case: eve's own tracer
  -- writes `gen_ai.tool.call.*` and the AI SDK's exported spans do not.
  arguments_bytes integer,
  result_bytes    integer,

  PRIMARY KEY (trace_id, span_id)
);

-- This one is not speculative: the refresh deletes tool calls whose span is gone
-- by joining this column against the set of turns it is rebuilding.
CREATE INDEX IF NOT EXISTS fact_tool_call_run_idx ON evestack.fact_tool_call (run_id);

/* -------------------------------------------------------------------------- */
/* the watermark                                                               */
/* -------------------------------------------------------------------------- */

-- One row per source. Absent means "never refreshed", which is how a full
-- rebuild is requested: delete the row.
--
-- `runs_watermark` is `timestamp WITHOUT time zone` on purpose, and this is not
-- cosmetic. `workflow_runs.updated_at` is a zone-less column holding UTC. Storing
-- our copy as `timestamptz` would make the comparison naive-against-aware, which
-- Postgres resolves using the SERVER's TimeZone — so the watermark would jump by
-- the offset the moment anyone ran this outside UTC, and the refresh would either
-- re-read the last eight hours or skip them. lib/fleet.ts hit exactly this and
-- documents it. `spans.received_at` really is timestamptz, so that one is.
CREATE TABLE IF NOT EXISTS evestack.fact_watermark (
  component       text PRIMARY KEY,
  runs_watermark  timestamp,
  spans_watermark timestamptz
);

-- FORWARD ONLY, like traces.sql's. Without the WHERE this line was the second
-- half of the downgrade: an older image stamped its own lower number over a
-- newer one, and the next boot of the newer image then saw a version it had
-- "already applied". The guard at the top of the file is what stops the
-- downgrade; this is what stops the marker lying about it if one ever gets past.
INSERT INTO evestack.schema_version (component, version)
VALUES ('facts', 3)
ON CONFLICT (component) DO UPDATE
  SET version = EXCLUDED.version, applied_at = now()
  WHERE evestack.schema_version.version < EXCLUDED.version;

/* -------------------------------------------------------------------------- */
/* the refresh                                                                 */
/* -------------------------------------------------------------------------- */

-- `p_prices` is `{"provider/model": {"input": n, "output": n, "cacheRead": n,
-- "cacheWrite": n}}`, in USD per million tokens, built by lib/facts.ts from
-- lib/pricing.ts. A model absent from the object is UNPRICED, not free.
--
-- Rates are passed in rather than looked up here because lib/pricing.ts owns
-- both the catalog and its fallbacks (a missing cache-read rate is a tenth of
-- input; a missing cache-write rate is the full input rate, never zero). Copying
-- those rules into SQL would be a second definition of pricing policy, and this
-- codebase already knows what a second definition costs. What SQL does below is
-- multiplication and division only.
--
-- `p_stuck_turn_seconds` is lib/fleet.ts's STUCK_TURN_MS. It is a parameter and
-- not a literal so that there is one such number in the codebase; lib/facts.ts
-- supplies it and a test reads fleet.ts to prove the two still agree.
--
-- The watermarks are not returned. They are written to `evestack.fact_watermark`
-- and read back from there, which keeps the OUT parameter names from colliding
-- with that table's columns inside plpgsql.
CREATE OR REPLACE FUNCTION evestack.refresh_facts(
  p_runs_since         timestamp,
  p_spans_since        timestamptz,
  p_prices             jsonb,
  p_stuck_turn_seconds double precision
) RETURNS TABLE (
  turns_examined      bigint,
  turns_changed       bigint,
  tool_calls_examined bigint,
  tool_calls_changed  bigint
)
LANGUAGE plpgsql
AS $function$
DECLARE
  v_turns_examined  bigint := 0;
  v_turns_changed   bigint := 0;
  v_tools_examined  bigint := 0;
  v_tools_changed   bigint := 0;
  v_runs_watermark  timestamp;
  v_spans_watermark timestamptz;
BEGIN
  -- The watermarks are read BEFORE anything is written, from the source tables
  -- themselves. Taking them from the rows this call happens to process would
  -- park the watermark at the newest row seen, and a row inserted between the
  -- SELECT and the COMMIT would then be behind it forever.
  SELECT max(r.updated_at) INTO v_runs_watermark
  FROM workflow.workflow_runs r
  WHERE r.attributes ->> '$eve.type' IN ('turn', 'subagent');

  SELECT max(s.received_at) INTO v_spans_watermark FROM evestack.spans s;

  -- Turns to rebuild: the run row moved, OR a span that resolves to it landed.
  --
  -- The second arm is also what covers a span that was re-resolved rather than
  -- re-received. W1's resolver backfills a child when its parent finally
  -- arrives, and that UPDATE does not move the child's `received_at` — but the
  -- parent's own `received_at` is new, the parent resolves to the same turn, so
  -- the turn is in this set and every one of its spans is re-read below.
  CREATE TEMP TABLE touched_turns ON COMMIT DROP AS
  SELECT r.id
  FROM workflow.workflow_runs r
  WHERE r.attributes ->> '$eve.type' IN ('turn', 'subagent')
    AND (p_runs_since IS NULL OR r.updated_at >= p_runs_since)
  UNION
  SELECT DISTINCT s.resolved_turn_id
  FROM evestack.spans s
  WHERE s.resolved_turn_id IS NOT NULL
    AND (p_spans_since IS NULL OR s.received_at >= p_spans_since);

  CREATE UNIQUE INDEX ON touched_turns (id);
  ANALYZE touched_turns;

  -- @evestack/budget is optional and creates its own tables the first time it
  -- charges a step, so an install that has never used it has no
  -- `evestack.budget_events` at all. Reading it unguarded would make the entire
  -- fact layer fail to build on a perfectly healthy database.
  CREATE TEMP TABLE budget_stopped_turns (turn_id text PRIMARY KEY) ON COMMIT DROP;
  IF to_regclass('evestack.budget_events') IS NOT NULL THEN
    INSERT INTO budget_stopped_turns (turn_id)
    SELECT DISTINCT be.turn_id
    FROM evestack.budget_events be
    WHERE be.turn_id IS NOT NULL;
  END IF;

  WITH source AS (
    SELECT
      r.id,
      r.attributes ->> '$eve.type'  AS run_type,
      r.attributes ->> '$eve.root'  AS session_id,
      r.attributes ->> '$eve.model' AS model,
      r.created_at,
      r.started_at,
      r.completed_at,
      r.updated_at,
      r.status,
      r.error_code,
      r.error,
      (r.attributes ->> '$eve.tool_count')::bigint        AS tools_offered,
      (r.attributes ->> '$eve.input_tokens')::bigint      AS input_tokens,
      (r.attributes ->> '$eve.output_tokens')::bigint     AS output_tokens,
      (r.attributes ->> '$eve.cache_read_tokens')::bigint  AS cache_read_tokens,
      (r.attributes ->> '$eve.cache_write_tokens')::bigint AS cache_write_tokens,
      CASE
        WHEN r.completed_at IS NOT NULL AND r.started_at IS NOT NULL
        THEN EXTRACT(EPOCH FROM (r.completed_at - r.started_at)) * 1000
      END AS duration_ms,
      sess.attributes ->> '$eve.trigger' AS trigger,
      -- A budget stop is recorded against the exact turn it cut short:
      -- @evestack/budget's hook writes `budget_events` only after a verdict has
      -- exceeded, and then either throws (eve marks the turn failed) or calls
      -- cancelTurn. Both call sites carry that turn's id, so the presence of ANY
      -- row here means the budget stopped this turn. The `action` value is NOT
      -- matched on: the real values are 'turn-failed' and 'cancel:<status>'.
      EXISTS (SELECT 1 FROM budget_stopped_turns b WHERE b.turn_id = r.id) AS budget_stopped,
      st.step_count,
      st.retry_count,
      sp.span_count,
      sp.model_span_count,
      sp.tool_span_count,
      sp.environment,
      sp.ttft_ms,
      sp.time_per_output_chunk_ms,
      sp.finish_reason
    FROM workflow.workflow_runs r
    JOIN touched_turns t ON t.id = r.id
    LEFT JOIN workflow.workflow_runs sess
      ON sess.id = r.attributes ->> '$eve.root'
     AND sess.attributes ->> '$eve.type' = 'session'
    LEFT JOIN LATERAL (
      -- Steps first collapsed per step NAME, because the two shapes a retry can
      -- take must produce the same answer: world-postgres bumps `attempt` on the
      -- existing row, and a fixture may write one row per attempt. max(attempt)
      -- per name is right for both, and `attempt` is 1-based so retries are one
      -- less than that.
      SELECT count(*)::int AS step_count,
             COALESCE(sum(max_attempt), 0)::int - count(*)::int AS retry_count
      FROM (
        SELECT max(ws.attempt) AS max_attempt
        FROM workflow.workflow_steps ws
        WHERE ws.run_id = r.id
        GROUP BY ws.step_name
      ) per_step
    ) st ON TRUE
    -- The span-derived half. Every predicate here is lib/traces.ts's, verbatim:
    -- `MODEL_CALL_PREDICATE` and `TOOL_CALL_PREDICATE`. eve has two telemetry
    -- vocabularies and only one of them ever reaches a collector, so matching
    -- just the exported names reads 0 on a locally-traced install and matching
    -- just the local ones reads 0 on every deployment — `getTraceStats()` was
    -- deleted in W1 for making exactly that mistake. `starts_with` rather than
    -- LIKE for the same reason traces.ts gives: `_` is a LIKE wildcard, so
    -- 'execute_tool %' also matches 'executeXtool '.
    LEFT JOIN LATERAL (
      SELECT
        count(*)::int AS span_count,
        count(*) FILTER (
          WHERE s.name = 'ai.streamText.doStream' OR starts_with(s.name, 'chat ')
        )::int AS model_span_count,
        count(*) FILTER (
          WHERE s.name = 'ai.toolCall' OR starts_with(s.name, 'execute_tool ')
        )::int AS tool_span_count,
        -- Two vocabularies, third time in this LATERAL. `eve.environment` is
        -- the local tracer's key and is on zero spans of an exporting install;
        -- the AI SDK stamps `ai.settings.context.eve.*` on the same spans that
        -- carry the session and turn ids. Reading only the first is why every
        -- row of /sessions showed `environment` as `—`. It reads `unknown` now
        -- on a scaffolded project, because that is the value eve exported.
        max(COALESCE(s.attributes ->> 'eve.environment',
                     s.attributes ->> 'ai.settings.context.eve.environment')) AS environment,

        -- A turn is one model call per step, so a turn that used a tool has
        -- several — and which one each field comes from is a decision, not a
        -- detail. TTFT is the FIRST call's: it is the wait a person actually
        -- experienced, and max() over the set would report the slowest step as
        -- the turn's responsiveness. The finish reason is the LAST call's,
        -- because that is what ended the turn; max() there would rank
        -- 'tool-calls' above 'stop' alphabetically and report a finished turn as
        -- still calling tools. Time per output chunk is the mean across the
        -- turn's model calls, which is the only one of the three that is a
        -- property of the turn rather than of one call in it.
        (array_agg(
           (s.attributes ->> 'gen_ai.client.operation.time_to_first_chunk')::double precision
           ORDER BY s.start_unix_nano ASC
         ) FILTER (
           WHERE (s.name = 'ai.streamText.doStream' OR starts_with(s.name, 'chat '))
             AND s.attributes ? 'gen_ai.client.operation.time_to_first_chunk'
         ))[1] * 1000 AS ttft_ms,

        avg((s.attributes ->> 'gen_ai.client.operation.time_per_output_chunk')::double precision)
          FILTER (WHERE s.name = 'ai.streamText.doStream' OR starts_with(s.name, 'chat '))
          * 1000 AS time_per_output_chunk_ms,

        (array_agg(
           s.attributes -> 'gen_ai.response.finish_reasons' ->> 0
           ORDER BY s.start_unix_nano DESC
         ) FILTER (
           WHERE (s.name = 'ai.streamText.doStream' OR starts_with(s.name, 'chat '))
             AND s.attributes -> 'gen_ai.response.finish_reasons' ->> 0 IS NOT NULL
         ))[1] AS finish_reason
      FROM evestack.spans s
      WHERE s.resolved_turn_id = r.id
    ) sp ON TRUE

    -- `touched_turns` is a union, and its span arm contributes whatever
    -- `resolved_turn_id` says — which is not guaranteed to be a turn. Without
    -- this the CHECK on `run_type` is what would catch it, at 3am, as a failed
    -- refresh rather than as a filtered row.
    WHERE r.attributes ->> '$eve.type' IN ('turn', 'subagent')
  ),
  rated AS (
    SELECT
      source.*,
      -- Non-cached input. Cache reads and cache writes both arrive INSIDE
      -- `$eve.input_tokens`, so neither may also be charged at the full input
      -- rate. The floor is lib/pricing.ts's: a provider whose counters cannot
      -- all be true must not produce a negative row that subtracts from the
      -- session total.
      GREATEST(
        0,
        COALESCE(input_tokens, 0)
          - COALESCE(cache_read_tokens, 0)
          - COALESCE(cache_write_tokens, 0)
      ) AS non_cached_tokens,
      p_prices -> model AS rate
    FROM source
  )
  INSERT INTO evestack.fact_turn AS f (
    run_id, run_type, session_id, trigger, environment, model, provider,
    created_at, started_at, completed_at, duration_ms,
    ttft_ms, time_per_output_chunk_ms, output_tokens_per_second,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
    priced, cost_input_usd, cost_output_usd, cost_cache_read_usd,
    cost_cache_write_usd, cost_usd,
    step_count, retry_count, tools_offered, tools_called,
    finish_reason, error_code, error, outcome, span_coverage, source_updated_at
  )
  SELECT
    id,
    run_type,
    session_id,
    trigger,
    environment,
    model,
    CASE WHEN model IS NULL THEN NULL ELSE split_part(model, '/', 1) END,
    created_at AT TIME ZONE 'utc',
    started_at AT TIME ZONE 'utc',
    completed_at AT TIME ZONE 'utc',
    duration_ms,
    ttft_ms,
    time_per_output_chunk_ms,
    CASE
      WHEN duration_ms IS NULL OR duration_ms <= 0 OR output_tokens IS NULL THEN NULL
      ELSE output_tokens / (duration_ms / 1000)
    END,
    input_tokens,
    output_tokens,
    cache_read_tokens,
    cache_write_tokens,
    CASE WHEN model IS NULL THEN NULL ELSE rate IS NOT NULL END,
    CASE WHEN rate IS NULL THEN NULL
         ELSE non_cached_tokens / 1e6 * (rate ->> 'input')::numeric END,
    CASE WHEN rate IS NULL THEN NULL
         ELSE COALESCE(output_tokens, 0) / 1e6 * (rate ->> 'output')::numeric END,
    CASE WHEN rate IS NULL THEN NULL
         ELSE COALESCE(cache_read_tokens, 0) / 1e6 * (rate ->> 'cacheRead')::numeric END,
    CASE WHEN rate IS NULL THEN NULL
         ELSE COALESCE(cache_write_tokens, 0) / 1e6 * (rate ->> 'cacheWrite')::numeric END,
    CASE WHEN rate IS NULL THEN NULL
         ELSE non_cached_tokens / 1e6 * (rate ->> 'input')::numeric
            + COALESCE(output_tokens, 0) / 1e6 * (rate ->> 'output')::numeric
            + COALESCE(cache_read_tokens, 0) / 1e6 * (rate ->> 'cacheRead')::numeric
            + COALESCE(cache_write_tokens, 0) / 1e6 * (rate ->> 'cacheWrite')::numeric END,
    step_count,
    retry_count,
    tools_offered,
    -- Zero tool calls and zero spans are different facts. Reporting the second
    -- as the first is how "this agent called no tools" gets said about a turn
    -- nobody has any telemetry for.
    CASE WHEN COALESCE(span_count, 0) = 0 THEN NULL ELSE tool_span_count END,
    finish_reason,
    error_code,
    error,

    /* ── outcome ────────────────────────────────────────────────────────────
     *
     * lib/monitors.ts owns this vocabulary and this is not allowed to be a
     * second opinion on it. Its two failure tests, verbatim:
     *
     *   errored       error_code IS NOT NULL
     *   noModelCall   completed_at IS NOT NULL AND $eve.model IS NULL
     *
     * eve writes `$eve.model` only once a model call reports usage, so a
     * FINISHED turn without it never reached the provider — while its workflow
     * row still says `status = 'completed'`, because the workflow handled the
     * error. An error rate on `error_code` alone reports those as successes,
     * which is the direction that flatters us.
     *
     * Those two are first, and nothing below may steal a row from them:
     * `failed` + `no_model_call` here is exactly the population monitors counts
     * as failed, so the two surfaces can never disagree about the error rate.
     *
     * `budget_stopped` sits third rather than lower because it is the more
     * specific cause of a cancellation. @evestack/budget in `cancel` mode calls
     * cancelTurn, which lands as `status = 'cancelled'` with no error code — so
     * a budget stop that only checked `cancelled` first would be invisible in
     * every real install, and visible only in fixtures. In `fail` mode the same
     * stop throws and eve marks the turn failed, and that one stays `failed`:
     * monitors counts it, and the error rate is not ours to shrink.
     *
     * `wedged` is lib/fleet.ts's: a turn that started and never reached a
     * terminal state, older than that file's STUCK_TURN_MS. The threshold is
     * passed in from lib/facts.ts rather than written here, so there is one
     * number and a test can prove it still matches fleet.ts.
     *
     * `running` is the seventh value W2's brief does not list, and it has to
     * exist. A turn that has not finished and is not yet old enough to be
     * suspicious is neither `ok` (it may still fail) nor `wedged` — calling it
     * wedged is precisely the cry-wolf failure lib/fleet.ts opens by describing,
     * where 22 healthy sessions were reported as faults.
     */
    CASE
      WHEN error_code IS NOT NULL THEN 'failed'
      WHEN completed_at IS NOT NULL AND model IS NULL THEN 'no_model_call'
      WHEN budget_stopped THEN 'budget_stopped'
      WHEN status = 'cancelled' THEN 'cancelled'
      WHEN completed_at IS NULL
       AND (now() AT TIME ZONE 'utc') - COALESCE(started_at, created_at)
             > make_interval(secs => p_stuck_turn_seconds)
        THEN 'wedged'
      WHEN completed_at IS NULL THEN 'running'
      ELSE 'ok'
    END,

    /* ── span_coverage ──────────────────────────────────────────────────────
     *
     * Whether the span-derived columns on this row describe the turn or a
     * fragment of it. Without it a TTFT chart averages the minority of turns
     * that exported spans and presents the answer as the fleet: in the seeded
     * month only 370 of 1,922 turns have any spans at all, which is realistic —
     * spans are opt-in and pruned long before runs are.
     *
     *   none     nothing resolves to this turn. Every span-derived column is
     *            NULL, and `tools_called` is NULL rather than 0.
     *   partial  spans landed, but the model call the run row proves happened
     *            has none. TTFT and time-per-output-chunk are missing for a turn
     *            that has them. This is what retention pruning a trace's tail,
     *            or an exporter dropping a batch, looks like.
     *   full     everything expected is here. A turn that never called a model
     *            is `full` with no model span, because there was none to export.
     */
    CASE
      WHEN COALESCE(span_count, 0) = 0 THEN 'none'
      WHEN model IS NOT NULL AND COALESCE(model_span_count, 0) = 0 THEN 'partial'
      ELSE 'full'
    END,
    updated_at
  FROM rated
  ON CONFLICT (run_id) DO UPDATE SET
    run_type = EXCLUDED.run_type,
    session_id = EXCLUDED.session_id,
    trigger = EXCLUDED.trigger,
    environment = EXCLUDED.environment,
    model = EXCLUDED.model,
    provider = EXCLUDED.provider,
    created_at = EXCLUDED.created_at,
    started_at = EXCLUDED.started_at,
    completed_at = EXCLUDED.completed_at,
    duration_ms = EXCLUDED.duration_ms,
    ttft_ms = EXCLUDED.ttft_ms,
    time_per_output_chunk_ms = EXCLUDED.time_per_output_chunk_ms,
    output_tokens_per_second = EXCLUDED.output_tokens_per_second,
    input_tokens = EXCLUDED.input_tokens,
    output_tokens = EXCLUDED.output_tokens,
    cache_read_tokens = EXCLUDED.cache_read_tokens,
    cache_write_tokens = EXCLUDED.cache_write_tokens,
    priced = EXCLUDED.priced,
    cost_input_usd = EXCLUDED.cost_input_usd,
    cost_output_usd = EXCLUDED.cost_output_usd,
    cost_cache_read_usd = EXCLUDED.cost_cache_read_usd,
    cost_cache_write_usd = EXCLUDED.cost_cache_write_usd,
    cost_usd = EXCLUDED.cost_usd,
    step_count = EXCLUDED.step_count,
    retry_count = EXCLUDED.retry_count,
    tools_offered = EXCLUDED.tools_offered,
    tools_called = EXCLUDED.tools_called,
    finish_reason = EXCLUDED.finish_reason,
    error_code = EXCLUDED.error_code,
    error = EXCLUDED.error,
    outcome = EXCLUDED.outcome,
    span_coverage = EXCLUDED.span_coverage,
    source_updated_at = EXCLUDED.source_updated_at
  -- The whole point of `>=`: the boundary rows are re-read on every refresh, so
  -- rewriting them has to be free. This clause is what makes a second refresh
  -- report zero changes instead of rewriting the table, and it is why no column
  -- here holds a "refreshed at" stamp — one would differ every time and turn
  -- every row into a change.
  WHERE ROW(f.*) IS DISTINCT FROM ROW(EXCLUDED.*);

  GET DIAGNOSTICS v_turns_changed = ROW_COUNT;
  SELECT count(*) INTO v_turns_examined FROM touched_turns;

  -- Tool calls, scoped to the turns above rather than to spans directly. Same
  -- reason as the re-resolution note on `touched_turns`: a span that changed
  -- without its own timestamp moving is still reachable through its turn.
  WITH tool_spans AS (
    SELECT
      s.trace_id,
      s.span_id,
      s.resolved_turn_id,
      s.resolved_session_id,
      -- `gen_ai.tool.name` is what both of eve's tracers write, and lib/traces.ts
      -- reads the same key. The span name is only a fallback for a span that
      -- lost it, and only for the exported family — the local tracer's span is
      -- called `ai.toolCall` and carries no name in its title at all, so falling
      -- through to the span name there is honest rather than a guess.
      COALESCE(
        s.attributes ->> 'gen_ai.tool.name',
        CASE WHEN starts_with(s.name, 'execute_tool ') THEN substring(s.name FROM 14) END,
        s.name
      ) AS tool_name,
      s.start_time,
      s.duration_ms,
      s.status_code,
      s.status_message,
      octet_length(s.attributes ->> 'gen_ai.tool.call.arguments') AS arguments_bytes,
      octet_length(s.attributes ->> 'gen_ai.tool.call.result')    AS result_bytes
    FROM evestack.spans s
    JOIN touched_turns t ON t.id = s.resolved_turn_id
    -- `touched_turns` keeps this incremental, but its span arm contributes
    -- whatever `resolved_turn_id` says and that is NOT guaranteed to be a turn:
    -- it comes from `spans.turn_id`, a generated column over an attribute the
    -- tracer writes, so it can be any string. The fact_turn arm 220 lines above
    -- guards itself with `$eve.type IN ('turn','subagent')` and this one did
    -- not, so a tool span pointing at a session id — or at nothing — was
    -- materialized anyway, breaking this table's own stated promise that "a
    -- tool span that resolves to no turn is not materialized at all" and making
    -- sum(tools_called) disagree with count(fact_tool_call).
    --
    -- Joining fact_turn rather than repeating the type test is what makes the
    -- promise structural: fact_turn is written earlier in this same function and
    -- contains exactly the turns that passed the guard, so a tool call cannot
    -- outlive the turn it belongs to.
    JOIN evestack.fact_turn ft ON ft.run_id = t.id
    -- lib/traces.ts's TOOL_CALL_PREDICATE, and both halves of it matter: a
    -- deployment that exports emits `execute_tool <name>` and a laptop running
    -- eve's local tracer emits `ai.toolCall`.
    WHERE s.name = 'ai.toolCall' OR starts_with(s.name, 'execute_tool ')
  )
  INSERT INTO evestack.fact_tool_call AS f (
    trace_id, span_id, run_id, session_id, tool_name,
    started_at, duration_ms, ok, error_message, arguments_bytes, result_bytes
  )
  SELECT
    trace_id, span_id, resolved_turn_id, resolved_session_id, tool_name,
    start_time, duration_ms,
    -- Three states, not two. See `ok` on the table: anything that is not an
    -- explicit ERROR or an explicit OK is UNSET, and UNSET is the absence of a
    -- verdict rather than a good one. `status_code <> 2` was here, and it
    -- recorded every span from every tracer that reports only failures as a
    -- success.
    CASE WHEN status_code = 2 THEN false WHEN status_code = 1 THEN true END,
    CASE WHEN status_code = 2 THEN status_message END,
    arguments_bytes,
    result_bytes
  FROM tool_spans
  ON CONFLICT (trace_id, span_id) DO UPDATE SET
    run_id = EXCLUDED.run_id,
    session_id = EXCLUDED.session_id,
    tool_name = EXCLUDED.tool_name,
    started_at = EXCLUDED.started_at,
    duration_ms = EXCLUDED.duration_ms,
    ok = EXCLUDED.ok,
    error_message = EXCLUDED.error_message,
    arguments_bytes = EXCLUDED.arguments_bytes,
    result_bytes = EXCLUDED.result_bytes
  WHERE ROW(f.*) IS DISTINCT FROM ROW(EXCLUDED.*);

  GET DIAGNOSTICS v_tools_changed = ROW_COUNT;

  SELECT count(*) INTO v_tools_examined
  FROM evestack.spans s
  JOIN touched_turns t ON t.id = s.resolved_turn_id
  -- Same guard as the insert above, or `examined` counts rows `changed` cannot.
  JOIN evestack.fact_turn ft ON ft.run_id = t.id
  WHERE s.name = 'ai.toolCall' OR starts_with(s.name, 'execute_tool ');

  -- A tool call whose span is gone. Only reachable for turns in this refresh,
  -- which is why the header says a span prune needs a full rebuild to
  -- reconcile: pruning moves no watermark, so it puts no turn in `touched`.
  DELETE FROM evestack.fact_tool_call f
  USING touched_turns t
  WHERE f.run_id = t.id
    AND NOT EXISTS (
      SELECT 1 FROM evestack.spans s
      WHERE s.trace_id = f.trace_id AND s.span_id = f.span_id
    );

  INSERT INTO evestack.fact_watermark (component, runs_watermark, spans_watermark)
  VALUES ('fact_turn', v_runs_watermark, v_spans_watermark)
  ON CONFLICT (component) DO UPDATE SET
    runs_watermark = EXCLUDED.runs_watermark,
    spans_watermark = EXCLUDED.spans_watermark;

  DROP TABLE touched_turns;
  DROP TABLE budget_stopped_turns;

  RETURN QUERY SELECT v_turns_examined, v_turns_changed, v_tools_examined, v_tools_changed;
END;
$function$;

COMMIT;
