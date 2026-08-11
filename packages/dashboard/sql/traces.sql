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

-- --------------------------------------------------------------------------
-- The version marker, and the downgrade guard. Both are first in the file on
-- purpose — see the guard.
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

/*
 * REFUSE TO RUN AT ALL AGAINST A DATABASE NEWER THAN THIS FILE.
 *
 * The migration at the bottom moves the marker FORWARD only, which stops an
 * older image decrementing the number — and stopped nothing else. Every
 * `CREATE OR REPLACE FUNCTION` below is unconditional, so an older image
 * happily replaced a newer database's resolver while the marker went on
 * claiming the newer version. Observed live: the marker read `spans v4` while
 * `resolve_span_ancestry` was the v3 body, and fresh spans went back to
 * resolving as `turn_0`. Because the marker still said v4, the migration that
 * would have repaired it could never re-run. The guard silently lied.
 *
 * So the gate covers the DDL, not just the data, and it does that by being
 * FIRST. Position is the whole mechanism: an operator piping this file into
 * `psql` gets a statement per transaction, so a check placed after the function
 * definitions would abort a replacement that had already been committed. Only
 * `CREATE SCHEMA` and the marker table above run ahead of it, and both are
 * no-ops on any database that could trip it.
 *
 * Rejected: re-applying the functions unconditionally on every boot. That makes
 * "last image to boot wins", which is the same race with better odds.
 *
 * `EV001` is this repository's SQLSTATE for it. lib/db.ts matches on it to tell
 * a person their dashboard is older than their database, rather than rendering
 * the empty pages this failure otherwise looks like.
 */
DO $guard$
DECLARE
  -- Must equal the migration's own `target` at the bottom of this file;
  -- test/schema-guard.test.mjs reads both out of the file and fails if they part.
  target    constant integer := 4;
  installed integer;
BEGIN
  SELECT version INTO installed FROM evestack.schema_version WHERE component = 'spans';
  IF COALESCE(installed, 0) > target THEN
    RAISE EXCEPTION
      'evestack.spans is at schema version %, and this build of evestack only understands version %. Nothing was applied: an older image must leave a newer database alone rather than half-downgrade it. Run the image that installed version %, or drop the evestack schema to rebuild the trace tier from scratch.',
      installed, target, installed
      USING ERRCODE = 'EV001';
  END IF;
END $guard$;

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
  -- nobody reads as a column. resolve_span_ancestry() below DOES read the
  -- attribute, to translate a turn alias into the run it ran inside; that needs
  -- the nearest ancestor's value, which a per-row generated column cannot see.

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
  --
  -- `resolved_turn_id` is NOT just the inherited `turn_id`. It is the id of the
  -- workflow run the span executed inside, so it joins to `workflow_runs.id` —
  -- which the declared value does not, on any install that exports. See the
  -- turn-id section on resolve_span_ancestry() below; nothing should join
  -- `turn_id` to a run.
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
 *     ONLY WHILE THOSE WRITES ARE SERIALIZED, THOUGH. The trigger fires inside
 *     the transaction that did the writing, before it commits, and a concurrent
 *     writer has not committed either — so two batches for one trace in flight
 *     at once each re-walk a trace the other half of is UNCOMMITTED in, and the
 *     parent's arrival fixes nothing. lib/traces.ts runs this again from its own
 *     transaction once a batch has committed, which is what actually makes the
 *     answer independent of arrival order. See the triggers below.
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
 *
 * ── THE TURN ID IS TRANSLATED, NOT ONLY INHERITED ───────────────────────────
 *
 * `resolved_turn_id` has one job: name the workflow run the span executed
 * inside, so sql/facts.sql can join it to `workflow_runs.id` and the session
 * page can find a turn's spans. The declared `turn_id` does not always do that,
 * because eve's two tracers disagree about what a turn id IS:
 *
 *   agent.turn.id                      the turn's workflow run, `wrun_…`
 *   ai.settings.context.eve.turn.id    `turn_0`, an ordinal within the session
 *
 * Only the second ever reaches an external collector — the same split the
 * `session_id` column documents above — so on an exporting install every span
 * carries `turn_0`, for every turn of every session. That is not a key: it joins
 * to no run, and four sessions in the reproduction database all share the one
 * value. The session page keys its turn card on the run id, so it found nothing
 * and reported a session holding 12 spans, a tool call and a full transcript as
 * having none of them, while /traces/<id> rendered all three from those rows.
 *
 * The run id is on the trace, one or two levels up. eve executes a turn AS a
 * workflow run, so `workflow.run.id` on the enclosing `step.execute turnStep`
 * span is that turn. The walk below therefore inherits that key as well and
 * swaps it in where the declared turn id is an alias. Three rules keep the swap
 * from inventing an attribution:
 *
 *   A turn id that already names a run is never touched (the `wrun_` prefix).
 *     This can only fill a join that was empty; it cannot move one that worked.
 *   The all-zero `wrun_00000000000000000000000000` is not a run id. It is what
 *     the engine stamps on stream-read spans, it joins to nothing, and folding
 *     it in is exactly the mistake the `session_id` note above exists to avoid.
 *   An enclosing run that IS the session is not a turn. Turn spans nest inside
 *     `workflow.execute turnWorkflow`; session-scoped plumbing
 *     (`workflow.stream.flush`, `hook.resume`) carries the SESSION's run id, and
 *     accepting it would hang every span in the session off one phantom turn.
 *
 * Where the trace carries no enclosing run id at all — a fixture, or a collector
 * that received only the AI SDK subtree — the declared value is kept, which is
 * what this did before. The degraded case is the old behaviour, not a bad join.
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
    SELECT s.trace_id, s.span_id, s.session_id AS sid, s.turn_id AS tid,
           NULLIF(s.attributes ->> 'workflow.run.id', 'wrun_00000000000000000000000000') AS rid
    FROM evestack.spans s
    WHERE s.trace_id = ANY(scope)
      AND (s.parent_span_id IS NULL
           OR NOT EXISTS (SELECT 1 FROM evestack.spans p
                          WHERE p.trace_id = s.trace_id
                            AND p.span_id  = s.parent_span_id))
    UNION ALL
    SELECT c.trace_id, c.span_id,
           COALESCE(c.session_id, w.sid),
           COALESCE(c.turn_id,    w.tid),
           COALESCE(NULLIF(c.attributes ->> 'workflow.run.id', 'wrun_00000000000000000000000000'), w.rid)
    FROM walk w
    JOIN evestack.spans c
      ON c.trace_id = w.trace_id AND c.parent_span_id = w.span_id
  ),
  -- Split out so the turn rule below reads as a rule rather than as four
  -- repetitions of the same COALESCE. `rid` is the nearest self-or-ancestor
  -- `workflow.run.id`: the run this span executed inside.
  inherited AS (
    SELECT s.trace_id, s.span_id,
           COALESCE(w.sid, s.session_id) AS sid,
           COALESCE(w.tid, s.turn_id)    AS tid,
           w.rid                         AS rid
    FROM evestack.spans s
    LEFT JOIN walk w ON w.trace_id = s.trace_id AND w.span_id = s.span_id
    WHERE s.trace_id = ANY(scope)
  ),
  resolved AS (
    SELECT trace_id, span_id, sid,
           CASE
             -- Already a run id, or nothing to translate. Untouched, always.
             WHEN tid IS NULL OR starts_with(tid, 'wrun_') THEN tid
             -- An alias, and the trace says which run it ran in. The session's
             -- own run is not a turn, so it is not an answer to this question.
             WHEN rid IS NOT NULL AND rid IS DISTINCT FROM sid THEN rid
             -- An alias on a trace that carries no enclosing run. Keep it: it
             -- is at least stable within the session, which is what the
             -- /traces pages group by.
             ELSE tid
           END AS tid
    FROM inherited
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
 *
 * AND CONCURRENCY COSTS MORE THAN A RETRY HERE, WHICH IS WHY THIS TRIGGER IS
 * NOT THE WHOLE MECHANISM. THE REASON IS COMMITS, NOT SNAPSHOTS. This function
 * runs inside the TRANSACTION that fired it, before that transaction commits,
 * and a second writer for the same trace has not committed either — and nothing
 * can see another transaction's uncommitted rows, however new a snapshot it
 * takes. So two batches for one trace in flight at once each re-walk a trace
 * the other half of is UNCOMMITTED in: the one holding the children writes the
 * `turn_0` alias because the enclosing `workflow.run.id` span is not visible
 * yet, the one holding that span writes nothing because the children are not
 * visible yet, both commit, and the finished trace on disk is one no
 * transaction ever saw. Nothing writes to that trace again, so it stays wrong —
 * which is the session page back to "No spans on any of the 1 runs" for a turn
 * whose tool call /traces/<id> renders in full.
 *
 * THIS COMMENT USED TO SAY the trigger "sees that statement's snapshot and
 * nothing committed after it", which is false and was the stated reason for the
 * paragraph below. A trigger function is VOLATILE, and a volatile plpgsql
 * function takes a FRESH snapshot at the start of each query it runs, so it
 * does see whatever committed while it was working. Measured on this schema: a
 * statement-level trigger counted a table twice with a 400ms sleep between,
 * another session inserted and committed during the sleep, and the trigger read
 * 0 then 1. What it cannot see is a transaction that has not committed at all.
 *
 * That distinction decides how the failure behaves, which is why it is worth
 * getting right: it is a RACE, not a certainty. Whether a batch loses depends on
 * whether the other one committed before this walk's query started. Measured on
 * the real path, 40 traces delivered as two overlapping batches left 93 spans
 * across 31 of them on the alias — 31 of 40, not 40 of 40 — and one hand-run
 * resolve_span_ancestry() changed exactly those 93. Forced to full overlap
 * (both INSERTs issued before either COMMIT) the same scenario loses every time.
 *
 * WHAT FIXES IT is running the walk in a transaction that starts after the
 * write has committed, which insertSpans in lib/traces.ts does for every batch
 * it stores: the last writer to commit is the one whose resolve sees the whole
 * trace. That is true at any isolation level, because the snapshot is taken by
 * a transaction that begins after the commits.
 *
 * A PER-TRACE ADVISORY LOCK IN HERE IS NOT THE REASON THIS IS DESIGNED THIS
 * WAY, AND THE TREE USED TO CLAIM IT HAD BEEN TRIED AND FAILED. It had not been
 * tried, no artifact was ever left, and the reason given — "the lock is
 * acquired after the snapshot is taken, so waiting buys no visibility" — was a
 * corollary of the false mechanism above. Measured now, on this schema:
 * `pg_advisory_xact_lock(hashtext(trace_id))` at the top of this function makes
 * the second writer wait for the first to COMMIT, and its walk then does see the
 * first writer's rows. The forced-overlap scenario that leaves 3 of 5 spans on
 * the alias without it leaves 0 with it, and a hand-run resolve afterwards
 * changes 0 rows. It works.
 *
 * It is still not what this uses, for reasons that are about cost rather than
 * correctness, and they should be argued rather than asserted: the lock is held
 * until the writing transaction commits, so it serializes every writer of a
 * trace on the hottest insert path in this schema; its correctness depends on
 * READ COMMITTED, and a session at REPEATABLE READ takes ONE snapshot for the
 * whole transaction — which is the frozen trigger the old comment described, and
 * there the lock really would buy nothing; and a batch spanning several traces
 * has to take its locks in a consistent order or add a second deadlock surface
 * to a path that can already deadlock on rows. The post-commit resolve costs one
 * statement per batch and needs none of that to be true.
 *
 * This trigger stays, and it is not a weaker copy of that call. It is the only
 * thing that resolves a write which did not come through insertSpans — a psql
 * insert, a COPY, a seed — and for any trace that arrives in one statement it is
 * exactly right, which is nearly all of them, so that call normally finds
 * nothing to change. What it cannot be is the last word: two writers racing on
 * one trace defeat it whoever they are, which is why the path that actually
 * receives OTLP does not rely on it.
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
-- Migrations. The marker table and the downgrade guard are at the top of the
-- file, because the guard has to run before the functions above.
-- --------------------------------------------------------------------------

-- Bump this, and add the matching `IF installed < N` step below, for any change
-- to evestack.spans that CREATE TABLE IF NOT EXISTS cannot apply on its own.
-- Every step must be safe to re-run: a fresh database gets the whole table from
-- the CREATE TABLE above and then runs every step as a no-op on its way to the
-- current version.
--
-- Bump the guard's copy at the top of the file in the same edit. There are two
-- because a plpgsql block cannot export a constant and the guard has to run
-- several hundred lines earlier than this one; test/schema-guard.test.mjs reads
-- both numbers out of the file and fails if they disagree.
DO $mig$
DECLARE
  target    constant integer := 4;
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

  -- 4: resolved_turn_id names a workflow run, not a tracer-local alias.
  --
  -- No DDL — resolve_span_ancestry() above is CREATE OR REPLACE and is already
  -- the new one by the time this runs. What needs a migration step is the DATA:
  -- every span stored before this release holds the alias, and the triggers only
  -- fire on write, so without this the fix would apply to future spans and leave
  -- every session already in the database reading "no spans on any of the 1 runs".
  IF installed < 4 THEN
    PERFORM evestack.resolve_span_ancestry();

    -- The fact tables key on resolved_turn_id and refresh from a watermark over
    -- `spans.received_at`. The UPDATE above moves no `received_at` — re-resolving
    -- is not re-receiving — so nothing would put these turns back in the pending
    -- set and `span_coverage` would stay 'none' on rows that now have spans.
    -- Dropping the watermark makes the next refresh a full rebuild, which is the
    -- documented way to do this (see the header of sql/facts.sql). Guarded
    -- because facts.sql is applied AFTER this file: on a fresh database the
    -- table does not exist yet, and there is nothing stale to rebuild.
    IF to_regclass('evestack.fact_watermark') IS NOT NULL THEN
      DELETE FROM evestack.fact_watermark WHERE component = 'fact_turn';
    END IF;

    -- Nothing reads spans by the DECLARED turn id any more, and this table takes
    -- every span an agent exports, so a redundant index is write amplification
    -- on the hottest insert path here. Its replacement is
    -- `spans_resolved_turn_only_idx`, created below. Dropped here rather than in
    -- sql/query-indexes.sql because that file is held to CREATE INDEX IF NOT
    -- EXISTS and nothing else, and is proven so by a probe.
    DROP INDEX IF EXISTS evestack.evestack_spans_turn_idx;
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

-- And by turn alone, which the composite above cannot serve: `resolved_turn_id`
-- is not its leading column, so a lookup with no session in hand reads all of
-- it. getSessionTree() does exactly that — it has the session's run ids and asks
-- which traces they appear in — and sql/facts.sql joins the same column per
-- turn. Measured by W1 on a synthetic 1.5M-row table for the identical lookup
-- against `turn_id`: 34.191 ms and 15,549 shared buffers on the composite,
-- 0.076 ms and 19 on a leading-column index.
--
-- This index used to live in sql/query-indexes.sql, on the DECLARED `turn_id`,
-- with a note saying it would read better here. It moved when the queries moved
-- to the resolved column, and migration step 4 drops the old one; the file it
-- came from can now hold nothing but `workflow.workflow_runs`, which is the only
-- part of it that needed the justification in its header.
CREATE INDEX IF NOT EXISTS spans_resolved_turn_only_idx
  ON evestack.spans (resolved_turn_id) WHERE resolved_turn_id IS NOT NULL;

-- Retention scans this, and so does anything asking for a time window.
CREATE INDEX IF NOT EXISTS spans_start_time_idx
  ON evestack.spans (start_time);

COMMIT;
