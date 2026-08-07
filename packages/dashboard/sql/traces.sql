-- evestack tier-2 storage: OpenTelemetry spans exported by an eve agent.
--
-- Lives in its own schema on purpose. `workflow` belongs to world-postgres: it
-- owns those migrations and holds durable session state, so evestack only ever
-- reads it. Everything evestack writes goes here, which means an eve upgrade
-- cannot collide with these tables and `DROP SCHEMA evestack CASCADE` costs
-- nothing but replayable telemetry.
--
-- Every statement is guarded, so this file is safe to run on every boot.
-- Re-running never drops or rewrites an existing table; adding a column later
-- needs its own ALTER, since CREATE TABLE IF NOT EXISTS silently does nothing
-- once the table is there.

CREATE SCHEMA IF NOT EXISTS evestack;

CREATE TABLE IF NOT EXISTS evestack.spans (
  trace_id        text        NOT NULL,
  span_id         text        NOT NULL,
  parent_span_id  text,
  name            text        NOT NULL,
  kind            smallint    NOT NULL DEFAULT 0,

  -- OTLP timestamps are nanoseconds since the epoch; timestamptz resolves only
  -- to microseconds. Keeping the raw integers makes ordering and durations
  -- exact between sibling spans that start in the same microsecond, while the
  -- timestamptz columns keep the table legible in psql.
  --
  -- `bigint` and not `numeric`, and the ceiling is load-bearing: 2^63-1
  -- nanoseconds is the year 2262, and a value past it does not round or clamp —
  -- Postgres refuses the whole INSERT with "value ... is out of range for type
  -- bigint". Since insertSpans batches 500 rows per statement and the ingest
  -- route can only read a failed INSERT as "the database is unwell", one span
  -- from a double-scaled clock (`Date.now() * 1e12`, 22 digits) used to make the
  -- route answer 503 + Retry-After and the exporter resend that batch forever.
  -- parseOtlpTraces bounds every timestamp at MAX_UNIX_NANO on the way in and
  -- reports the offending span as OTLP partial success instead, so this column
  -- stays narrow and the exporter is told to stop. Widening the type would only
  -- move the same failure onto Date, whose own ceiling is 8.64e21 ns.
  start_unix_nano bigint      NOT NULL,
  end_unix_nano   bigint,
  start_time      timestamptz NOT NULL,
  end_time        timestamptz,
  duration_ms     double precision GENERATED ALWAYS AS
                    ((end_unix_nano - start_unix_nano)::double precision / 1000000) STORED,

  status_code     smallint    NOT NULL DEFAULT 0,
  status_message  text,

  -- OTLP AnyValue wrappers are unwrapped before insert, so `attributes` reads
  -- as plain JSON: {"agent.step.index": 1} rather than
  -- {"agent.step.index": {"intValue": 1}}.
  attributes      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  resource        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  events          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  scope_name      text,
  scope_version   text,

  -- The join back to workflow.workflow_runs: the id here is the same `wrun_...`
  -- that keys a workflow run. Projecting it into a stored column lets Postgres
  -- index it instead of reaching into JSONB per row.
  --
  -- These stay NULL on a large share of spans either way — workflow plumbing and
  -- fetch spans carry no agent identity at all — so they identify which traces
  -- belong to a session rather than acting as a filter for fetching its spans.
  -- Read a session by resolving it to trace ids first, then taking whole traces
  -- (see listSpansBySession in lib/traces.ts).
  --
  -- TWO VOCABULARIES, and getting this wrong makes the whole trace tier look
  -- broken. eve names these ids differently depending on who is emitting:
  --
  --   agent.session.id                        eve's own `eve.agent` tracer
  --   ai.settings.context.eve.session.id      the vendored AI SDK exporter
  --
  -- Only the second ever reaches an external collector. The `eve.agent` tracer
  -- lives in the local tracing runtime, which eve installs ONLY when the project
  -- authors no agent/instrumentation.ts — so the moment you export anywhere, the
  -- vocabulary you receive is the AI SDK one. Reading just `agent.session.id`
  -- (as this did originally) leaves every exported span with a NULL session and
  -- makes it look as though nothing was ingested at all.
  session_id      text GENERATED ALWAYS AS (
                    COALESCE(attributes ->> 'agent.session.id',
                             attributes ->> 'ai.settings.context.eve.session.id')) STORED,
  -- No AI SDK counterpart exists for the root session, so subagent traces can
  -- only be stitched when the local tracer produced them.
  root_session_id text GENERATED ALWAYS AS (attributes ->> 'agent.root.session.id') STORED,
  turn_id         text GENERATED ALWAYS AS (
                    COALESCE(attributes ->> 'agent.turn.id',
                             attributes ->> 'ai.settings.context.eve.turn.id')) STORED,

  received_at     timestamptz NOT NULL DEFAULT now(),

  -- OTLP delivery is at-least-once: an exporter that times out mid-flight will
  -- resend the same batch. Keying on the span's own identity makes a replay an
  -- upsert instead of a duplicate row.
  PRIMARY KEY (trace_id, span_id)
);

-- Session lookup: find the traces, then read them.
CREATE INDEX IF NOT EXISTS spans_session_idx
  ON evestack.spans (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS spans_root_session_idx
  ON evestack.spans (root_session_id) WHERE root_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS spans_turn_idx
  ON evestack.spans (session_id, turn_id) WHERE turn_id IS NOT NULL;

-- Reading a whole trace in start order, and stitching children to parents.
CREATE INDEX IF NOT EXISTS spans_trace_idx
  ON evestack.spans (trace_id, start_unix_nano);
CREATE INDEX IF NOT EXISTS spans_parent_idx
  ON evestack.spans (trace_id, parent_span_id);

-- "Newest tool calls", "slowest model steps": filtered by name, ordered by time.
CREATE INDEX IF NOT EXISTS spans_name_idx
  ON evestack.spans (name, start_unix_nano DESC);

-- Deliberately no GIN index on `attributes`. ai.prompt.messages holds whole
-- message histories (eve caps each value at 32 KB), so a GIN index would
-- tokenize entire conversations to serve containment queries this dashboard
-- does not make. The projected columns above cover the lookups that matter.

-- MIGRATION: teach the id columns the AI SDK vocabulary.
--
-- CREATE TABLE IF NOT EXISTS silently does nothing on an existing table, so a
-- database created before session_id learned to COALESCE would keep the old
-- single-key expression forever and keep dropping every exported span. Dropping
-- and re-adding a generated column is safe here because `attributes` is the only
-- source — Postgres recomputes every row, nothing is lost, and re-running is a
-- no-op once the expression already matches.
DO $$
DECLARE
  current_expr text;
BEGIN
  SELECT pg_get_expr(d.adbin, d.adrelid) INTO current_expr
  FROM pg_attrdef d
  JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
  WHERE d.adrelid = 'evestack.spans'::regclass AND a.attname = 'session_id';

  IF current_expr IS NOT NULL AND current_expr NOT LIKE '%ai.settings.context.eve.session.id%' THEN
    ALTER TABLE evestack.spans DROP COLUMN session_id;
    ALTER TABLE evestack.spans ADD COLUMN session_id text GENERATED ALWAYS AS (
      COALESCE(attributes ->> 'agent.session.id',
               attributes ->> 'ai.settings.context.eve.session.id')) STORED;

    ALTER TABLE evestack.spans DROP COLUMN turn_id;
    ALTER TABLE evestack.spans ADD COLUMN turn_id text GENERATED ALWAYS AS (
      COALESCE(attributes ->> 'agent.turn.id',
               attributes ->> 'ai.settings.context.eve.turn.id')) STORED;

    -- Dropping the columns took their indexes with them.
    CREATE INDEX IF NOT EXISTS spans_session_idx
      ON evestack.spans (session_id) WHERE session_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS spans_turn_idx
      ON evestack.spans (session_id, turn_id) WHERE turn_id IS NOT NULL;
  END IF;
END $$;
