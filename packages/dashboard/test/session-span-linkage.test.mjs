/**
 * One session must not read three different ways.
 *
 * The defect this pins, in full: a session with twelve spans, two model calls
 * and one tool call rendered on the trace page as a complete waterfall with the
 * tool's arguments and its result, and on the session page as "No spans on any
 * of the 1 runs", "TOOLS OFFERED / CALLED 14 / -" and "No transcript for this
 * turn". Nothing was missing and nothing errored. The two pages joined spans to
 * turns on two different keys.
 *
 * eve's AI SDK exporter stamps `ai.settings.context.eve.turn.id = turn_0`: an
 * ordinal within the session, not a run id, and the SAME string on every turn
 * of every session in the database. The session page keys its turn card on the
 * turn's workflow run id. The two never met, so every span-derived number on
 * that page read "unknown" while the data sat one click away.
 */

/*
 * Where each half of the fix is proven:
 *
 *   SQL   `evestack.resolve_span_ancestry()` translates the alias into the run
 *         the span executed inside, from the enclosing `workflow.run.id`. That
 *         is PostgreSQL semantics - a recursive walk kept current by statement
 *         triggers - and is asserted against a real server by the span
 *         attribution probe under contract/runtime.
 *   HERE  the JavaScript half. `listModelCalls` and `listToolCalls` must return
 *         the run id as `turnId`, because the session page groups them into
 *         `modelCallsByTurn` and reads that map back by `run.id`. Using
 *         `span.turnId` - the declared value, right there on the row and the
 *         obvious-looking field - files every call under `turn_0` and rebuilds
 *         the whole defect with no error anywhere.
 *
 * The fixture rows are copied out of the reproduction database, keys and all,
 * so "the exporter does not send a run id" cannot quietly stop being true.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { installStubPool, uninstallStubPool } from "./stub-pool.mjs";

const { insertSpans, listModelCalls, listToolCalls } = await import(
  new URL("../lib/traces.ts", import.meta.url).href
);

const SESSION = "wrun_01KZMZMV6C5QRYHBMBPVPE7Q05";
/** The turn's workflow run. This is the id the session page has in hand. */
const TURN_RUN = "wrun_01KZMZMVCNDMRM3XFZE1TCVQHF";
/** What the exporter actually declares on the span. Not a run id. */
const TURN_ALIAS = "turn_0";
const TRACE = "312033c2d613520aa3ea820a34c258d2";
const SPAN_READ = /FROM evestack[.]spans/;

/**
 * A row shaped the way `SELECT_SPAN` returns one.
 *
 * `turn_id` is the declared column and `resolved_turn_id` is the walk's
 * answer, and the point of the fixture is that on a real export they differ.
 */
function row(overrides) {
  const base = {
    trace_id: TRACE,
    span_id: "0000000000000000",
    parent_span_id: null,
    name: "span",
    kind: 1,
    start_time: "2026-08-10T04:42:21.864Z",
    end_time: "2026-08-10T04:42:22.196Z",
    duration_ms: 332,
    status_code: 1,
    status_message: null,
    attributes: {},
    resource: {},
    events: [],
    scope_name: null,
    session_id: null,
    root_session_id: null,
    turn_id: null,
    resolved_turn_id: TURN_RUN,
  };
  return Object.assign(base, overrides);
}

// The chain a real turn exports, with the ids exactly where eve puts them.
const EXPORTED_TURN = [
  row({
    span_id: "a29809b92c974170",
    name: "invoke_agent qwen3",
    session_id: SESSION,
    turn_id: TURN_ALIAS,
    attributes: {
      "ai.settings.context.eve.session.id": SESSION,
      "ai.settings.context.eve.turn.id": TURN_ALIAS,
      "gen_ai.request.model": "qwen3",
      "gen_ai.usage.input_tokens": 3167,
      "gen_ai.usage.output_tokens": 234,
    },
  }),
  row({
    span_id: "af051e3aeb3d38ea",
    parent_span_id: "a29809b92c974170",
    name: "step 1",
    session_id: SESSION,
    turn_id: TURN_ALIAS,
    attributes: {
      "ai.settings.context.eve.session.id": SESSION,
      "ai.settings.context.eve.turn.id": TURN_ALIAS,
    },
  }),
  // The two families the dashboard aggregates. They declare nothing at all -
  // that is the shape sql/traces.sql exists for, and it is why turn_id is NULL
  // on them while resolved_turn_id is filled.
  row({
    span_id: "06d21dccbfefb573",
    parent_span_id: "af051e3aeb3d38ea",
    name: "chat qwen3",
    attributes: { "gen_ai.request.model": "qwen3" },
  }),
  row({
    span_id: "01b4ef97ed24e0f0",
    parent_span_id: "af051e3aeb3d38ea",
    name: "execute_tool remember",
    attributes: {
      "gen_ai.tool.name": "remember",
      "gen_ai.tool.call.arguments": JSON.stringify({ content: "quokka-orbit-9", tags: [] }),
      "gen_ai.tool.call.result": JSON.stringify({ saved: true, id: 1 }),
    },
  }),
];

test("a tool call is keyed on the turn's run id, which is the id the session page holds", async (t) => {
  installStubPool([[SPAN_READ, EXPORTED_TURN]]);
  t.after(uninstallStubPool);

  const [call] = await listToolCalls(SESSION);

  assert.equal(call.name, "remember");
  assert.equal(
    call.turnId,
    TURN_RUN,
    "returning the declared turn_0 here is the whole defect: the session page " +
      "groups these by turnId and reads them back by run id, so its turn pane " +
      "renders empty and says the spans were never exported",
  );
  // The payloads are what the session page was refusing to show. Asserting the
  // key alone would pass on a call carrying no transcript to find.
  assert.equal(call.argumentsJson, JSON.stringify({ content: "quokka-orbit-9", tags: [] }));
  assert.equal(call.resultJson, JSON.stringify({ saved: true, id: 1 }));
});

test("model calls are keyed the same way, so the transcript lands on the same turn", async (t) => {
  installStubPool([[SPAN_READ, EXPORTED_TURN]]);
  t.after(uninstallStubPool);

  const calls = await listModelCalls(SESSION);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].turnId, TURN_RUN);
});

// The session page does exactly this - see modelCallsByTurn in its load() -
// and then reads the map back with selected.run.id.
function byTurn(calls) {
  const map = new Map();
  for (const call of calls) {
    if (!call.turnId) continue;
    map.set(call.turnId, [...(map.get(call.turnId) ?? []), call]);
  }
  return map;
}

test("what the trace page counts for a turn is what the session page can group for it", async (t) => {
  installStubPool([[SPAN_READ, EXPORTED_TURN]]);
  t.after(uninstallStubPool);

  // The trace page renders toolCalls.length for the whole session.
  const [toolCalls, modelCalls] = await Promise.all([
    listToolCalls(SESSION),
    listModelCalls(SESSION),
  ]);

  assert.equal(
    byTurn(toolCalls).get(TURN_RUN)?.length ?? 0,
    toolCalls.length,
    "every tool call the trace page counts has to be reachable from the run id " +
      "the session page selects on - one page reporting 1 and the other nothing " +
      "is the bug, and neither page errors when it happens",
  );
  assert.equal(byTurn(modelCalls).get(TURN_RUN)?.length ?? 0, modelCalls.length);
});

test("an unresolved span still groups by what it declared, rather than by nothing", async (t) => {
  // The two cases resolve_span_ancestry() deliberately leaves alone: a parent
  // that never arrived, and a trace carrying no enclosing workflow.run.id.
  // Falling back to the declared id keeps the session's own spans together;
  // returning null would drop them out of every group and rebuild the empty
  // pane from the other direction.
  const orphan = row({
    span_id: "b100000000000000",
    name: "execute_tool remember",
    turn_id: TURN_ALIAS,
    resolved_turn_id: null,
    attributes: { "gen_ai.tool.name": "remember" },
  });
  installStubPool([[SPAN_READ, [orphan]]]);
  t.after(uninstallStubPool);

  const [call] = await listToolCalls(SESSION);
  assert.equal(call.turnId, TURN_ALIAS);
});

test("the span read asks for resolved_turn_id, or none of the above can be true", async (t) => {
  const pool = installStubPool([[SPAN_READ, EXPORTED_TURN]]);
  t.after(uninstallStubPool);

  await listToolCalls(SESSION);

  // Cheap, and it is the failure that would otherwise be invisible: drop the
  // column from SELECT_SPAN and every row arrives with resolved_turn_id
  // undefined, every call falls back to turn_0, and the fixtures above would
  // have to be wrong in the same direction for anything to notice.
  const reads = pool.matching("FROM evestack.spans");
  assert.ok(reads.length > 0, "listToolCalls did not read the spans table");
  assert.ok(
    reads.some((call) => call.squashed.includes("resolved_turn_id")),
    "no span read selected resolved_turn_id",
  );
});

/*
 * ── THE HALF THAT MAKES THE SQL STAY TRUE ───────────────────────────────────
 *
 * Everything above is about reading the resolved column. This is about it being
 * right to read, which stopped being true the moment the traffic was real.
 *
 * sql/traces.sql keeps `resolved_turn_id` current with an AFTER STATEMENT
 * trigger. A trigger runs inside the statement that fired it, so it only ever
 * sees that statement's snapshot — and spans export when they END, so the leaves
 * of a turn leave before the workflow span carrying the run id they need, and
 * two batches for one trace are routinely in flight at once. Each then resolves
 * a trace the other half of is invisible in, both commit, and the trace is left
 * on the `turn_0` alias with nothing scheduled to look again. Measured on the
 * real path: 40 traces delivered as two overlapping batches left 93 spans across
 * 31 of them stale, and a hand-run resolve changed exactly those 93 rows. That is
 * the defect at the top of this file, back again, from a direction no unit test
 * of the read path can see.
 *
 * So insertSpans finishes the job in its own transaction once the write has
 * committed. contract/runtime/probes/22-concurrent-ingest-resolution.probe.mjs
 * proves that converges against a real server, by delivering forty traces as two
 * overlapping batches each. This pins the cheap half: that the call is made at
 * all, after the writes rather than before them, and scoped to the traces that
 * actually arrived.
 */
test("a stored batch is re-resolved after it commits, because the trigger cannot", async (t) => {
  const pool = installStubPool([]);
  // Retention off, so the fire-and-forget prune cannot outlive the stub pool and
  // go looking for a real Postgres after the test has ended.
  const retention = process.env.EVESTACK_TRACE_RETENTION_DAYS;
  process.env.EVESTACK_TRACE_RETENTION_DAYS = "0";
  t.after(() => {
    uninstallStubPool();
    if (retention === undefined) delete process.env.EVESTACK_TRACE_RETENTION_DAYS;
    else process.env.EVESTACK_TRACE_RETENTION_DAYS = retention;
  });

  const OTHER_TRACE = "9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b";
  const nano = String(BigInt(Date.now()) * 1000000n);
  const ingested = (traceId, spanId) => ({
    traceId,
    spanId,
    parentSpanId: null,
    name: "execute_tool remember",
    kind: 1,
    startUnixNano: nano,
    endUnixNano: nano,
    statusCode: 1,
    statusMessage: null,
    attributes: {},
    resource: {},
    events: [],
    scopeName: null,
    scopeVersion: null,
  });

  await insertSpans([ingested(TRACE, "0000000000000001"), ingested(OTHER_TRACE, "0000000000000002")]);

  const inserted = pool.firstIndexOf("INSERT INTO evestack.spans");
  const resolved = pool.firstIndexOf("evestack.resolve_span_ancestry");
  assert.ok(inserted >= 0, "no INSERT reached the database, so the rest means nothing");
  assert.ok(
    resolved > inserted,
    "insertSpans has to re-resolve AFTER its rows are committed. Before them, or not " +
      "at all, and a trace whose two halves arrived in overlapping batches keeps the " +
      "turn_0 alias for good — which is the session page reporting no spans for a turn " +
      "whose tool call the trace page renders in full",
  );
  assert.deepEqual(
    pool.calls[resolved].params[0],
    [TRACE, OTHER_TRACE],
    "the resolve is scoped to the traces this batch touched, not to the whole table",
  );
});
