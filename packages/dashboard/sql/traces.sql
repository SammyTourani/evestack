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

  -- NO COLUMN FOR `workflow.run.id`, and both halves of that are deliberate.
  --
  -- Not folded into session_id, which is the whole finding of the attribution
  -- audit: on a live database 30,560 of the 30,564 spans carrying this key are
  -- `workflow.stream.read.complete` engine noise stamped with the all-zero
  -- placeholder `wrun_00000000000000000000000000`, which joins to no run that
  -- has ever existed. Widening session_id with it would report 97% attribution
  -- while attributing zero model calls.
  --
  -- Not projected into a column of its own either. Where the value is real it
  -- still is not a session id: it points at a *session* run on some spans and a
  -- *turn* run on others, so it has to be resolved through workflow.workflow_runs
  -- (`$eve.parent` / `$eve.type`) before it can be treated as one, and some
  -- values name runs that have since been pruned. Nothing here implements that
  -- join, so a STORED generated column would only be a table rewrite and an index
  -- nobody reads. `attributes ->> 'workflow.run.id'` is right there for whoever
  -- writes the join; add the column with it, not before.

  -- The same ids, inherited from the nearest ancestor that declares one.
  --
  -- These cannot be GENERATED: a generated expression sees only its own row,
  -- and the rows anyone wants to aggregate — `chat <model>`, `execute_tool
  -- <name>` — declare no ids at all. Their parents (`step N`,
  -- `invoke_agent <model>`) declare all of them, on every row. So the walk is
  -- materialized instead, by evestack.resolve_span_ancestry() below, which the
  -- triggers on this table keep current as spans arrive.
  --
  -- Read `session_id` when the question is "did this span say which session it
  -- belonged to". Read `resolved_session_id` when the question is "which
  -- session does this span belong to", which is every aggregation.
  resolved_session_id text,
  resolved_turn_id    text,

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

-- --------------------------------------------------------------------------
-- Ancestor inheritance, materialized.
-- --------------------------------------------------------------------------

/*
 * Fill resolved_session_id / resolved_turn_id for every span in `traces`
 * (NULL = the whole table, which is the backfill), and return how many rows
 * changed.
 *
 * Four cases this has to survive, all of them normal rather than exotic:
 *
 *   MISSING PARENT.  A span whose parent_span_id names a row that is not here
 *     is treated as a root. It keeps whatever it declares itself and inherits
 *     nothing, rather than being skipped.
 *   CHILD BEFORE PARENT.  OTLP batches arrive unordered, so a child routinely
 *     lands first and resolves to NULL. The trigger below re-resolves the whole
 *     trace whenever any span in it is written, so the parent's arrival fixes
 *     its children — that is why the unit of work is the trace, not the row.
 *   CYCLES.  parent_span_id is a single column, so a span has at most one
 *     parent. A cycle is therefore unreachable from any root, and this walk only
 *     ever descends from roots: it cannot enter a cycle, and it cannot visit a
 *     span twice (that would need two parents). The walk terminates without a
 *     depth cap. Spans inside a cycle are simply never inherited into, and fall
 *     back to what they declare — the LEFT JOIN in `resolved` is what makes that
 *     a defined outcome instead of a NULL nobody chose.
 *   RE-INGEST.  Delivery is at-least-once. Recomputing from the rows currently
 *     present is idempotent, and the final predicate makes an unchanged row a
 *     no-op write rather than dead tuples on every replay.
 *
 * PRUNING IS NOT HELD HARMLESS. Nothing fires on DELETE, so pruning a parent
 * leaves its children's stored ids alone — until the next span lands in that
 * trace, when this recomputes from the rows still present, finds the declaring
 * ancestor gone and writes NULL over every survivor. Retention costs attribution
 * as well as history in that one case. No AFTER DELETE trigger defends it:
 * prune_spans cuts on start_time, so a trace old enough to lose spans is not one
 * an exporter is still appending to, and the guard would run on every batch.
 */
CREATE OR REPLACE FUNCTION evestack.resolve_span_ancestry(traces text[] DEFAULT NULL)
RETURNS bigint
LANGUAGE plpgsql
AS $fn$
DECLARE
  scope   text[] := traces;
  changed bigint;
BEGIN
  IF scope IS NULL THEN
    SELECT array_agg(DISTINCT trace_id) INTO scope FROM evestack.spans;
  END IF;
  IF scope IS NULL OR cardinality(scope) = 0 THEN
    RETURN 0;
  END IF;

  WITH RECURSIVE walk AS (
    SELECT s.trace_id, s.span_id, s.session_id AS sid, s.turn_id AS tid
    FROM evestack.spans s
    WHERE s.trace_id = ANY(scope)
      AND (s.parent_span_id IS NULL
           OR NOT EXISTS (SELECT 1 FROM evestack.spans p
                          WHERE p.trace_id = s.trace_id
                            AND p.span_id  = s.parent_span_id))
    UNION ALL
    SELECT c.trace_id, c.span_id,
           COALESCE(c.session_id, w.sid),
           COALESCE(c.turn_id,    w.tid)
    FROM walk w
    JOIN evestack.spans c
      ON c.trace_id = w.trace_id AND c.parent_span_id = w.span_id
  ),
  resolved AS (
    SELECT s.trace_id, s.span_id,
           COALESCE(w.sid, s.session_id) AS sid,
           COALESCE(w.tid, s.turn_id)    AS tid
    FROM evestack.spans s
    LEFT JOIN walk w ON w.trace_id = s.trace_id AND w.span_id = s.span_id
    WHERE s.trace_id = ANY(scope)
  )
  UPDATE evestack.spans s
     SET resolved_session_id = r.sid,
         resolved_turn_id    = r.tid
    FROM resolved r
   WHERE s.trace_id = r.trace_id
     AND s.span_id  = r.span_id
     AND (s.resolved_session_id IS DISTINCT FROM r.sid
          OR s.resolved_turn_id IS DISTINCT FROM r.tid);

  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END
$fn$;

/*
 * Keep the resolved columns current.
 *
 * FOR EACH STATEMENT with a transition table, not FOR EACH ROW: ingest arrives
 * in batches of up to 500 spans and the seed script arrives as one COPY of tens
 * of thousands, and a per-row recursive walk would run the same query once per
 * span in the same trace.
 *
 * WHAT ONE STATEMENT COSTS, since "statement-level" reads like a bound and is
 * not one. The unit of work is not the spans that arrived, it is every span in
 * every trace they touched — the whole trace is re-walked and re-compared for
 * one appended span. Measured on this schema, appending to a trace of N spans:
 *
 *          N     1 span    100 spans    chain N deep
 *         10       1 ms
 *      1,000       2 ms                       2 ms
 *      5,000      18 ms        21 ms         18 ms
 *     10,000      24 ms                      25 ms
 *     20,000     201 ms
 *
 * The batch is nearly free — 100 spans cost what 1 costs — which is the whole
 * reason this is FOR EACH STATEMENT; FOR EACH ROW would bill the 18ms a hundred
 * times. Depth is free too: N deep costs what N wide costs, because the CTE's
 * per-level iterations still visit each span exactly once. Only N is not free.
 *
 * eve's traces are 10 spans and 4 levels at their deepest, over the 30,926
 * traces in the seeded database, so none of this is reachable today. It becomes
 * reachable if something emits one long-lived trace per session instead of one
 * per turn. The fix then is to scope the walk to the subtree that changed — not
 * FOR EACH ROW, which multiplies exactly this cost by the batch.
 *
 * One trap, worth more than the table: with no statistics on the table this
 * costs 100x. That same 5,000-span append is 1.8s until something ANALYZEs and
 * stays 1.8s — the planner, not a cold cache, so it never warms up. ANALYZE
 * after a bulk load before believing any number measured here.
 *
 * The pg_trigger_depth() line is the loop guard and is not optional. This
 * function's own UPDATE re-enters the AFTER UPDATE trigger; without the guard
 * that is infinite. The obvious alternative — `AFTER UPDATE OF parent_span_id,
 * attributes`, which the resolved columns are not in — is rejected by Postgres:
 * "transition tables cannot be specified for triggers with column lists".
 *
 * The guard costs one redundant pass when resolve_span_ancestry() is called
 * directly (the migration's backfill runs at depth 0, so its UPDATE fires this
 * at depth 1 and re-derives the same values). That pass changes no rows.
 *
 * Two ingests writing to the same trace at the same time can deadlock, since
 * each locks the trace's rows in whatever order its plan produced. Postgres
 * aborts one, the route answers 503, the exporter re-sends, and the re-send is
 * an upsert — so the failure mode is a retry, not a lost span. Worth knowing
 * before adding a second writer that is not an exporter.
 */
CREATE OR REPLACE FUNCTION evestack.spans_resolve_changed()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  scope text[];
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;
  SELECT array_agg(DISTINCT trace_id) INTO scope FROM changed_spans;
  IF scope IS NOT NULL THEN
    PERFORM evestack.resolve_span_ancestry(scope);
  END IF;
  RETURN NULL;
END
$fn$;

-- --------------------------------------------------------------------------
-- Retention.
-- --------------------------------------------------------------------------

/*
 * Delete up to `batch` spans older than `older_than`, and return how many.
 *
 * Nothing upstream bounds this table: a live install measured 880 spans per
 * run, 92.6% of them one engine-noise span name, in the same Postgres that
 * holds durable session state. `sql/approvals.sql` reasons about retention and
 * concludes "keep everything", which is right for an audit trail and wrong for
 * replayable telemetry.
 *
 * Cut on start_time, the span's own clock, because that is the axis every
 * dashboard window filters on — a span outside every window is invisible
 * whether or not it is stored. Consequence worth knowing before you replay an
 * old batch: a span that arrives already older than the window is removed by the
 * next prune rather than kept for `older_than` after it arrived.
 *
 * ONE BATCH PER CALL, and the caller loops — lib/traces.ts does. A LOOP inside
 * this function would also work but would be one transaction however long it
 * ran, because plpgsql cannot commit mid-function; the first prune over a year
 * of backlog would hold locks and pile up WAL for all of it. Called repeatedly,
 * each batch commits on its own. Run it by hand the same way:
 *
 *   SELECT evestack.prune_spans('7 days');   -- repeat while it returns 20000
 */
CREATE OR REPLACE FUNCTION evestack.prune_spans(older_than interval, batch integer DEFAULT 20000)
RETURNS bigint
LANGUAGE plpgsql
AS $fn$
DECLARE
  removed bigint;
BEGIN
  IF older_than IS NULL OR older_than <= interval '0' THEN
    RETURN 0;  -- retention off: an unbounded table is a choice, not an accident
  END IF;

  DELETE FROM evestack.spans
  WHERE ctid IN (
    SELECT ctid FROM evestack.spans WHERE start_time < now() - older_than LIMIT batch
  );
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END
$fn$;

-- --------------------------------------------------------------------------
-- Schema version and migrations.
-- --------------------------------------------------------------------------

-- What version of this file an existing database has actually had applied.
--
-- This replaces a guard that read `session_id`'s generated expression and ran
-- the migration only when it did NOT contain 'ai.settings.context.eve.session.id'.
-- That guard could only ever fire once: the moment the expression it tests for
-- was in place, every later migration written inside it became silently inert on
-- every existing database while passing perfectly on a fresh one. A version
-- number cannot fail that way, because it is not derived from the change.
CREATE TABLE IF NOT EXISTS evestack.schema_version (
  component  text PRIMARY KEY,
  version    integer     NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- Bump this, and add the matching `IF installed < N` step below, for any change
-- to evestack.spans that CREATE TABLE IF NOT EXISTS cannot apply on its own.
-- Every step must be safe to re-run: a fresh database gets the whole table from
-- the CREATE TABLE above and then runs every step as a no-op on its way to the
-- current version.
DO $mig$
DECLARE
  target    constant integer := 3;
  installed integer;
  current_expr text;
BEGIN
  SELECT version INTO installed FROM evestack.schema_version WHERE component = 'spans';
  installed := COALESCE(installed, 0);

  -- 1: teach the id columns the AI SDK vocabulary.
  --
  -- A database created before session_id learned to COALESCE keeps the old
  -- single-key expression forever, and keeps dropping every exported span.
  -- Dropping and re-adding a generated column is safe because `attributes` is
  -- the only source: Postgres recomputes every row and nothing is lost. The
  -- expression check is not the gate — `installed` is — it only avoids a table
  -- rewrite on a database that never had the old expression.
  IF installed < 1 THEN
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
  END IF;

  -- 2: the materialized ancestor walk.
  IF installed < 2 THEN
    ALTER TABLE evestack.spans ADD COLUMN IF NOT EXISTS resolved_session_id text;
    ALTER TABLE evestack.spans ADD COLUMN IF NOT EXISTS resolved_turn_id    text;

    -- Existing rows predate the triggers. On a fresh database this is 0 rows.
    PERFORM evestack.resolve_span_ancestry();
  END IF;

  -- 3: take workflow_run_id back out.
  --
  -- Step 2 added it as a STORED generated column, with an index, for a join to
  -- workflow.workflow_runs that this schema does not implement — so nothing has
  -- ever selected it. Dropping it is metadata-only; adding it was a table
  -- rewrite. See the note where the column used to be declared, above.
  IF installed < 3 THEN
    ALTER TABLE evestack.spans DROP COLUMN IF EXISTS workflow_run_id;
  END IF;

  INSERT INTO evestack.schema_version (component, version) VALUES ('spans', target)
  ON CONFLICT (component) DO UPDATE
    SET version = EXCLUDED.version, applied_at = now()
    WHERE evestack.schema_version.version < EXCLUDED.version;
END $mig$;

-- The triggers and the indexes on the migrated columns come after the migration
-- on purpose: on a database created before it, those columns do not exist until
-- the block above has run.
CREATE OR REPLACE TRIGGER spans_resolved_after_insert
  AFTER INSERT ON evestack.spans
  REFERENCING NEW TABLE AS changed_spans
  FOR EACH STATEMENT EXECUTE FUNCTION evestack.spans_resolve_changed();

CREATE OR REPLACE TRIGGER spans_resolved_after_update
  AFTER UPDATE ON evestack.spans
  REFERENCING NEW TABLE AS changed_spans
  FOR EACH STATEMENT EXECUTE FUNCTION evestack.spans_resolve_changed();

-- The aggregation the declared columns cannot serve: every model and tool span
-- of one session.
CREATE INDEX IF NOT EXISTS spans_resolved_session_idx
  ON evestack.spans (resolved_session_id) WHERE resolved_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS spans_resolved_turn_idx
  ON evestack.spans (resolved_session_id, resolved_turn_id) WHERE resolved_turn_id IS NOT NULL;

-- Retention scans this, and so does anything asking for a time window.
CREATE INDEX IF NOT EXISTS spans_start_time_idx
  ON evestack.spans (start_time);
