/**
 * The spans a reader came for must resolve to a session, and the migration that
 * makes them resolve must actually run on a database that already exists.
 *
 * ── Why this is a probe and not a unit test ──────────────────────────────────
 *
 * `chat <model>` and `execute_tool <name>` — the only two span families the
 * dashboard aggregates — carry no session id, no turn id and no
 * `workflow.run.id`. Their parents carry all three. A `GENERATED ALWAYS AS`
 * column cannot express that, because it can only read its own row, so the
 * inheritance is materialized by a recursive walk and kept current by triggers
 * on the table. Recursive CTEs, transition tables, trigger re-entry and
 * `ON CONFLICT DO UPDATE` are PostgreSQL semantics; asserting them in JavaScript
 * would only assert a restatement of them.
 *
 * ── The four things that go wrong ────────────────────────────────────────────
 *
 * 1. A child ingested BEFORE its parent. OTLP batches arrive unordered, and the
 *    naive version resolves it once, to NULL, forever.
 * 2. A parent that never arrives. It must stay NULL, not inherit from whichever
 *    session happens to be nearby — "missing is not zero" applies to ids too.
 * 3. A cyclic parent chain. Every statement here runs under a statement_timeout
 *    so a walk that does not terminate fails this probe instead of hanging it.
 * 4. Engine noise. 92.6% of a live spans table is `workflow.stream.read.complete`
 *    carrying `workflow.run.id = wrun_00000000000000000000000000`, a placeholder
 *    that joins to nothing. Folding that key into the session id would report
 *    97% attribution while attributing zero model calls, which is the mistake
 *    this whole design exists to avoid. The probe pins that it resolves to no
 *    session.
 *
 * ── And the trap ─────────────────────────────────────────────────────────────
 *
 * sql/traces.sql used to gate its migration on `session_id`'s generated
 * expression NOT containing a string that the very next edit would keep. That
 * guard is false on every database that has already been migrated, so anything
 * added inside it is silently inert in production and perfect on a fresh
 * database — the worst possible failure shape. The last section here rebuilds a
 * pre-migration database out of a migrated one and asserts the migration fires,
 * backfills, and is safe to run again.
 *
 * The DDL is not restated below. The probe reads packages/dashboard/sql/traces.sql
 * and applies the real file into a scratch schema, so it cannot go stale.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = join(HERE, "../../../packages/dashboard/sql/traces.sql");

/** The all-zero run id the workflow engine stamps on stream-read spans. */
const PLACEHOLDER_RUN_ID = "wrun_00000000000000000000000000";

async function connect() {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.WORKFLOW_POSTGRES_URL });
  await client.connect();
  // A recursive walk that fails to terminate must fail, not hang.
  await client.query("SET statement_timeout = '20s'");
  return client;
}

/**
 * The real schema file, retargeted at a scratch schema.
 *
 * Every object in it is written `evestack.<name>`, including the
 * `'evestack.spans'::regclass` lookup inside the migration, so one substitution
 * relocates the whole file. Index and trigger names live in the table's schema,
 * so they cannot collide with the real ones.
 */
function schemaSql(schema) {
  const raw = readFileSync(SCHEMA_SQL, "utf8");
  return raw
    .replace("CREATE SCHEMA IF NOT EXISTS evestack;", `CREATE SCHEMA IF NOT EXISTS ${schema};`)
    .replaceAll("evestack.", `${schema}.`);
}

/** One span. Ids are hex, as OTLP requires; attributes are already unwrapped. */
function span(overrides) {
  return {
    traceId: "00000000000000000000000000000000",
    spanId: "0000000000000000",
    parentSpanId: null,
    name: "span",
    startNano: 1,
    ageDays: 0,
    attributes: {},
    ...overrides,
  };
}

async function insert(client, schema, rows, { upsert = false } = {}) {
  for (const row of rows) {
    await client.query(
      `INSERT INTO ${schema}.spans
         (trace_id, span_id, parent_span_id, name, start_unix_nano, start_time, attributes)
       VALUES ($1,$2,$3,$4,$5, now() - make_interval(days => $6), $7::jsonb)
       ${
         upsert
           ? `ON CONFLICT (trace_id, span_id) DO UPDATE SET
                parent_span_id = EXCLUDED.parent_span_id,
                attributes     = EXCLUDED.attributes`
           : ""
       }`,
      [
        row.traceId,
        row.spanId,
        row.parentSpanId,
        row.name,
        row.startNano,
        row.ageDays,
        JSON.stringify(row.attributes),
      ],
    );
  }
}

async function resolved(client, schema, spanId) {
  const { rows } = await client.query(
    `SELECT session_id, turn_id, resolved_session_id, resolved_turn_id, workflow_run_id
     FROM ${schema}.spans WHERE span_id = $1`,
    [spanId],
  );
  return rows[0] ?? null;
}

/** The ids eve's AI SDK exporter stamps on the spans that carry any. */
const ids = (session, turn) => ({
  "ai.settings.context.eve.session.id": session,
  "ai.settings.context.eve.turn.id": turn,
});

const TRACE_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TRACE_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TRACE_C = "cccccccccccccccccccccccccccccccc";
const TRACE_D = "dddddddddddddddddddddddddddddddd";
const TRACE_NOISE = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export default {
  id: "traces/spans-resolve-to-a-session",
  title: "model and tool spans inherit the session their parents declare, and the migration that does it runs",
  needs: ["postgres"],
  why:
    "Every SQL aggregation over evestack.spans returned nothing, because the 1,198 model and tool " +
    "spans in a live database declare no session id at all — their parents do. The fix is a " +
    "materialized ancestor walk maintained by triggers, and it has to survive unordered delivery, " +
    "missing parents, cycles and at-least-once replay. The migration that installs it also has to " +
    "run on databases that already exist, which the guard it replaces provably would not.",

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
      await client.query(schemaSql(schema));

      /* ---------------------------------------------------------------- */
      /* the shape a real export has                                       */
      /* ---------------------------------------------------------------- */

      // ai.eve.turn → invoke_agent → step 1 all declare the ids; the two spans
      // underneath declare nothing. Verified across every parent/child pair in a
      // live database, no exceptions.
      await insert(client, schema, [
        span({ traceId: TRACE_A, spanId: "a100000000000000", name: "ai.eve.turn", attributes: ids("sess_a", "turn_a") }),
        span({ traceId: TRACE_A, spanId: "a200000000000000", parentSpanId: "a100000000000000", name: "invoke_agent gpt-5-mini", attributes: ids("sess_a", "turn_a") }),
        span({ traceId: TRACE_A, spanId: "a300000000000000", parentSpanId: "a200000000000000", name: "step 1", attributes: ids("sess_a", "turn_a") }),
        span({ traceId: TRACE_A, spanId: "a400000000000000", parentSpanId: "a300000000000000", name: "chat gpt-5-mini" }),
        span({ traceId: TRACE_A, spanId: "a500000000000000", parentSpanId: "a300000000000000", name: "execute_tool grep" }),
      ]);

      const chat = await resolved(client, schema, "a400000000000000");
      const tool = await resolved(client, schema, "a500000000000000");

      // Both halves matter. If `session_id` were quietly widened to make this
      // pass, the "declared on this row" column would stop meaning that.
      t.ok(
        chat.session_id === null && tool.session_id === null,
        "the declared session_id on a chat/execute_tool span stays NULL — it really is not on the row",
        chat.session_id === null && tool.session_id === null
          ? {}
          : { actual: `chat=${chat.session_id} tool=${tool.session_id}` },
      );
      t.ok(
        chat.resolved_session_id === "sess_a" && chat.resolved_turn_id === "turn_a",
        "a `chat <model>` span resolves to the session and turn its ancestors declare",
        { actual: `session=${chat.resolved_session_id} turn=${chat.resolved_turn_id}` },
      );
      t.ok(
        tool.resolved_session_id === "sess_a" && tool.resolved_turn_id === "turn_a",
        "an `execute_tool <name>` span resolves to the session and turn its ancestors declare",
        { actual: `session=${tool.resolved_session_id} turn=${tool.resolved_turn_id}` },
      );

      // The point of materializing it: SQL can now group by session.
      const { rows: grouped } = await client.query(
        `SELECT count(*) AS n FROM ${schema}.spans
         WHERE resolved_session_id = 'sess_a'
           AND (starts_with(name, 'chat ') OR starts_with(name, 'execute_tool '))`,
      );
      t.ok(
        Number(grouped[0].n) === 2,
        "GROUP BY session over model and tool spans returns them, which is the whole point",
        { expected: 2, actual: Number(grouped[0].n) },
      );

      /* ---------------------------------------------------------------- */
      /* 1. the child that arrives first                                   */
      /* ---------------------------------------------------------------- */

      await insert(client, schema, [
        span({ traceId: TRACE_B, spanId: "b200000000000000", parentSpanId: "b100000000000000", name: "chat gpt-5-mini" }),
      ]);
      const orphanForNow = await resolved(client, schema, "b200000000000000");
      t.ok(
        orphanForNow.resolved_session_id === null,
        "a child whose parent has not landed yet resolves to nothing rather than to a guess",
        { actual: orphanForNow.resolved_session_id },
      );

      await insert(client, schema, [
        span({ traceId: TRACE_B, spanId: "b100000000000000", name: "step 1", attributes: ids("sess_b", "turn_b") }),
      ]);
      const reunited = await resolved(client, schema, "b200000000000000");
      t.ok(
        reunited.resolved_session_id === "sess_b" && reunited.resolved_turn_id === "turn_b",
        "the parent arriving in a LATER batch re-resolves the children already stored",
        { expected: "sess_b/turn_b", actual: `${reunited.resolved_session_id}/${reunited.resolved_turn_id}` },
      );

      /* ---------------------------------------------------------------- */
      /* 2. the parent that never arrives                                  */
      /* ---------------------------------------------------------------- */

      await insert(client, schema, [
        span({ traceId: TRACE_C, spanId: "c200000000000000", parentSpanId: "c100000000000000", name: "chat gpt-5-mini" }),
      ]);
      const orphan = await resolved(client, schema, "c200000000000000");
      t.ok(
        orphan.resolved_session_id === null,
        "a span whose parent was never exported stays unattributed instead of joining the nearest session",
        { actual: orphan.resolved_session_id },
      );

      /* ---------------------------------------------------------------- */
      /* 3. the cycle                                                      */
      /* ---------------------------------------------------------------- */

      // Reaching this line at all is most of the assertion: statement_timeout
      // is 20s, and a walk that can enter a cycle never returns.
      await insert(client, schema, [
        span({ traceId: TRACE_D, spanId: "d100000000000000", parentSpanId: "d200000000000000", name: "chat gpt-5-mini" }),
        span({ traceId: TRACE_D, spanId: "d200000000000000", parentSpanId: "d100000000000000", name: "step 1", attributes: ids("sess_d", "turn_d") }),
        span({ traceId: TRACE_D, spanId: "d300000000000000", parentSpanId: "d100000000000000", name: "execute_tool grep" }),
      ]);
      const inCycle = await resolved(client, schema, "d200000000000000");
      const belowCycle = await resolved(client, schema, "d300000000000000");
      t.ok(
        inCycle.resolved_session_id === "sess_d",
        "a span inside a cyclic parent chain keeps what it declares (and the walk terminates)",
        { actual: inCycle.resolved_session_id },
      );
      t.ok(
        belowCycle.resolved_session_id === null,
        "a span hanging off a cycle is unreachable from any root, so it inherits nothing",
        { actual: belowCycle.resolved_session_id },
      );

      /* ---------------------------------------------------------------- */
      /* 4. engine noise                                                   */
      /* ---------------------------------------------------------------- */

      await insert(client, schema, [
        span({
          traceId: TRACE_NOISE,
          spanId: "f100000000000000",
          name: "workflow.stream.read.complete",
          attributes: { "workflow.run.id": PLACEHOLDER_RUN_ID },
        }),
      ]);
      const noise = await resolved(client, schema, "f100000000000000");
      t.ok(
        noise.workflow_run_id === PLACEHOLDER_RUN_ID,
        "workflow.run.id is projected into its own column, placeholder and all",
        { actual: noise.workflow_run_id },
      );
      t.ok(
        noise.resolved_session_id === null,
        "an engine-noise span carrying the all-zero run id belongs to no session — widening session_id " +
          "with workflow.run.id would have attributed 92% of the table to a run that never existed",
        { actual: noise.resolved_session_id },
      );

      /* ---------------------------------------------------------------- */
      /* 5. at-least-once delivery                                         */
      /* ---------------------------------------------------------------- */

      // The identical batch again: an upsert, and nothing may move.
      await insert(
        client,
        schema,
        [span({ traceId: TRACE_A, spanId: "a400000000000000", parentSpanId: "a300000000000000", name: "chat gpt-5-mini" })],
        { upsert: true },
      );
      const replayed = await resolved(client, schema, "a400000000000000");
      t.ok(
        replayed.resolved_session_id === "sess_a",
        "replaying a batch leaves the resolution alone",
        { actual: replayed.resolved_session_id },
      );

      // The parent re-sent with different ids: the children must follow, or the
      // resolved columns are a cache nobody invalidates.
      await insert(
        client,
        schema,
        [span({ traceId: TRACE_A, spanId: "a300000000000000", parentSpanId: "a200000000000000", name: "step 1", attributes: ids("sess_a2", "turn_a2") })],
        { upsert: true },
      );
      const followed = await resolved(client, schema, "a400000000000000");
      t.ok(
        followed.resolved_session_id === "sess_a2" && followed.resolved_turn_id === "turn_a2",
        "an UPDATE to a parent's ids re-resolves its descendants",
        { expected: "sess_a2/turn_a2", actual: `${followed.resolved_session_id}/${followed.resolved_turn_id}` },
      );

      /* ---------------------------------------------------------------- */
      /* 6. retention                                                      */
      /* ---------------------------------------------------------------- */

      await insert(client, schema, [
        span({ traceId: TRACE_A, spanId: "a900000000000000", name: "chat gpt-5-mini", ageDays: 90 }),
      ]);
      const { rows: off } = await client.query(`SELECT ${schema}.prune_spans(NULL) AS n`);
      t.ok(
        Number(off[0].n) === 0,
        "retention off deletes nothing — an unbounded table has to be a choice someone made",
        { actual: Number(off[0].n) },
      );

      const before = await client.query(`SELECT count(*)::int AS n FROM ${schema}.spans`);
      const { rows: pruned } = await client.query(
        `SELECT ${schema}.prune_spans(make_interval(days => 30)) AS n`,
      );
      const after = await client.query(`SELECT count(*)::int AS n FROM ${schema}.spans`);
      t.ok(
        Number(pruned[0].n) === 1 && after.rows[0].n === before.rows[0].n - 1,
        "a 30-day window removes the 90-day-old span and only that one",
        { expected: "1 deleted", actual: `${pruned[0].n} deleted, ${before.rows[0].n} → ${after.rows[0].n} rows` },
      );

      /* ---------------------------------------------------------------- */
      /* 7. the trap: does the migration run on a database that exists?    */
      /* ---------------------------------------------------------------- */

      // Rebuild a pre-migration database out of this one. This is exactly the
      // state of every deployed evestack: table present, rows present, the new
      // columns absent.
      await client.query(`
        ALTER TABLE ${schema}.spans
          DROP COLUMN resolved_session_id,
          DROP COLUMN resolved_turn_id,
          DROP COLUMN workflow_run_id;
        DELETE FROM ${schema}.schema_version WHERE component = 'spans';
      `);

      await client.query(schemaSql(schema));

      const { rows: version } = await client.query(
        `SELECT version FROM ${schema}.schema_version WHERE component = 'spans'`,
      );
      t.ok(
        Number(version[0]?.version) === 2,
        "re-applying the file to a database that predates the migration records the new schema version",
        { actual: version[0]?.version },
      );

      const backfilled = await resolved(client, schema, "a400000000000000");
      t.ok(
        backfilled.resolved_session_id === "sess_a2",
        "…and backfills the rows that were already there. A guard that reads the change it guards " +
          "cannot do this: it is false on every database that already has the change",
        { expected: "sess_a2", actual: backfilled.resolved_session_id },
      );

      // Third application. Idempotence is not optional: this file runs on every boot.
      await client.query(schemaSql(schema));
      const again = await resolved(client, schema, "a400000000000000");
      const { rows: stillTwo } = await client.query(
        `SELECT count(*)::int AS n FROM ${schema}.schema_version WHERE component = 'spans' AND version = 2`,
      );
      t.ok(
        again.resolved_session_id === "sess_a2" && stillTwo[0].n === 1,
        "applying the file a third time changes nothing",
        { actual: `${again.resolved_session_id}, ${stillTwo[0].n} version rows` },
      );
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
      await client.end();
    }
  },
};
