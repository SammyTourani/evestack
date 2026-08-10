-- Indexes the queries in lib/queries.ts need, and nothing else.
--
-- One table, for one reason. Every statement here is an expression index for
-- the `$eve.*` JSONB lookups on `workflow.workflow_runs`, which is someone
-- else's table and needs the justification below. Indexes on `evestack.spans`
-- belong in sql/traces.sql, beside the table that declares it.
--
-- ─ Why this file breaks the rule the other sql/ files obey ────────────────────
--
-- `workflow` belongs to @workflow/world-postgres. evestack reads it and never
-- writes it, and everything evestack creates lives in the `evestack` schema so
-- that `DROP SCHEMA evestack CASCADE` costs nothing durable. This file is the
-- single exception, and it is narrow on purpose:
--
--   * CREATE INDEX IF NOT EXISTS only. No table, no column, no constraint, no
--     trigger, no data. An index changes no row and no query result — drop
--     every one of these and the dashboard still answers exactly the same
--     numbers, only slower. Enforced, not just promised: the probe named at the
--     bottom of this header parses every statement in this file and fails on
--     anything that is not a CREATE INDEX IF NOT EXISTS.
--   * Every name is prefixed `evestack_`, so an operator reading `\d
--     workflow.workflow_runs` can tell at a glance which indexes are ours and
--     `DROP INDEX workflow.evestack_*` is a complete uninstall.
--   * world-postgres cannot collide with these. Its own migrations create
--     `workflow_runs_pkey`, `workflow_runs_name_index`, `workflow_runs_status_index`;
--     an index it does not know about is invisible to `CREATE TABLE`/`ALTER
--     TABLE` and cannot fail one.
--
-- What would make this NOT acceptable, and should send it back to the
-- `evestack` schema as a materialized rollup instead:
--
--   * Anything non-additive. A UNIQUE index, an index that enforces a shape, or
--     anything world-postgres could trip over is out — that is writing their
--     schema, not annotating it.
--   * If world-postgres ever ships indexes on the same expressions, delete ours
--     rather than keeping duplicates: two indexes on one expression is double
--     the write amplification for zero read benefit.
--   * If eve renames a `$eve.*` key, these silently index a column of NULLs and
--     stop helping without erroring. `contract/contracts/06-run-attributes.contract.mjs`
--     is what catches that.
--
-- ─ The lock, honestly ─────────────────────────────────────────────────────────
--
-- These are plain CREATE INDEX, not CONCURRENTLY, because the file is applied
-- as one multi-statement query and Postgres refuses CONCURRENTLY inside the
-- implicit transaction that creates. A plain CREATE INDEX takes a SHARE lock on
-- workflow.workflow_runs, which blocks eve's writes — that is, blocks live
-- agent turns — for as long as the build takes. On the seeded 3,322 runs that
-- is single-digit milliseconds. On a table large enough for that to hurt, the
-- first dashboard boot after deploying this pauses the agent for a second or
-- two, once. If that is ever not acceptable, build them by hand with
-- CONCURRENTLY before the dashboard first boots; `IF NOT EXISTS` then makes
-- this file a no-op.
--
-- Safe to run on every boot: each statement is a no-op once its index exists.
--
-- ─ Who checks this file ───────────────────────────────────────────────────────
--
-- `ensureQueryIndexes()` in lib/queries.ts applies it at runtime and SWALLOWS
-- every failure behind one console.warn, on purpose — a read-only role must get
-- a slow page, not a 500. Which means a typo in here changes nothing a user or
-- a CI run would ever see. So the thing that actually reads these bytes is
-- contract/runtime/probes/06-session-keyset-and-tool-calls.probe.mjs: it copies
-- the file onto a throwaway schema, runs it, and asserts the plans it is
-- supposed to buy. CI runs that probe with --require=postgres, so it cannot
-- skip. Edit this file and run it: `node contract/runtime/run.mjs --only=queries`.

-- The session list: filter on $eve.type, then a keyset walk in (created_at DESC,
-- id DESC). The trailing columns are what let the LIMIT apply BEFORE the LATERAL
-- rollup — without them Postgres materialised the per-session aggregate for all
-- 701 sessions and threw 651 of them away at a top-N sort.
--
-- Measured on the seeded database (3,322 runs, 701 sessions, LIMIT 50):
--   before  213.849 ms, 134,790 shared buffers
--   after     0.325 ms,      307 shared buffers
CREATE INDEX IF NOT EXISTS evestack_runs_type_created_idx
  ON workflow.workflow_runs ((attributes->>'$eve.type'), created_at DESC, id DESC);

-- The parent/child rollup in listSessions and getSessionTree, which reads
-- `$eve.root = ? OR $eve.parent = ?`. Two single-expression indexes rather than
-- one composite: an OR of two different expressions is served by a BitmapOr of
-- two index scans, and a composite index on both cannot answer either half.
--
-- The partial predicate is `IS NOT NULL`, NOT `attributes ? '$eve.root'`. They
-- select the identical rows, but only the first is one Postgres's predicate
-- prover can discharge from the query's `(attributes->>'$eve.root') = $1`
-- (equality is strict, so it implies NOT NULL). With the `?` form the indexes
-- built fine, were never used, and the LATERAL stayed a sequential scan — a
-- partial index whose predicate cannot be proven is dead weight that still
-- costs every write.
CREATE INDEX IF NOT EXISTS evestack_runs_root_idx
  ON workflow.workflow_runs ((attributes->>'$eve.root'))
  WHERE (attributes->>'$eve.root') IS NOT NULL;

CREATE INDEX IF NOT EXISTS evestack_runs_parent_idx
  ON workflow.workflow_runs ((attributes->>'$eve.parent'))
  WHERE (attributes->>'$eve.parent') IS NOT NULL;

-- ─ evestack.spans is no longer indexed from here ─────────────────────────────
--
-- There used to be one span index in this file, on the declared `turn_id`, with
-- a note that it would read better beside the table. It moved: getSessionTree
-- now looks spans up by `resolved_turn_id` — the only one of the two that names
-- a workflow run — and the index followed it into sql/traces.sql, which owns
-- that table and can also drop the old one. Nothing is lost; the measurement
-- that justified it is quoted there.
--
-- So this file is now exactly what its header argues for and nothing else:
-- expression indexes on `workflow.workflow_runs`, someone else's table.

-- Deliberately NOT indexed:
--
--   $eve.model, $eve.input_tokens, $eve.output_tokens — read only by getTotals,
--   which aggregates every row in the table. No index helps a full aggregate,
--   and each one would slow every run insert eve makes. When getTotals becomes
--   a problem it needs a rollup, not an index.
