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

  -- The join back to workflow.workflow_runs: eve sets `agent.session.id` to the
  -- same `wrun_...` id that keys a workflow run. Projecting it into a stored
  -- column lets Postgres index it instead of reaching into JSONB per row.
  --
  -- These are NULL on a large share of spans. Only eve's own spans (agent.*)
  -- carry the ids; the AI SDK spans underneath them (ai.streamText,
  -- ai.streamText.doStream, ai.toolCall) carry none — and those are precisely
  -- the spans holding prompt bodies and tool arguments. So they identify which
  -- traces belong to a session; they are not a filter for fetching its spans.
  -- Read a session by resolving it to trace ids first, then taking whole
  -- traces (see listSpansBySession in lib/traces.ts).
  session_id      text GENERATED ALWAYS AS (attributes ->> 'agent.session.id')      STORED,
  root_session_id text GENERATED ALWAYS AS (attributes ->> 'agent.root.session.id') STORED,
  turn_id         text GENERATED ALWAYS AS (attributes ->> 'agent.turn.id')         STORED,

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
