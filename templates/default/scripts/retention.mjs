/**
 * The SQL behind `npm run db:prune`, and the reasoning it encodes.
 *
 * Nothing prunes eve's `workflow` schema. `@workflow/world-postgres` has no
 * retention of its own — its only mention of the word is a validation that a
 * hook's `tokenRetentionUntil` is not too FAR in the future (dist/storage.js) —
 * and evestack adds none. So every run, event and step ever written is still
 * there. Measured against a database holding one month of realistic traffic
 * (3,322 runs, 700 sessions) on 2026-08-09:
 *
 *   workflow_events          32,994 rows   6,280 kB
 *   workflow_steps           10,046 rows   2,864 kB
 *   workflow_runs             3,322 rows   2,216 kB
 *   workflow_hooks / waits / stream_chunks   0 rows      80 kB
 *                                          ─────────
 *                                          ~11.2 MB / month, 4.75 runs/session
 *
 * That is small and it is also monotonic, which is the point: the same database
 * holds `evestack.spans`, which DOES expire (default 30 days, see
 * `EVESTACK_TRACE_RETENTION_DAYS` and `evestack.prune_spans` in the dashboard's
 * sql/traces.sql), so an operator who has met retention once reasonably assumes
 * the rest of the database behaves the same way. It does not.
 *
 * ── This is opt-in, and it stays opt-in ──────────────────────────────────────
 *
 * Nothing calls this on a timer. Session history is the product — a follow-up
 * six months later resuming a conversation is the thing Postgres durability is
 * FOR — so a default that silently deleted it would be wrong even if the default
 * were generous. `db:prune` is a command a person types, it prints what it would
 * delete and exits, and it deletes only when told `--apply`.
 *
 * ── What is safe to delete, and what eve still needs ─────────────────────────
 *
 * Prune whole SESSIONS or nothing. Deleting "old turns" out of a live session
 * leaves eve a session whose history has holes in it, and there is no supported
 * way to ask it whether it minds. A session is the unit a user thinks in anyway.
 *
 * Three guards, all of them load-bearing:
 *
 *   1. NO FOREIGN KEYS EXIST. Verified against a live database: `pg_constraint`
 *      has zero `contype='f'` rows in the `workflow` namespace, and the
 *      migrations that create these tables (world-postgres
 *      src/drizzle/migrations/0000, 0007) declare none. Deleting a row from
 *      `workflow_runs` therefore orphans its events, steps, hooks, waits and
 *      stream chunks in total silence — they are matched by `run_id` with
 *      nothing enforcing it. Every table has to be named explicitly, which is
 *      what `pruneSql()` does, in ONE statement so it cannot half-apply.
 *
 *   2. NOTHING NON-TERMINAL IS TOUCHED. A run in `pending` or `running` is work
 *      world-postgres will re-enqueue on the next boot ("Re-enqueued N active
 *      run(s) on startup"). It is also how an OPEN session looks: eve's session
 *      run is `workflow//eve//workflowEntry` and it stays `running` for as long
 *      as the session is open (packages/dashboard/lib/queries.ts, the data
 *      contract at the top). One live run anywhere in the family protects the
 *      whole family.
 *
 *   3. LINEAGE COMES FROM `$rootRunId`, NOT FROM `$eve.*`. `$rootRunId` is set
 *      by the workflow runtime on any run started from inside another run
 *      (@workflow/world dist/attributes.d.ts) and is therefore on turns,
 *      subagents AND the untagged `sessionTimeoutWorkflow` companion run that
 *      eve starts per session. Grouping on `$eve.parent` would miss that last
 *      one and leave one orphan row plus its events behind per session, forever.
 *      Checked on the same database: grouping 3,322 runs by
 *      `COALESCE($rootRunId, id)` yields exactly 700 groups, all 700 rooted in a
 *      `$eve.type = 'session'` run, with every row accounted for.
 *
 * ── What this does NOT delete, deliberately ──────────────────────────────────
 *
 *   `evestack.approvals`      the audit trail. Retained forever by design — it
 *                             is the row someone wants a year later, when they
 *                             ask why the agent deleted the thing it deleted.
 *   `evestack.memories`       long-term memory. Not session state; `forget` is
 *                             the tool for it.
 *   `graphile_worker.*`       the job queue. world-postgres and graphile-worker
 *                             own it and clean up after themselves.
 *   `workflow_drizzle.*`      the migration ledger. Six rows, and deleting them
 *                             makes the next `db:bootstrap` re-run migrations.
 *
 * The derived tables ARE cleaned up, because leaving them is worse than either
 * keeping or deleting: `evestack.fact_turn` has no delete path anywhere in the
 * dashboard (grep `DELETE` in sql/facts.sql — the only one is `fact_tool_call`,
 * and only for turns a refresh already touched), so pruned runs would go on
 * feeding every chart while vanishing from the session list. They are pure
 * derivations of `workflow_runs` and `evestack.spans` — sql/facts.sql opens by
 * saying so — which is what makes deleting the orphans safe.
 */

/** Terminal run states. `paused` was removed from the enum in migration 0004. */
export const TERMINAL_STATUSES = ["completed", "failed", "cancelled"];

/**
 * Turn `90d`, `12h`, `6 months` into something Postgres will accept as an
 * interval, or throw.
 *
 * Validated here rather than passed through, because this string ends up inside
 * a `DELETE`. It is bound as a parameter (`$1::interval`) so it is not an
 * injection risk, but a typo that Postgres reads as a DIFFERENT interval is a
 * data-loss risk of its own: `90` alone is 90 SECONDS to `interval`, not 90
 * days, and it would delete essentially everything while looking like a
 * reasonable thing to type.
 */
export function parseWindow(input) {
  const raw = String(input ?? "").trim();
  if (raw === "") throw new Error("a retention window is required, e.g. --older-than=90d");

  const shorthand = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/i.exec(raw);
  if (!shorthand) {
    throw new Error(
      `"${raw}" is not a retention window. Use a number and a unit: 30d, 12h, 6mo, 1y ` +
        "(or the long form Postgres accepts, e.g. \"90 days\").",
    );
  }

  const [, amount, unit] = shorthand;
  const UNITS = {
    h: "hours",
    hr: "hours",
    hrs: "hours",
    hour: "hours",
    hours: "hours",
    d: "days",
    day: "days",
    days: "days",
    w: "weeks",
    week: "weeks",
    weeks: "weeks",
    mo: "months",
    month: "months",
    months: "months",
    y: "years",
    year: "years",
    years: "years",
  };
  // `m` is deliberately absent. It means minutes to Postgres and months to
  // roughly half the people who type it, and the two differ by a factor of
  // 43,200 in the direction that deletes everything.
  const resolved = UNITS[unit.toLowerCase()];
  if (!resolved) {
    throw new Error(
      `"${raw}" has an unrecognised unit "${unit}". Use h, d, w, mo or y — "m" is rejected ` +
        "on purpose, because it reads as minutes to Postgres and as months to most people.",
    );
  }
  if (Number(amount) <= 0) {
    throw new Error(`"${raw}" is not a positive window. Pruning with a zero window deletes everything.`);
  }
  return `${amount} ${resolved}`;
}

/**
 * The set of sessions old enough and quiet enough to remove.
 *
 * `$1` is the interval, `$2` the maximum number of sessions to consider. Both
 * `pruneSql` and `previewSql` build on this, so the thing you inspect is
 * literally the thing that gets deleted.
 *
 * `(now() AT TIME ZONE 'utc')`, never a bare `now()`. These columns are
 * `timestamp without time zone` holding UTC, so comparing one to a `timestamptz`
 * makes Postgres reinterpret it in the SERVER's zone — measured at four hours
 * under America/New_York, in the direction that makes a recent row look old.
 * contract/contracts/21-naive-timestamps.contract.mjs exists because that bug
 * shipped once already, in the dashboard's wedged-turn monitor.
 *
 * `ORDER BY max(updated_at)` so a batched run walks oldest-first and is
 * deterministic across calls.
 */
const PRUNABLE_SESSIONS = `
  SELECT COALESCE(r.attributes ->> '$rootRunId', r.id) AS session_id,
         max(r.updated_at)                             AS last_activity,
         count(*)                                      AS runs
    FROM workflow.workflow_runs r
   GROUP BY 1
  HAVING bool_or(r.attributes ->> '$eve.type' = 'session'
                 AND r.attributes ->> '$rootRunId' IS NULL)
     AND count(*) FILTER (WHERE r.status IN ('pending', 'running')) = 0
     AND max(r.updated_at) < (now() AT TIME ZONE 'utc') - $1::interval
   ORDER BY max(r.updated_at)
   LIMIT $2`;

/**
 * What a prune WOULD remove. Reads only.
 *
 * The two timestamps come back `::text` rather than as timestamps. These columns
 * are `timestamp without time zone` holding UTC, and node-postgres builds a JS
 * Date from one by reading it in the LOCAL zone — the same defect the dashboard
 * needed a type parser for, filed under "sessions starting in the future" in
 * docs/troubleshooting.mdx. This value is only ever printed, so casting in SQL is
 * cheaper than importing that fix, and it stops the report labelling a Pacific
 * wall clock as UTC. (It did, before the cast: `Wed Jan 21 2026 15:50:07
 * GMT-0800 (Pacific Standard Time) (UTC)`.)
 */
export function previewSql() {
  return `
WITH prunable AS (${PRUNABLE_SESSIONS}
),
doomed AS (
  SELECT r.id
    FROM workflow.workflow_runs r
    JOIN prunable p ON p.session_id = COALESCE(r.attributes ->> '$rootRunId', r.id)
)
SELECT (SELECT count(*) FROM prunable)                                             AS sessions,
       (SELECT min(last_activity)::text FROM prunable)                             AS oldest,
       (SELECT max(last_activity)::text FROM prunable)                             AS newest,
       (SELECT count(*) FROM doomed)                                               AS runs,
       (SELECT count(*) FROM workflow.workflow_events e
         WHERE e.run_id IN (SELECT id FROM doomed))                                AS events,
       (SELECT count(*) FROM workflow.workflow_steps s
         WHERE s.run_id IN (SELECT id FROM doomed))                                AS steps,
       (SELECT count(*) FROM workflow.workflow_hooks h
         WHERE h.run_id IN (SELECT id FROM doomed))                                AS hooks,
       (SELECT count(*) FROM workflow.workflow_waits w
         WHERE w.run_id IN (SELECT id FROM doomed))                                AS waits,
       (SELECT count(*) FROM workflow.workflow_stream_chunks c
         WHERE c.run_id IN (SELECT id FROM doomed))                                AS stream_chunks`;
}

/**
 * The delete. One statement, so it is one transaction and cannot half-apply.
 *
 * Data-modifying CTEs all run against the same snapshot, so `doomed` is the same
 * set for all six deletes even though `del_runs` is removing the rows the others
 * are reading. Verified against 3,322 real rows inside a rolled-back
 * transaction: 50 sessions selected -> 245 runs, 2,442 events, 740 steps
 * removed, and a follow-up count of events whose `run_id` no longer resolves
 * returned 0.
 *
 * `$2` bounds the batch. The caller loops, so each call commits on its own —
 * the same shape `evestack.prune_spans` uses and for the same reason: a first
 * prune over a year of backlog inside one transaction holds locks and piles up
 * WAL for the whole of it.
 */
export function pruneSql() {
  return `
WITH prunable AS (${PRUNABLE_SESSIONS}
),
doomed AS (
  SELECT r.id
    FROM workflow.workflow_runs r
    JOIN prunable p ON p.session_id = COALESCE(r.attributes ->> '$rootRunId', r.id)
),
del_events AS (
  DELETE FROM workflow.workflow_events e WHERE e.run_id IN (SELECT id FROM doomed) RETURNING 1
),
del_steps AS (
  DELETE FROM workflow.workflow_steps s WHERE s.run_id IN (SELECT id FROM doomed) RETURNING 1
),
del_hooks AS (
  DELETE FROM workflow.workflow_hooks h WHERE h.run_id IN (SELECT id FROM doomed) RETURNING 1
),
del_waits AS (
  DELETE FROM workflow.workflow_waits w WHERE w.run_id IN (SELECT id FROM doomed) RETURNING 1
),
del_chunks AS (
  DELETE FROM workflow.workflow_stream_chunks c WHERE c.run_id IN (SELECT id FROM doomed) RETURNING 1
),
del_runs AS (
  DELETE FROM workflow.workflow_runs r WHERE r.id IN (SELECT id FROM doomed) RETURNING 1
)
SELECT (SELECT count(*) FROM prunable)   AS sessions,
       (SELECT count(*) FROM del_runs)   AS runs,
       (SELECT count(*) FROM del_events) AS events,
       (SELECT count(*) FROM del_steps)  AS steps,
       (SELECT count(*) FROM del_hooks)  AS hooks,
       (SELECT count(*) FROM del_waits)  AS waits,
       (SELECT count(*) FROM del_chunks) AS stream_chunks`;
}

/**
 * Drop derived rows whose source run is gone.
 *
 * Run after a prune, and only then. `evestack.fact_turn` and
 * `evestack.fact_tool_call` are the dashboard's fact layer; its own file opens
 * with "These tables hold NOTHING you cannot rebuild", every column being
 * derived from `workflow.workflow_runs`, `workflow.workflow_steps` and
 * `evestack.spans`. `evestack.refresh_facts` is an upsert keyed on `run_id` and
 * never deletes a `fact_turn` row, so without this the charts keep counting
 * tokens and dollars for sessions the session list no longer shows.
 *
 * Guarded by `to_regclass` because both tables are optional: a deployment that
 * has never opened the dashboard has no `evestack` schema at all, and a prune
 * must not fail on that.
 *
 * The sweep is GLOBAL, not scoped to the runs this prune just removed — it
 * deletes every fact row whose run is missing, including ones orphaned by an
 * earlier hand-run `DELETE`. That is deliberate (an orphan is an orphan) and
 * observed: a fixture row pointing at a run that never existed was collected on
 * the first `--apply`, alongside the two belonging to the sessions being pruned.
 * `--keep-facts` opts out entirely.
 */
export function orphanedFactsSql() {
  return `
WITH del_turns AS (
  DELETE FROM evestack.fact_turn f
   WHERE NOT EXISTS (SELECT 1 FROM workflow.workflow_runs r WHERE r.id = f.run_id)
  RETURNING 1
),
del_tools AS (
  DELETE FROM evestack.fact_tool_call f
   WHERE NOT EXISTS (SELECT 1 FROM workflow.workflow_runs r WHERE r.id = f.run_id)
  RETURNING 1
)
SELECT (SELECT count(*) FROM del_turns) AS fact_turns,
       (SELECT count(*) FROM del_tools) AS fact_tool_calls`;
}

/** Do the fact tables exist? They are created by the dashboard, not by the agent. */
export const FACTS_PRESENT_SQL =
  "SELECT to_regclass('evestack.fact_turn') IS NOT NULL " +
  "AND to_regclass('evestack.fact_tool_call') IS NOT NULL AS present";
