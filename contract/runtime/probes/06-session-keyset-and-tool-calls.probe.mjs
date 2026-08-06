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
 * ─ 3. The partial-index predicate is one Postgres can actually prove ─
 *
 * `sql/run-indexes.sql` uses `WHERE (attributes->>'$eve.root') IS NOT NULL`
 * rather than `WHERE attributes ? '$eve.root'`. The two select identical rows;
 * only the first is implied by the query's own `= $1`, so only the first is
 * ever used. Measured, the `?` form built fine, was never chosen, and left the
 * LATERAL a sequential scan while still costing every insert. That is a trap
 * worth a permanent assertion, because both indexes look equally healthy in
 * `\d`.
 *
 * Fixtures mirror the shapes in packages/dashboard/scripts/seed.mjs. Drift
 * between them should be read as this probe going stale rather than as a
 * discovery.
 */
import { randomUUID } from "node:crypto";

/** Exactly the sort key the seeded database produces for a tied pair. */
const TIED_AT = "2026-08-06 11:56:37.310418";

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
      /* 2. index conditions                                               */
      /* ---------------------------------------------------------------- */

      // Bulk so the planner has a reason to prefer an index at all.
      await client.query(`
        INSERT INTO ${schema}.workflow_runs (id, status, created_at, attributes)
        SELECT 'wrun_bulk_' || g, 'completed',
               timestamp '2026-01-01 00:00:00' + (g || ' seconds')::interval,
               jsonb_build_object('$eve.type','turn','$eve.root','wrun_tie_a','$eve.parent','wrun_tie_a')
          FROM generate_series(1, 20000) g
      `);
      await client.query(`
        CREATE INDEX probe_type_created_idx
          ON ${schema}.workflow_runs ((attributes->>'$eve.type'), created_at DESC, id DESC)
      `);
      await client.query(`ANALYZE ${schema}.workflow_runs`);

      const explain = async (sql, params = []) =>
        (await client.query(`EXPLAIN ${sql}`, params)).rows.map((r) => r["QUERY PLAN"]).join("\n");

      const keysetPlan = await explain(
        `SELECT id FROM ${schema}.workflow_runs s
          WHERE s.attributes->>'$eve.type' = 'session'
            AND (s.created_at, s.id) < ($1::timestamp, $2::text)
          ORDER BY s.created_at DESC, s.id DESC LIMIT 50`,
        [TIED_AT, "wrun_tie_a"],
      );
      // "Index Cond", not "Filter": a filter means every matching row is read
      // and discarded, which is the O(table) behaviour keyset paging replaces.
      const isIndexCond = /Index Cond:.*ROW\(created_at/s.test(keysetPlan);
      t.ok(
        isIndexCond,
        "the row comparison becomes an index condition, not a post-scan filter",
        isIndexCond ? {} : { expected: "Index Cond containing ROW(created_at, …)", actual: keysetPlan },
      );

      // The partial-predicate trap, both halves.
      await client.query(`
        CREATE INDEX probe_root_jsonb_exists_idx ON ${schema}.workflow_runs ((attributes->>'$eve.root'))
          WHERE attributes ? '$eve.root'
      `);
      await client.query(`ANALYZE ${schema}.workflow_runs`);
      const rootLookup = `SELECT id FROM ${schema}.workflow_runs WHERE attributes->>'$eve.root' = 'wrun_tie_a'`;
      const unprovable = await explain(rootLookup);
      const unprovableUsed = unprovable.includes("probe_root_jsonb_exists_idx");
      t.ok(
        !unprovableUsed,
        "a `WHERE attributes ? '$eve.root'` partial index is NEVER used by an `->>` equality",
        unprovableUsed
          ? {
              expected: "the planner to ignore it — Postgres cannot prove `->> = $1` implies `? '$eve.root'`",
              actual: `it was used, so sql/run-indexes.sql could safely use the cheaper predicate:\n${unprovable}`,
            }
          : {},
      );

      await client.query(`DROP INDEX ${schema}.probe_root_jsonb_exists_idx`);
      await client.query(`
        CREATE INDEX probe_root_notnull_idx ON ${schema}.workflow_runs ((attributes->>'$eve.root'))
          WHERE (attributes->>'$eve.root') IS NOT NULL
      `);
      await client.query(`ANALYZE ${schema}.workflow_runs`);
      const provable = await explain(rootLookup);
      const provableUsed = provable.includes("probe_root_notnull_idx");
      t.ok(
        provableUsed,
        "the `IS NOT NULL` partial index IS used, because equality is strict and implies it",
        provableUsed
          ? {}
          : {
              expected: "an index scan on probe_root_notnull_idx",
              actual: `${provable}\n— sql/run-indexes.sql ships this index for exactly this lookup; if it is not used it is pure write cost`,
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

      const { rows: counted } = await client.query(
        `WITH runs AS (
           SELECT id FROM ${schema}.workflow_runs
            WHERE attributes->>'$eve.root' = $1 AND attributes->>'$eve.type' IS NOT NULL
         ),
         trace_turn AS (
           SELECT s.trace_id, MIN(s.turn_id) AS turn_id
             FROM ${schema}.spans s
            WHERE s.turn_id IN (SELECT id FROM runs)
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
