/**
 * If /traces/<id> reports N tool calls for a session, /sessions/<id> must too.
 *
 * They did not. A stranger opened one session id on both pages, one click
 * apart, and read: a full waterfall with two model calls and one tool call
 * with its arguments and result on /traces, and "No spans on any 1 runs",
 * "TOOLS OFFERED / CALLED 14/-", "No transcript turn" on /sessions. The cause
 * was in Postgres: twelve session-resolved spans carried the correct
 * `resolved_session_id` and a `resolved_turn_id` of the literal string
 * `turn_0`, while the session page keys its turn card on the workflow run id.
 * The two never joined, and the trace page even printed `turn turn_0` on
 * screen without anything treating that as impossible.
 *
 * Neither page was wrong on its own terms, which is why nothing caught it.
 * `tsc` cannot see it, both queries return rows, and each page is
 * self-consistent. The only statement that fails is the one that spans them:
 * two renderings of one session have to agree about how many tools it called.
 *
 * Two assertions, and the first is the one that would have caught it early:
 *
 *   1. Every non-null `resolved_turn_id` names a row in
 *      `workflow.workflow_runs`. `turn_0` is not a run id and never was; it is
 *      an eve-side turn label leaking through the ancestry walk. Nothing in
 *      the schema forbids it, because there is no foreign key to forbid it
 *      with: spans arrive over OTLP before their run may exist.
 *
 *   2. Per session, the count the traces surface renders equals the count the
 *      sessions surface renders, read through each page own code path rather
 *      than through one query used twice.
 *
 * Read-only. It refreshes the fact tables, exactly as probes 07 and 08 do and
 * for the same reason: those tables are derived, and probing a copy of the
 * code instead of the code is how a probe stays green while a product breaks.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DASHBOARD = join(HERE, "../../../packages/dashboard");

async function connect() {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.WORKFLOW_POSTGRES_URL });
  await client.connect();
  await client.query("SET statement_timeout = '60s'");
  client.on("error", () => {});
  return client;
}

export default {
  id: "traces/sessions-and-traces-agree-on-tool-calls",
  title: "one session, two pages, one tool-call count",
  needs: ["postgres", "typescript"],
  why:
    "The sessions page and the traces page count tool calls through different columns: the fact " +
    "table joins on spans.resolved_turn_id, the traces page walks the trace. When the ancestry " +
    "walk wrote an eve turn label instead of a workflow run id, the join silently matched nothing " +
    "and the sessions page reported a session with no spans, no transcript and no tool count, " +
    "while the traces page rendered the whole waterfall for the same id.",

  async available() {
    if (!process.env.WORKFLOW_POSTGRES_URL) return ["WORKFLOW_POSTGRES_URL is not set"];
    try {
      const client = await connect();
      const { rows } = await client.query(
        "SELECT to_regclass('evestack.spans')::text AS spans, to_regclass('workflow.workflow_runs')::text AS runs",
      );
      await client.end();
      if (!rows[0]?.spans) return ["evestack.spans does not exist"];
      if (!rows[0]?.runs) return ["workflow.workflow_runs does not exist"];
      return [];
    } catch (error) {
      return [`cannot reach Postgres: ${error.message}`];
    }
  },

  async run(t) {
    const cwd = process.cwd();
    process.chdir(DASHBOARD);
    await import(join(DASHBOARD, "test/register-ts-resolve.mjs"));
    const traces = await import(join(DASHBOARD, "lib/traces.ts"));
    const facts = await import(join(DASHBOARD, "lib/facts.ts"));
    const db = await import(join(DASHBOARD, "lib/db.ts"));
    const client = await connect();

    try {
      /* ── 1. a resolved turn id is a run id ─────────────────────────────── */

      // No foreign key can express this: spans arrive over OTLP and may land
      // before the run row they belong to. So it has to be asserted.
      const { rows: orphans } = await client.query(`
        select s.resolved_turn_id, count(*)::int as spans
          from evestack.spans s
          left join workflow.workflow_runs r on r.id = s.resolved_turn_id
         where s.resolved_turn_id is not null
           and r.id is null
         group by s.resolved_turn_id
         order by spans desc
         limit 10`);
      t.ok(
        orphans.length === 0,
        "every resolved_turn_id names a real workflow run, so the session join can match",
        {
          expected: "no resolved_turn_id outside workflow.workflow_runs",
          actual: orphans.map((o) => `${o.resolved_turn_id} (${o.spans} spans)`).join(", "),
        },
      );

      const { rows: sessionOrphans } = await client.query(`
        select s.resolved_session_id, count(*)::int as spans
          from evestack.spans s
          left join workflow.workflow_runs r on r.id = s.resolved_session_id
         where s.resolved_session_id is not null
           and r.id is null
         group by s.resolved_session_id
         order by spans desc
         limit 10`);
      t.ok(
        sessionOrphans.length === 0,
        "and every resolved_session_id does too",
        {
          expected: "no resolved_session_id outside workflow.workflow_runs",
          actual: sessionOrphans.map((o) => `${o.resolved_session_id} (${o.spans})`).join(", "),
        },
      );

      /* ── 2. the two pages agree ────────────────────────────────────────── */

      await facts.refreshFacts();

      // What /sessions/<id> renders: fact_turn.tools_called, summed over the
      // turns of the session. NULL means "no spans landed, so we do not know",
      // which is a third answer and is counted separately below.
      const { rows: sessions } = await client.query(`
        select session_id,
               coalesce(sum(tools_called), 0)::int as called,
               count(*) filter (where tools_called is null)::int as unknown_turns,
               count(*)::int as turns
          from evestack.fact_turn
         where session_id is not null
         group by session_id
         order by called desc, session_id
         limit 25`);

      t.ok(sessions.length > 0, "there are sessions to compare", {
        expected: "at least one session in evestack.fact_turn",
        actual: "none",
      });

      let compared = 0;
      let withTools = 0;
      for (const row of sessions) {
        // What /traces/<id> renders: the length of listToolCalls(sessionId).
        // Called rather than reimplemented, so a change to either page moves
        // this probe rather than sliding past it.
        const fromTraces = (await traces.listToolCalls(row.session_id)).length;
        const fromSessions = Number(row.called);

        // A turn whose spans never arrived reports NULL, not 0, and the two
        // surfaces are allowed to disagree there: one knows nothing, the other
        // has nothing. Comparing those would be asserting that an unexported
        // trace is an error, which it is not.
        if (row.unknown_turns > 0 && fromTraces === 0) continue;

        compared += 1;
        if (fromTraces > 0) withTools += 1;
        t.ok(
          fromSessions === fromTraces,
          `${row.session_id}: both pages count ${fromTraces} tool call(s)`,
          {
            expected: `${fromTraces} (the traces page)`,
            actual: `${fromSessions} (the sessions page), over ${row.turns} turn(s)`,
          },
        );
      }

      // Anti-vacuity, and it is the assertion this probe would most easily
      // pass without. Every count agreeing at zero is what a completely broken
      // join looks like from here.
      t.ok(
        withTools > 0,
        `at least one session really called a tool, so the agreement above means something (${withTools} of ${compared})`,
        {
          expected: "a session with a non-zero tool-call count on the traces page",
          actual: `${compared} sessions compared, none with tool calls`,
        },
      );
    } finally {
      await client.end().catch(() => {});
      await db.closePool().catch(() => {});
      process.chdir(cwd);
    }
  },
};
