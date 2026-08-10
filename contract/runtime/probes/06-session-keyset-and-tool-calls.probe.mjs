/**
 * Two claims `packages/dashboard/lib/queries.ts` makes that only a real
 * PostgreSQL server can settle — asserted against the SHIPPED queries.
 *
 * ─ WHY THIS PROBE WAS REWRITTEN. READ THIS BEFORE EDITING IT. ────────────────
 *
 * The version of this file that shipped before restated the queries it was
 * checking. It built a scratch SCHEMA, wrote its own `workflow_runs` and
 * `spans` into it, and then executed a HAND-COPIED `trace_turn` CTE. That copy
 * was correct. The shipped one was not: `getSessionTree` joined spans on a turn
 * id that, on every install that exports its traces, is the literal string
 * `turn_0` and joins to no workflow run at all. So the session page reported
 * that it had no spans, no transcript and an unknown tool count for sessions
 * whose spans were sitting one click away — and this probe was green for the
 * whole of it, because it was asserting about SQL it had written itself.
 *
 * By the time the bug was fixed the two had drifted in the open: the shipped
 * query reads `resolved_turn_id`, the copy still read `turn_id`. Two different
 * queries, one of them checked.
 *
 * So the fixtures now live in a throwaway DATABASE with the real schema names
 * in it (contract/runtime/lib/fixture-db.mjs explains that choice), the
 * dashboard's own pool is pointed at it, and the assertions call
 * `listSessions` and `getSessionTree` themselves. Nothing here writes SQL that
 * the product does not.
 *
 * ─ 1. The session list pages correctly ─
 *
 * `listSessions` walks `(created_at, id)` with a row comparison instead of
 * OFFSET. Three things about that are PostgreSQL's semantics, not
 * JavaScript's, and each has a failure mode that shows a user duplicated or
 * missing sessions with no error anywhere:
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
 * And the trace that carries the tool calls is built in the shape a REAL
 * EXPORTING INSTALL emits, copied span for span off a live database: an
 * enclosing `workflow.execute turnWorkflow` / `step.execute turnStep` pair
 * carrying `workflow.run.id`, an `invoke_agent` span declaring the ordinal
 * alias `turn_0`, and the `chat` and `execute_tool` children carrying nothing
 * at all. That shape is the bug. A fixture that declares `agent.turn.id =
 * wrun_…` on the root — which is what the old one did — is the shape only a
 * NON-exporting install produces, and it is why this probe could not see the
 * outage. Both shapes are fixtured now, and one assertion checks that the
 * translated one really did have to be translated.
 *
 * ─ 3. The shipped index file applies, and its predicate is one Postgres can
 *      actually prove ─
 *
 * `packages/dashboard/sql/query-indexes.sql` is executed by exactly one thing:
 * `ensureQueryIndexes()`, at runtime, which warns once and swallows every
 * failure by design. So a typo in that file costs every page its indexes and
 * says so nowhere a human will look. This probe is the thing that reads it —
 * run for real, at its real schema names, so a broken statement is a red check
 * with the Postgres error in it. The old note here said "rewriting the schema
 * names is the one thing this cannot see"; the fixture database is what closed
 * that, since nothing is rewritten any more.
 *
 * The predicate half: the file uses `WHERE (attributes->>'$eve.root') IS NOT
 * NULL` rather than `WHERE attributes ? '$eve.root'`. The two select identical
 * rows; only the first is implied by the query's own `= $1`, so only the first
 * is ever used. Measured, the `?` form built fine, was never chosen, and left
 * the LATERAL a sequential scan while still costing every insert. That is a
 * trap worth a permanent assertion, because both indexes look equally healthy
 * in `\d`.
 *
 * ── What this probe writes ───────────────────────────────────────────────────
 *
 * Everything it fixtures goes into a database it creates and drops. It does
 * touch the CONFIGURED database in one way, before any of that: it awaits
 * `ensureTraceSchema()` and `ensureQueryIndexes()` there first. Those two cache
 * a resolved promise per process, and every later probe in this tier shares the
 * process — so warming them against the real database is what stops this probe
 * leaving 07 and 08 with a bootstrap that "already ran" against a database that
 * no longer exists. Both are what a booted dashboard does to that same
 * database on its first page render: create `evestack.spans`, and add the
 * `evestack_`-prefixed expression indexes that sql/query-indexes.sql argues for
 * in its own header.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../../lib/repo.mjs";
import {
  WORKFLOW_RUNS_DDL,
  createFixtureDatabase,
  fixtureDatabaseUnavailable,
} from "../lib/fixture-db.mjs";

const DASHBOARD = join(REPO_ROOT, "packages/dashboard");

/** Exactly the sort key a real database produces for a tied pair. */
const TIED_AT = "2026-08-06 11:56:37.310418";

/** The DDL the dashboard applies at boot, and that nothing else ever runs. */
const INDEX_FILE = "packages/dashboard/sql/query-indexes.sql";
/** The table definition, the ancestry resolver and the trigger that keeps
 *  `resolved_turn_id` current. Applied here so the fixture database is the same
 *  shape the ingest route would have made it. */
const TRACE_FILE = "packages/dashboard/sql/traces.sql";

const SESSION = "wrun_sess_a";
const OTHER_SESSION = "wrun_sess_b";

async function connect(connectionString) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}

export default {
  id: "queries/session-keyset-and-tool-calls",
  title: "the shipped session list pages without skipping or repeating, and tool calls are counted or absent",
  needs: ["postgres"],
  why:
    "Both failures here are silent. A cursor rounded to milliseconds re-serves the row it came " +
    "from, so a client paging to the end loops; a tie in created_at with no id tiebreak lets an " +
    "OFFSET boundary skip one session and show another twice. And a turn whose trace was never " +
    "exported has no evidence about tool calls at all — reporting 0 there is a confident claim " +
    "that the agent used no tools, which is a different statement from 'we do not know'. The " +
    "queries are the shipped ones: the previous version of this probe restated them, and stayed " +
    "green through the outage that blanked every session page.",

  available: fixtureDatabaseUnavailable,

  async run(t) {
    const cwd = process.cwd();
    const ambient = process.env.WORKFLOW_POSTGRES_URL;
    // lib/traces.ts and lib/queries.ts read their DDL relative to the working
    // directory, which is how the dashboard runs. Same move as probes 07 and 08.
    process.chdir(DASHBOARD);
    await import(join(DASHBOARD, "test/register-ts-resolve.mjs"));
    const db = await import(join(DASHBOARD, "lib/db.ts"));
    const traces = await import(join(DASHBOARD, "lib/traces.ts"));
    const queries = await import(join(DASHBOARD, "lib/queries.ts"));

    // Warm both once-per-process bootstraps against the CONFIGURED database
    // before anything is repointed. See the note at the top of this file.
    await traces.ensureTraceSchema();
    await queries.ensureQueryIndexes();

    const fixture = await createFixtureDatabase("session-keyset");
    let client = null;
    try {
      client = await connect(fixture.url);
      await client.query(WORKFLOW_RUNS_DDL);

      const addSession = (id, at) =>
        client.query(
          `INSERT INTO workflow.workflow_runs (id, status, created_at, attributes)
           VALUES ($1, 'running', $2::timestamp, '{"$eve.type":"session"}'::jsonb)`,
          [id, at],
        );
      const addTurn = (id, sessionId, at) =>
        client.query(
          `INSERT INTO workflow.workflow_runs (id, status, created_at, started_at, completed_at, attributes)
           VALUES ($1, 'completed', $2::timestamp, $2::timestamp, $2::timestamp,
                   jsonb_build_object('$eve.type','turn','$eve.root',$3::text,'$eve.parent',$3::text))`,
          [id, at, sessionId],
        );

      /* ---------------------------------------------------------------- */
      /* 1. paging, through the shipped listSessions                       */
      /* ---------------------------------------------------------------- */

      // Three sessions tied on created_at to the microsecond, plus one older.
      // Ties are the case the id tiebreak exists for.
      await addSession("wrun_tie_c", TIED_AT);
      await addSession("wrun_tie_b", TIED_AT);
      await addSession("wrun_tie_a", TIED_AT);
      await addSession("wrun_older", "2026-08-06 09:00:00.000001");
      await addSession(SESSION, "2026-08-06 11:56:36.000000");
      await addSession(OTHER_SESSION, "2026-08-06 08:00:00.000000");

      await addTurn("wrun_turn_tools", SESSION, "2026-08-06 11:56:38.000000");
      await addTurn("wrun_turn_notools", SESSION, "2026-08-06 11:56:39.000000");
      await addTurn("wrun_turn_notrace", SESSION, "2026-08-06 11:56:40.000000");
      await addTurn("wrun_turn_shared_a", SESSION, "2026-08-06 11:56:41.000000");
      await addTurn("wrun_turn_shared_b", SESSION, "2026-08-06 11:56:42.000000");
      await addTurn("wrun_turn_crossed", SESSION, "2026-08-06 11:56:43.000000");
      await addTurn("wrun_turn_elsewhere", OTHER_SESSION, "2026-08-06 08:00:01.000000");

      // Bulk so the planner has a reason to prefer an index at all.
      await client.query(`
        INSERT INTO workflow.workflow_runs (id, status, created_at, attributes)
        SELECT 'wrun_bulk_' || g, 'completed',
               timestamp '2026-01-01 00:00:00' + (g || ' seconds')::interval,
               jsonb_build_object('$eve.type','turn','$eve.root','wrun_tie_a','$eve.parent','wrun_tie_a')
          FROM generate_series(1, 20000) g
      `);
      await client.query(`ANALYZE workflow.workflow_runs`);

      /* ---------------------------------------------------------------- */
      /* 2. the shipped index file, and the plans it is supposed to buy    */
      /* ---------------------------------------------------------------- */

      const explain = async (sql, params = []) =>
        (await client.query(`EXPLAIN ${sql}`, params)).rows.map((r) => r["QUERY PLAN"]).join("\n");

      const rootLookup =
        `SELECT id FROM workflow.workflow_runs WHERE attributes->>'$eve.root' = 'wrun_tie_a'`;

      // The negative control runs FIRST, and alone. Once the shipped
      // `IS NOT NULL` index exists the planner has a usable index either way,
      // and "the `?` index was not chosen" stops meaning anything.
      await client.query(`
        CREATE INDEX probe_root_jsonb_exists_idx ON workflow.workflow_runs ((attributes->>'$eve.root'))
          WHERE attributes ? '$eve.root'
      `);
      await client.query(`ANALYZE workflow.workflow_runs`);
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
      await client.query(`DROP INDEX workflow.probe_root_jsonb_exists_idx`);

      // Now the file itself, rather than a hand-copy of it, and at its real
      // schema names rather than a rewrite of them. Two things follow: a typo
      // is a red check here instead of a once-per-process console.warn nobody
      // reads, and a statement pointed at the wrong schema — the one thing the
      // scratch-schema version of this probe structurally could not see — now
      // fails here.
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
        await client.query(indexSql);
      } catch (error) {
        applyError = error;
      }
      t.ok(
        applyError === null,
        `${INDEX_FILE} applies cleanly at its own schema names — the only place anything but a live dashboard runs it`,
        applyError === null
          ? {}
          : {
              expected: "every statement to succeed",
              actual: `${applyError.message}\n— ensureQueryIndexes() would have warned once and swallowed this, leaving every page un-indexed`,
            },
      );

      // sql/traces.sql, unmodified: the spans table, the ancestry resolver and
      // the trigger. The resolver is part of what section 3 asserts, so it has
      // to be the shipped one.
      let traceSchemaError = null;
      try {
        await client.query(readFileSync(join(REPO_ROOT, TRACE_FILE), "utf8"));
      } catch (error) {
        traceSchemaError = error;
      }
      t.ok(
        traceSchemaError === null,
        `${TRACE_FILE} applies cleanly on a database that has never held a span`,
        traceSchemaError === null ? {} : { actual: traceSchemaError.message },
      );
      await client.query(`ANALYZE workflow.workflow_runs`);

      const keysetPlan = await explain(
        `SELECT id FROM workflow.workflow_runs s
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
      /* 3. spans, in the shape a real exporting install emits             */
      /* ---------------------------------------------------------------- */

      let nano = 1_760_000_000_000_000_000n;
      const addSpan = (traceId, spanId, parentSpanId, name, attributes = {}) => {
        nano += 1_000_000n;
        return client.query(
          `INSERT INTO evestack.spans
             (trace_id, span_id, parent_span_id, name, start_unix_nano, start_time, attributes)
           VALUES ($1, $2, $3, $4, $5::bigint, to_timestamp($5::bigint / 1e9), $6::jsonb)`,
          [traceId, spanId, parentSpanId, name, nano.toString(), JSON.stringify(attributes)],
        );
      };

      // ── trace_tools: the exporting shape, span for span. ──
      //
      // Nothing here declares the turn as a run id. The alias `turn_0` is on
      // `invoke_agent`, the run id is on the two workflow spans above it, and
      // the tool spans carry neither — which is what a collector receives once
      // agent/instrumentation.ts disables eve's local `agent.*` tracer.
      const RUN_ATTR = { "workflow.run.id": "wrun_turn_tools" };
      const ALIAS_ATTR = {
        "ai.settings.context.eve.session.id": SESSION,
        "ai.settings.context.eve.turn.id": "turn_0",
      };
      await addSpan("trace_tools", "wf000000", null, "workflow.execute turnWorkflow", RUN_ATTR);
      await addSpan("trace_tools", "st000000", "wf000000", "step.execute turnStep", RUN_ATTR);
      await addSpan("trace_tools", "iv000000", "st000000", "invoke_agent qwen3", ALIAS_ATTR);
      await addSpan("trace_tools", "s1000000", "iv000000", "step 1");
      await addSpan("trace_tools", "ch000000", "s1000000", "chat qwen3");
      await addSpan("trace_tools", "tl000001", "s1000000", "execute_tool bash");
      await addSpan("trace_tools", "tl000002", "s1000000", "execute_tool read_file");
      await addSpan("trace_tools", "tl000003", "s1000000", "execute_tool bash");
      // `_` is a LIKE wildcard. Unescaped, this span would be counted as a
      // fourth tool call.
      await addSpan("trace_tools", "dc000000", "s1000000", "executeXtool decoy");

      // ── trace_notools: the NON-exporting shape, where the local tracer put
      //    a real run id on the span itself. The resolver must leave it alone.
      await addSpan("trace_notools", "nt000000", null, "ai.eve.turn", {
        "agent.turn.id": "wrun_turn_notools",
        "agent.session.id": SESSION,
      });
      await addSpan("trace_notools", "nt000001", "nt000000", "chat qwen3");

      // ── wrun_turn_notrace has no spans at all. That is the fixture.

      // ── trace_shared: one trace, two turns of the SAME session. Cannot say
      //    which one called the tool.
      await addSpan("trace_shared", "sh000000", null, "ai.eve.turn", {
        "agent.turn.id": "wrun_turn_shared_a",
      });
      await addSpan("trace_shared", "sh000001", null, "ai.eve.turn", {
        "agent.turn.id": "wrun_turn_shared_b",
      });
      await addSpan("trace_shared", "sh000002", "sh000000", "execute_tool bash");

      // ── trace_crossed: the same ambiguity reaching OUTSIDE the session being
      //    rendered — one turn here, one turn in a session this query never
      //    selects. A session-scoped guard cannot see it: filter the spans to
      //    this session's runs before counting distinct turn ids and the second
      //    turn vanishes, the trace looks unambiguous, and its tool call is
      //    charged to whichever turn happens to be ours.
      await addSpan("trace_crossed", "cr000000", null, "ai.eve.turn", {
        "agent.turn.id": "wrun_turn_crossed",
      });
      await addSpan("trace_crossed", "cr000001", null, "ai.eve.turn", {
        "agent.turn.id": "wrun_turn_elsewhere",
      });
      await addSpan("trace_crossed", "cr000002", "cr000000", "execute_tool bash");
      await client.query(`ANALYZE evestack.spans`);

      // The fixture only means what it is supposed to mean if the translation
      // really happened. Declared `turn_0`, resolved to a run id: that is the
      // whole of the bug this probe missed, stated as a precondition rather
      // than assumed.
      const { rows: translated } = await client.query(
        `SELECT span_id, turn_id, resolved_turn_id FROM evestack.spans
          WHERE span_id IN ('iv000000', 'tl000001') ORDER BY span_id`,
      );
      const byId = new Map(translated.map((r) => [r.span_id, r]));
      const declaring = byId.get("iv000000");
      const tool = byId.get("tl000001");
      const wasTranslated =
        declaring?.turn_id === "turn_0" &&
        declaring?.resolved_turn_id === "wrun_turn_tools" &&
        tool?.turn_id === null &&
        tool?.resolved_turn_id === "wrun_turn_tools";
      t.ok(
        wasTranslated,
        "the declared turn id is the ordinal alias, and both it and the untagged tool span resolve to the run they executed inside",
        wasTranslated
          ? {}
          : {
              expected:
                "invoke_agent: turn_0 -> wrun_turn_tools; execute_tool: null -> wrun_turn_tools",
              actual:
                `invoke_agent: ${declaring?.turn_id} -> ${declaring?.resolved_turn_id}; ` +
                `execute_tool: ${tool?.turn_id} -> ${tool?.resolved_turn_id} — without the ` +
                `translation every assertion below is about the easy shape only`,
            },
      );

      /* ---------------------------------------------------------------- */
      /* 4. now run the SHIPPED queries against it                         */
      /* ---------------------------------------------------------------- */

      // closePool() rather than getPool().end(): the pool is a module global,
      // and ending it without forgetting it hands the next caller a corpse.
      await db.closePool();
      process.env.WORKFLOW_POSTGRES_URL = fixture.url;

      const seen = [];
      let cursor = null;
      for (let guard = 0; guard < 10; guard += 1) {
        const page = await queries.listSessions(2, cursor);
        if (page.length === 0) break;
        seen.push(...page.map((r) => r.id));
        if (page.length < 2) break;
        cursor = queries.parseSessionCursor(page[page.length - 1].cursor);
      }

      const expectedOrder = [
        "wrun_tie_c",
        "wrun_tie_b",
        "wrun_tie_a",
        SESSION,
        "wrun_older",
        OTHER_SESSION,
      ];
      const partitions = seen.join(",") === expectedOrder.join(",");
      t.ok(
        partitions,
        "a keyset walk through listSessions over rows tied on created_at visits each session exactly once",
        partitions ? {} : { expected: expectedOrder.join(", "), actual: seen.join(", ") || "nothing" },
      );

      // The rounding trap, in the direction it actually bites. `toISOString`
      // TRUNCATES microseconds, and the walk is DESC with `<`, so a rounded
      // cursor is strictly smaller than the row it came from and therefore
      // excludes MORE than it should. The lost rows are the ones sharing the
      // cursor's millisecond and sorting below it: they are never served on any
      // page and no error is raised. (Repeats would be the ASC failure mode;
      // this list is DESC, so it silently loses sessions instead.)
      const exactIds = (
        await queries.listSessions(5, { createdAt: "2026-08-06T11:56:37.310418", id: "wrun_tie_b" })
      ).map((r) => r.id);
      const roundedIds = (
        await queries.listSessions(5, { createdAt: "2026-08-06T11:56:37.310", id: "wrun_tie_b" })
      ).map((r) => r.id);

      const exactIsComplete = exactIds[0] === "wrun_tie_a";
      t.ok(
        exactIsComplete,
        "the exact cursor excludes the row it came from and everything above it, and nothing else",
        exactIsComplete ? {} : { expected: "wrun_tie_a first", actual: exactIds.join(", ") || "nothing" },
      );

      const roundingSkips = !roundedIds.includes("wrun_tie_a") && exactIds.includes("wrun_tie_a");
      t.ok(
        roundingSkips,
        "a millisecond-rounded cursor silently drops a session, which is why the cursor carries to_char(...US)",
        roundingSkips
          ? {}
          : {
              expected: "the rounded cursor to LOSE wrun_tie_a that the exact cursor returns",
              actual: `exact -> [${exactIds}], rounded -> [${roundedIds}] — if these agree the fixture lost its microseconds and the assertion is vacuous`,
            },
      );

      // The cursor the product hands out has to be the one that works. It is
      // built from `to_char(created_at, ...US)`, and a client that round-trips
      // it must land on the exact boundary rather than the rounded one.
      const firstPage = await queries.listSessions(3, null);
      const roundTripped = queries.parseSessionCursor(firstPage[firstPage.length - 1].cursor);
      const carriesMicroseconds = /\.\d{6}$/.test(roundTripped.createdAt);
      t.ok(
        carriesMicroseconds,
        "the cursor listSessions emits carries all six digits, not a JS ISO string",
        carriesMicroseconds ? { actual: roundTripped.createdAt } : { actual: roundTripped.createdAt },
      );

      const tree = await queries.getSessionTree(SESSION);
      const got = new Map(tree.map((row) => [row.id, row.toolInvocations]));

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
        decoyCounted ? { expected: 3, actual: "4 — the LIKE pattern is treating `_` as a wildcard" } : {},
      );

      // `toTurnRow` is the JavaScript half of the same rule, and the seam that
      // makes it reachable is only worth anything if the SQL half really can
      // produce a null. Asserted here rather than inferred from the map above,
      // because `NUM` in place of `NUM_OR_NULL` would turn every unknown into a
      // confident zero and the six cases would still all read as numbers.
      const unknownTurns = tree.filter(
        (row) => row.type === "turn" && row.toolInvocations === null,
      ).length;
      t.ok(
        unknownTurns === 4,
        "getSessionTree returns null — not 0 — for every turn nothing recorded a tool count for",
        unknownTurns === 4 ? {} : { expected: 4, actual: unknownTurns },
      );
      // The session row itself is in the tree (the query matches `id = $1` as
      // well as its children) and has no tool count either. Named so that a
      // future reader does not "fix" the four above into five.
      const sessionRow = tree.find((row) => row.id === SESSION);
      t.ok(
        sessionRow !== undefined && sessionRow.toolInvocations === null,
        "the session row itself is returned, and carries no tool count of its own",
        sessionRow === undefined
          ? { expected: SESSION, actual: "the session row is missing from its own tree" }
          : { actual: String(sessionRow.toolInvocations) },
      );
    } finally {
      await db.closePool().catch(() => {});
      if (ambient === undefined) delete process.env.WORKFLOW_POSTGRES_URL;
      else process.env.WORKFLOW_POSTGRES_URL = ambient;
      await client?.end().catch(() => {});
      const leaked = await fixture.dispose();
      if (leaked) t.note(leaked);
      process.chdir(cwd);
    }
  },
};
