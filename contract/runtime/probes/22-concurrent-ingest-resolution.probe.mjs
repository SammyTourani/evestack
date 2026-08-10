/**
 * A trace that arrives as two overlapping batches still names the run it ran in.
 *
 * The fix this guards translates a span's turn alias into the workflow run it
 * executed inside, by inheriting workflow.run.id from the enclosing span. It is
 * right, and it stopped staying right the moment traffic was live: fresh traces
 * kept arriving with resolved_turn_id = turn_0, and one hand-run
 * "SELECT evestack.resolve_span_ancestry();" repaired every one of them. Whoever
 * looked at the function found the correct function. Nothing had been downgraded.
 *
 * The mechanism is the trigger's snapshot. sql/traces.sql keeps the resolved
 * columns current with an AFTER STATEMENT trigger that re-walks the whole trace,
 * which is the right unit of work and does converge for out-of-order arrival —
 * as long as the writes are serialized. A trigger runs inside the statement that
 * fired it, so it can only see that statement's snapshot. Spans export when they
 * END, so leaves leave before the workflow span carrying the run id they need,
 * and two batches for one trace are routinely in flight at once. Each then
 * re-walks a trace the other half of is invisible in: one writes the alias
 * because the enclosing span is not there, the other writes nothing because the
 * children are not there. Both commit. The finished trace on disk is one that no
 * transaction ever saw, and nothing is scheduled to look again.
 *
 * That is invisible to every other check. Every row is present, /traces renders
 * the whole waterfall from them, the resolver is the new one, the schema marker
 * is current — and only the session page, which joins on the run id, goes back to
 * "No spans on any of the 1 runs".
 *
 * So this does not assert that resolution works. It asserts that it works when
 * the batches overlap, which is the only condition under which it stopped. The
 * last assertion is the sharp one: once the dust settles a hand-run resolve must
 * have nothing to change. A resolver that is correct but arrives too late is
 * exactly what this failure looked like from every other angle.
 *
 * It borrows two real workflow_runs ids rather than inventing them, and names its
 * spans outside every span family, so a row that outlived a failed cleanup can
 * neither make probe 19 red nor add a tool call to anybody's session.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DASHBOARD = join(HERE, "../../../packages/dashboard");

/** What an exporting install actually declares. Not a run id, and never was. */
const ALIAS = "turn_0";
/** Every row this writes carries it, and the cleanup deletes on it. */
const MARKER = "span-resolution-survives-concurrent-ingest";
/**
 * Traces to deliver. Measured against the unfixed path, 31 of 40 came out stale,
 * so this is sized to make a false green impossible rather than unlikely: one
 * clean trace proves nothing, forty do.
 */
const TRACES = 40;
/** Spans per trace, and how many of them inherit rather than declare. */
const PER_TRACE = 5;
const INHERITING = 3;

const hex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");

async function connect() {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.WORKFLOW_POSTGRES_URL });
  await client.connect();
  await client.query("SET statement_timeout = '60s'");
  client.on("error", () => {});
  return client;
}

function span(traceId, spanId, parentSpanId, name, attributes) {
  const start = BigInt(Date.now()) * 1000000n;
  const out = {
    traceId,
    spanId,
    parentSpanId,
    name,
    kind: 1,
    startUnixNano: String(start),
    endUnixNano: String(start + 1000000n),
    statusCode: 1,
    statusMessage: null,
    attributes: Object.assign({}, attributes, { "probe.marker": MARKER }),
    resource: {},
    events: [],
    scopeName: "probe",
    scopeVersion: "1",
  };
  return out;
}

export default {
  id: "traces/span-resolution-survives-concurrent-ingest",
  title: "a trace delivered as two overlapping batches still resolves to its run",
  needs: ["postgres", "typescript"],
  why:
    "The session page joins spans to turns on spans.resolved_turn_id, which the ancestry walk " +
    "fills from the enclosing workflow.run.id. The walk is kept current by an AFTER STATEMENT " +
    "trigger, and a trigger only ever sees the snapshot of the statement that fired it — so two " +
    "ingest batches for one trace in flight at once each resolve without the other, both commit, " +
    "and the trace is left holding the turn_0 alias with nothing scheduled to fix it. Every span " +
    "is present and /traces renders them; only /sessions goes blank.",

  async available() {
    if (!process.env.WORKFLOW_POSTGRES_URL) return ["WORKFLOW_POSTGRES_URL is not set"];
    try {
      const client = await connect();
      const { rows } = await client.query(
        "SELECT to_regclass($1)::text AS spans, to_regclass($2)::text AS runs",
        ["evestack.spans", "workflow.workflow_runs"],
      );
      const { rows: runs } = await client.query("SELECT id FROM workflow.workflow_runs ORDER BY id LIMIT 2");
      await client.end();
      if (!rows[0]?.spans) return ["evestack.spans does not exist"];
      if (!rows[0]?.runs) return ["workflow.workflow_runs does not exist"];
      if (runs.length < 2) return ["this database has " + runs.length + " workflow run(s); the probe borrows two real ids"];
      return [];
    } catch (error) {
      return ["cannot reach Postgres: " + error.message];
    }
  },

  async run(t) {
    const cwd = process.cwd();
    process.chdir(DASHBOARD);
    await import(join(DASHBOARD, "test/register-ts-resolve.mjs"));
    const traces = await import(join(DASHBOARD, "lib/traces.ts"));
    const db = await import(join(DASHBOARD, "lib/db.ts"));
    const client = await connect();

    try {
      // Real ids, so a row that outlives the cleanup still satisfies probe 19:
      // every id this can resolve to names a run that exists.
      const { rows: runs } = await client.query("SELECT id FROM workflow.workflow_runs ORDER BY id LIMIT 2");
      const sessionRun = runs[0].id;
      const turnRun = runs[1].id;

      const declared = {
        "ai.settings.context.eve.session.id": sessionRun,
        "ai.settings.context.eve.turn.id": ALIAS,
      };
      const enclosing = { "workflow.run.id": turnRun };

      const traceIds = Array.from({ length: TRACES }, () => hex(32));
      const batches = [];
      for (const traceId of traceIds) {
        // The AI SDK subtree: it declares the alias and no run id at all, which
        // is what every exporting install sends.
        batches.push([
          span(traceId, hex(16), "0000000000000004", "probe.leaf", {}),
          span(traceId, hex(16), "0000000000000004", "probe.leaf", {}),
          span(traceId, "0000000000000004", "0000000000000002", "probe.subtree", declared),
        ]);
        // The workflow spans. They end later, so they export later, and they are
        // the only place the run id is written down.
        batches.push([
          span(traceId, "0000000000000002", "0000000000000001", "probe.enclosing", enclosing),
          span(traceId, "0000000000000001", null, "probe.root", enclosing),
        ]);
      }

      // Started together and awaited together, so the two halves of each trace
      // are in flight at the same time. That is the whole condition under test.
      await Promise.all(batches.map((batch) => traces.insertSpans(batch)));

      const { rows: stored } = await client.query(
        "SELECT count(*)::int AS n FROM evestack.spans WHERE attributes->>$1 = $2",
        ["probe.marker", MARKER],
      );
      t.ok(stored[0].n === TRACES * PER_TRACE, "every span this posted was stored", {
        expected: String(TRACES * PER_TRACE),
        actual: String(stored[0].n),
      });

      const { rows: stale } = await client.query(
        "SELECT count(*)::int AS spans, count(DISTINCT trace_id)::int AS traces" +
          " FROM evestack.spans WHERE attributes->>$1 = $2 AND resolved_turn_id = $3",
        ["probe.marker", MARKER, ALIAS],
      );
      t.ok(stale[0].spans === 0, "no span is left holding the turn alias once both batches have landed", {
        expected: "0 spans still reading turn_0",
        actual:
          stale[0].spans + " spans across " + stale[0].traces + " of " + TRACES + " traces still read " +
          "turn_0, so /sessions reports those turns as having no spans while /traces renders them",
      });

      // Anti-vacuity, and it is the assertion this probe would most easily pass
      // without. Zero spans on the alias is also what "nothing resolved at all"
      // looks like. Three of the five spans per trace inherit the run id: the
      // subtree root that declared the alias, and the two leaves that declare
      // nothing — which are the rows a session page counts.
      const { rows: resolved } = await client.query(
        "SELECT count(*)::int AS n FROM evestack.spans WHERE attributes->>$1 = $2 AND resolved_turn_id = $3",
        ["probe.marker", MARKER, turnRun],
      );
      t.ok(resolved[0].n === TRACES * INHERITING, "every alias was translated into the run it executed inside", {
        expected: String(TRACES * INHERITING) + " spans naming the run",
        actual: String(resolved[0].n),
      });

      // The sharp one. A resolver that is correct but arrives too late leaves
      // exactly this behind: rows a hand-run sweep would still change. That is
      // what a person found by running it, and it is what must not be true again.
      const { rows: sweep } = await client.query(
        "SELECT evestack.resolve_span_ancestry($1::text[])::int AS changed",
        [traceIds],
      );
      t.ok(sweep[0].changed === 0, "a hand-run resolve over the same traces has nothing left to do", {
        expected: "0 rows changed",
        actual:
          sweep[0].changed + " rows changed, so ingest left work behind that only a manual sweep " +
          "would have finished",
      });
    } finally {
      await client
        .query("DELETE FROM evestack.spans WHERE attributes->>$1 = $2", ["probe.marker", MARKER])
        .catch(() => {});
      await client.end().catch(() => {});
      await db.closePool().catch(() => {});
      process.chdir(cwd);
    }
  },
};
