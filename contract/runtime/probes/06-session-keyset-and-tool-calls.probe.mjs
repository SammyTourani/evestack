/**
 * Two claims `packages/dashboard/lib/queries.ts` makes that only a real
 * PostgreSQL server can settle.
 *
 * ─ 1. The session list pages correctly ─
 *
 * `listSessions` walks `(created_at, id)` with a row comparison instead of
 * OFFSET. Three things about that are PostgreSQL's semantics, not JavaScript's,
 * and each has a failure mode that shows a user duplicated or missing sessions
 * with no error anywhere:
 *
 *   - a cursor rounded to milliseconds silently DROPS rows. `toISOString`
 *     truncates the microseconds the column holds, and a DESC walk keeps rows
 *     strictly below the cursor, so a smaller cursor excludes more than it
 *     should: every session sharing that millisecond and sorting below the
 *     cursor row is served on no page at all. This is why the cursor carries
 *     `to_char(created_at, …US)` rather than a JS ISO string.
 *   - rows tied on `created_at` must still partition exactly across pages. Ties
 *     are why `id` is in the sort at all; with `ORDER BY created_at DESC` alone
 *     the tied rows may come back in either order per query and an OFFSET
 *     boundary inside the tie both skips one and repeats another.
 *   - `(created_at, id) < ($1, $2)` must become an index CONDITION on the
 *     expression index, not a filter applied after the scan. If it degrades to
 *     a filter the query is still correct and quietly O(table) — the exact
 *     thing keyset paging was adopted to avoid.
 *
 * ─ 2. Tool invocations are counted, or absent — never zero by default ─
 *
 * `execute_tool` spans carry no turn id, so `getSessionTree` inherits one down
 * `trace_id`. The three outcomes it must distinguish are a real count, a real
 * zero (trace found, no tool spans in it) and unknown (no trace, or a trace
 * that resolves to more than one turn). Rendering unknown as `0` would state
 * that a turn called no tools when the truth is that nothing recorded whether
 * it did.
 *
 * The ambiguous case has two shapes and only one of them is obvious. A trace
 * covering two turns of the SAME session is caught by anything; a trace
 * covering one turn here and one turn in another session is caught only if the
 * guard counts turn ids over the whole trace rather than over the spans this
 * session's query happened to select. Both are fixtured below, because the
 * second is the one the query got wrong.
 *
 * ─ 3. The shipped index file applies, and its predicate is one Postgres can
 *      actually prove ─
 *
 * `packages/dashboard/sql/query-indexes.sql` is executed by exactly one thing:
 * `ensureQueryIndexes()`, at runtime, which warns once and swallows every
 * failure by design. So a typo in that file costs every page its indexes and
 * says so nowhere a human will look. This probe is the thing that reads it —
 * rewritten onto a throwaway schema and run for real, so a broken statement is
 * a red check with the Postgres error in it.
 *
 * Rewriting the schema names is the one thing this cannot see: the file is
 * proven to be valid SQL against tables of the right SHAPE, not proven to be
 * pointed at the right schemas. `contract/contracts/06-run-attributes.contract.mjs`
 * covers the attribute names; nothing covers a wrong schema name, and a wrong
 * schema name would at least fail loudly in psql.
 *
 * The predicate half: the file uses `WHERE (attributes->>'$eve.root') IS NOT
 * NULL` rather than `WHERE attributes ? '$eve.root'`. The two select identical
 * rows; only the first is implied by the query's own `= $1`, so only the first
 * is ever used. Measured, the `?` form built fine, was never chosen, and left
 * the LATERAL a sequential scan while still costing every insert. That is a
 * trap worth a permanent assertion, because both indexes look equally healthy
 * in `\d`.
 *
 * Fixtures mirror the shapes in packages/dashboard/scripts/seed.mjs. Drift
 * between them should be read as this probe going stale rather than as a
 * discovery.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../../lib/repo.mjs";

/** Exactly the sort key the seeded database produces for a tied pair. */
const TIED_AT = "2026-08-06 11:56:37.310418";

/** The DDL the dashboard applies at boot, and that nothing else ever runs. */
const INDEX_FILE = "packages/dashboard/sql/query-indexes.sql";

async function connect() {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.WORKFLOW_POSTGRES_URL });
  await client.connect();
  return client;
}

export default {
  id: "queries/session-keyset-and-tool-calls",
  title: "the session list pages without skipping or repeating, and tool calls are counted or absent",
  needs: ["postgres"],
  why:
    "Both failures here are silent. A cursor rounded to milliseconds re-serves the row it came " +
    "from, so a client paging to the end loops; a tie in created_at with no id tiebreak lets an " +
    "OFFSET boundary skip one session and show another twice. And a turn whose trace was never " +
    "exported has no evidence about tool calls at all — reporting 0 there is a confident claim " +
    "that the agent used no tools, which is a different statement from 'we do not know'.",

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

    try {
      await client.query(`CREATE SCHEMA ${schema}`);

      // `timestamp without time zone`, as world-postgres declares it. The
      // rounding trap below only exists because this column keeps microseconds.
      await client.query(`
        CREATE TABLE ${schema}.workflow_runs (
          id           varchar PRIMARY KEY,
          status       text NOT NULL,
          error_code   text,
          created_at   timestamp NOT NULL,
          started_at   timestamp,
          completed_at timestamp,
          attributes   jsonb NOT NULL DEFAULT '{}'::jsonb
        )
      `);

      // The generated turn_id column from packages/dashboard/sql/traces.sql.
      await client.query(`
        CREATE TABLE ${schema}.spans (
          trace_id   text NOT NULL,
          span_id    text NOT NULL,
          name       text NOT NULL,
          attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
          turn_id    text GENERATED ALWAYS AS (
            COALESCE(attributes->>'agent.turn.id',
                     attributes->>'ai.settings.context.eve.turn.id')
          ) STORED,
          PRIMARY KEY (trace_id, span_id)
        )
      `);

      const addSession = (id, at) =>
        client.query(
          `INSERT INTO ${schema}.workflow_runs (id, status, created_at, attributes)
           VALUES ($1, 'running', $2::timestamp, '{"$eve.type":"session"}'::jsonb)`,
          [id, at],
        );
      const addTurn = (id, sessionId, at) =>
        client.query(
          `INSERT INTO ${schema}.workflow_runs (id, status, created_at, completed_at, attributes)
           VALUES ($1, 'completed', $2::timestamp, $2::timestamp,
                   jsonb_build_object('$eve.type','turn','$eve.root',$3::text,'$eve.parent',$3::text))`,
          [id, at, sessionId],
        );
      const addSpan = (traceId, name, turnId) =>
        client.query(
          `INSERT INTO ${schema}.spans (trace_id, span_id, name, attributes)
           VALUES ($1, $2, $3, CASE WHEN $4::text IS NULL THEN '{}'::jsonb
                   ELSE jsonb_build_object('ai.settings.context.eve.turn.id', $4::text) END)`,
          [traceId, randomUUID().slice(0, 16), name, turnId ?? null],
        );

      /* ---------------------------------------------------------------- */
      /* 1. paging                                                         */
      /* ---------------------------------------------------------------- */

      // Three sessions tied on created_at to the microsecond, plus one older.
      // Ties are the case the id tiebreak exists for.
      await addSession("wrun_tie_c", TIED_AT);
      await addSession("wrun_tie_b", TIED_AT);
      await addSession("wrun_tie_a", TIED_AT);
      await addSession("wrun_older", "2026-08-06 09:00:00.000001");

      const page = async (cursorAt, cursorId, limit) => {
        const { rows } = await client.query(
          `SELECT id, to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS cursor_created_at
             FROM ${schema}.workflow_runs s
            WHERE s.attributes->>'$eve.type' = 'session'
              AND ($1::text IS NULL OR (s.created_at, s.id) < ($1::timestamp, $2::text))
            ORDER BY s.created_at DESC, s.id DESC
            LIMIT $3`,
          [cursorAt, cursorId, limit],
        );
        return rows;
      };

      const seen = [];
      let cursor = null;
      for (let guard = 0; guard < 10; guard += 1) {
        const rows = await page(cursor?.at ?? null, cursor?.id ?? null, 2);
        if (rows.length === 0) break;
        seen.push(...rows.map((r) => r.id));
        if (rows.length < 2) break;
        const last = rows[rows.length - 1];
        cursor = { at: last.cursor_created_at, id: last.id };
      }

      const partitions =
        seen.length === 4 && new Set(seen).size === 4 && seen[0] === "wrun_tie_c" && seen[3] === "wrun_older";
      t.ok(
        partitions,
        "a keyset walk over rows tied on created_at visits each session exactly once",
        partitions
          ? {}
          : {
              expected: "wrun_tie_c, wrun_tie_b, wrun_tie_a, wrun_older — four ids, no repeats",
              actual: seen.join(", "),
            },
      );

      // The rounding trap, in the direction it actually bites. `toISOString`
      // TRUNCATES microseconds, and the walk is DESC with `<`, so a rounded
      // cursor is strictly smaller than the row it came from and therefore
      // excludes MORE than it should. The lost rows are the ones sharing the
      // cursor's millisecond and sorting below it: they are never served on any
      // page and no error is raised. (Repeats would be the ASC failure mode;
      // this list is DESC, so it silently loses sessions instead.)
      const exactIds = (await page("2026-08-06T11:56:37.310418", "wrun_tie_b", 5)).map((r) => r.id);
      const roundedIds = (await page("2026-08-06T11:56:37.310", "wrun_tie_b", 5)).map((r) => r.id);

      const exactIsComplete = exactIds.join(",") === "wrun_tie_a,wrun_older";
      t.ok(
        exactIsComplete,
        "the exact cursor excludes the row it came from and everything above it, and nothing else",
        exactIsComplete ? {} : { expected: "wrun_tie_a, wrun_older", actual: exactIds.join(", ") || "nothing" },
      );

      const roundingSkips = !roundedIds.includes("wrun_tie_a") && exactIds.includes("wrun_tie_a");
      t.ok(
        roundingSkips,
        "a millisecond-rounded cursor silently drops a session, which is why the cursor carries to_char(...US)",
        roundingSkips
          ? {}
          : {
              expected: "the rounded cursor to LOSE wrun_tie_a that the exact cursor returns",
              actual: `exact → [${exactIds}], rounded → [${roundedIds}] — if these agree the fixture lost its microseconds and the assertion is vacuous`,
            },
      );

      /* ---------------------------------------------------------------- */
      /* 2. the shipped index file, and the plans it is supposed to buy    */
      /* ---------------------------------------------------------------- */

      // Bulk so the planner has a reason to prefer an index at all.
      await client.query(`
        INSERT INTO ${schema}.workflow_runs (id, status, created_at, attributes)
        SELECT 'wrun_bulk_' || g, 'completed',
               timestamp '2026-01-01 00:00:00' + (g || ' seconds')::interval,
               jsonb_build_object('$eve.type','turn','$eve.root','wrun_tie_a','$eve.parent','wrun_tie_a')
          FROM generate_series(1, 20000) g
      `);
      await client.query(`ANALYZE ${schema}.workflow_runs`);

      const explain = async (sql, params = []) =>
        (await client.query(`EXPLAIN ${sql}`, params)).rows.map((r) => r["QUERY PLAN"]).join("\n");

      const rootLookup = `SELECT id FROM ${schema}.workflow_runs WHERE attributes->>'$eve.root' = 'wrun_tie_a'`;

      // The negative control runs FIRST, and alone. Once the shipped
      // `IS NOT NULL` index exists the planner has a usable index either way,
      // and "the `?` index was not chosen" stops meaning anything.
      await client.query(`
        CREATE INDEX probe_root_jsonb_exists_idx ON ${schema}.workflow_runs ((attributes->>'$eve.root'))
          WHERE attributes ? '$eve.root'
      `);
      await client.query(`ANALYZE ${schema}.workflow_runs`);
      const unprovable = await explain(rootLookup);
      const unprovableUsed = unprovable.includes("probe_root_jsonb_exists_idx");
      t.ok(
        !unprovableUsed,
        "a `WHERE attributes ? '$eve.root'` partial index is NEVER used by an `->>` equality",
        unprovableUsed
          ? {
              expected: "the planner to ignore it — Postgres cannot prove `->> = $1` implies `? '$eve.root'`",
              actual: `it was used, so ${INDEX_FILE} could safely use the cheaper predicate:\n${unprovable}`,
            }
          : {},
      );
      await client.query(`DROP INDEX ${schema}.probe_root_jsonb_exists_idx`);

      // Now the file itself, rather than a hand-copy of it. Two things follow
      // from running the real bytes: a typo is a red check here instead of a
      // once-per-process console.warn nobody reads, and the plan assertions
      // below are about the indexes that actually ship rather than about
      // indexes this probe wrote to look like them.
      const indexSql = readFileSync(join(REPO_ROOT, INDEX_FILE), "utf8");

      // The file's own promise, and the entire argument for creating anything
      // in `workflow` — someone else's schema. An index is additive and
      // reversible; an ALTER or a data statement smuggled in here would run
      // against eve's live table at boot with its failure swallowed.
      const statements = indexSql
        .replace(/^\s*--.*$/gm, "")
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);
      const notIndexes = statements.filter((s) => !/^CREATE INDEX IF NOT EXISTS /i.test(s));
      t.ok(
        statements.length > 0 && notIndexes.length === 0,
        `every statement in ${INDEX_FILE} is a CREATE INDEX IF NOT EXISTS`,
        notIndexes.length === 0
          ? { expected: "at least one statement", actual: "the file parsed to no statements at all" }
          : { expected: "CREATE INDEX IF NOT EXISTS only", actual: notIndexes.join("\n---\n") },
      );

      let applyError = null;
      try {
        // Same multi-statement, single-query application the dashboard does,
        // pointed at this schema's copies of the two tables.
        await client.query(
          indexSql
            .replaceAll("workflow.workflow_runs", `${schema}.workflow_runs`)
            .replaceAll("evestack.spans", `${schema}.spans`),
        );
      } catch (error) {
        applyError = error;
      }
      t.ok(
        applyError === null,
        `${INDEX_FILE} applies cleanly — the only place anything but a live dashboard runs it`,
        applyError === null
          ? {}
          : {
              expected: "every statement to succeed",
              actual: `${applyError.message}\n— ensureQueryIndexes() would have warned once and swallowed this, leaving every page un-indexed`,
            },
      );
      await client.query(`ANALYZE ${schema}.workflow_runs`);

      const keysetPlan = await explain(
        `SELECT id FROM ${schema}.workflow_runs s
          WHERE s.attributes->>'$eve.type' = 'session'
            AND (s.created_at, s.id) < ($1::timestamp, $2::text)
          ORDER BY s.created_at DESC, s.id DESC LIMIT 50`,
        [TIED_AT, "wrun_tie_a"],
      );
      // "Index Cond", not "Filter": a filter means every matching row is read
      // and discarded, which is the O(table) behaviour keyset paging replaces.
      // The index NAME is asserted too, so the check cannot pass on some other
      // index that happens to exist while the shipped one is doing nothing.
      const isIndexCond =
        /Index Cond:.*ROW\(created_at/s.test(keysetPlan) && keysetPlan.includes("evestack_runs_type_created_idx");
      t.ok(
        isIndexCond,
        "the row comparison becomes an index condition on the shipped evestack_runs_type_created_idx",
        isIndexCond
          ? {}
          : { expected: "Index Cond containing ROW(created_at, …) on evestack_runs_type_created_idx", actual: keysetPlan },
      );

      const provable = await explain(rootLookup);
      const provableUsed = provable.includes("evestack_runs_root_idx");
      t.ok(
        provableUsed,
        "the `IS NOT NULL` partial index IS used, because equality is strict and implies it",
        provableUsed
          ? {}
          : {
              expected: "an index scan on evestack_runs_root_idx",
              actual: `${provable}\n— ${INDEX_FILE} ships this index for exactly this lookup; if it is not used it is pure write cost`,
            },
      );

      /* ---------------------------------------------------------------- */
      /* 3. tool invocations                                               */
      /* ---------------------------------------------------------------- */

      await addTurn("wrun_turn_tools", "wrun_tie_a", "2026-08-06 11:56:38.000000");
      await addTurn("wrun_turn_notools", "wrun_tie_a", "2026-08-06 11:56:39.000000");
      await addTurn("wrun_turn_notrace", "wrun_tie_a", "2026-08-06 11:56:40.000000");
      await addTurn("wrun_turn_shared_a", "wrun_tie_a", "2026-08-06 11:56:41.000000");
      await addTurn("wrun_turn_shared_b", "wrun_tie_a", "2026-08-06 11:56:42.000000");

      // A trace in the shape a real exporting install emits: only the root and
      // the step spans carry the turn id; the tool spans carry nothing.
      await addSpan("trace_tools", "ai.eve.turn", "wrun_turn_tools");
      await addSpan("trace_tools", "step 1", "wrun_turn_tools");
      await addSpan("trace_tools", "chat gpt-5-mini", null);
      await addSpan("trace_tools", "execute_tool bash", null);
      await addSpan("trace_tools", "execute_tool read_file", null);
      await addSpan("trace_tools", "execute_tool bash", null);
      // `_` is a LIKE wildcard. Unescaped, this span would be counted as a
      // fourth tool call.
      await addSpan("trace_tools", "executeXtool decoy", null);

      await addSpan("trace_notools", "ai.eve.turn", "wrun_turn_notools");
      await addSpan("trace_notools", "chat gpt-5-mini", null);

      // One trace, two turns: cannot say which one called the tool.
      await addSpan("trace_shared", "ai.eve.turn", "wrun_turn_shared_a");
      await addSpan("trace_shared", "ai.eve.turn", "wrun_turn_shared_b");
      await addSpan("trace_shared", "execute_tool bash", null);

      // The same ambiguity, reaching OUTSIDE the session being rendered — one
      // turn here, one turn in a session this query never selects. It is the
      // case a session-scoped guard cannot see: filter the spans to this
      // session's runs before counting distinct turn ids and the second turn
      // vanishes, the trace looks unambiguous, and its tool call is charged to
      // whichever turn happens to be ours.
      await addSession("wrun_other_session", "2026-08-06 08:00:00.000000");
      await addTurn("wrun_turn_elsewhere", "wrun_other_session", "2026-08-06 08:00:01.000000");
      await addTurn("wrun_turn_crossed", "wrun_tie_a", "2026-08-06 11:56:43.000000");
      await addSpan("trace_crossed", "ai.eve.turn", "wrun_turn_crossed");
      await addSpan("trace_crossed", "ai.eve.turn", "wrun_turn_elsewhere");
      await addSpan("trace_crossed", "execute_tool bash", null);

      const { rows: counted } = await client.query(
        `WITH runs AS (
           SELECT id FROM ${schema}.workflow_runs
            WHERE attributes->>'$eve.root' = $1 AND attributes->>'$eve.type' IS NOT NULL
         ),
         trace_turn AS (
           SELECT s.trace_id, MIN(s.turn_id) AS turn_id
             FROM ${schema}.spans s
            WHERE s.trace_id IN (
                    SELECT t.trace_id FROM ${schema}.spans t WHERE t.turn_id IN (SELECT id FROM runs)
                  )
              AND s.turn_id IS NOT NULL
            GROUP BY s.trace_id
           HAVING COUNT(DISTINCT s.turn_id) = 1
         ),
         tool_calls AS (
           SELECT tt.turn_id,
                  COUNT(*) FILTER (WHERE s.name LIKE 'execute\\_tool %') AS invocations
             FROM trace_turn tt
             JOIN ${schema}.spans s ON s.trace_id = tt.trace_id
            GROUP BY tt.turn_id
         )
         SELECT r.id, tc.invocations
           FROM runs r LEFT JOIN tool_calls tc ON tc.turn_id = r.id`,
        ["wrun_tie_a"],
      );
      const got = new Map(counted.map((r) => [r.id, r.invocations === null ? null : Number(r.invocations)]));

      const cases = [
        ["wrun_turn_tools", 3, "three execute_tool spans in the trace are counted through trace_id, not a turn tag"],
        ["wrun_turn_notools", 0, "a turn WITH a trace and no tool spans is a real zero"],
        ["wrun_turn_notrace", null, "a turn with no exported trace is absent, not zero"],
        ["wrun_turn_shared_a", null, "a trace covering two turns attributes to neither, rather than guessing"],
        ["wrun_turn_shared_b", null, "the other turn of that ambiguous trace is absent too"],
        [
          "wrun_turn_crossed",
          null,
          "a trace whose second turn belongs to ANOTHER session is ambiguous too — the guard counts turn ids over the whole trace, not over the spans this session selected",
        ],
      ];
      for (const [id, want, detail] of cases) {
        const actual = got.get(id);
        const matches = actual === want;
        t.ok(matches, detail, matches ? {} : { expected: want === null ? "null" : want, actual: String(actual) });
      }

      // The decoy is the whole point of the backslash. State it separately so a
      // regression names itself.
      const decoyCounted = got.get("wrun_turn_tools") === 4;
      t.ok(
        !decoyCounted,
        "`_` is escaped in the LIKE, so an 'executeXtool …' span is not counted as a tool call",
        decoyCounted
          ? { expected: 3, actual: "4 — the LIKE pattern is treating `_` as a wildcard" }
          : {},
      );
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
      await client.end();
    }
  },
};
