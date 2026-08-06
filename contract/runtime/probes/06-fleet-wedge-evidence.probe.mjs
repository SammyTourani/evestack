/**
 * The fleet banner must call a session wedged only when a turn is genuinely
 * open.
 *
 * `packages/dashboard/lib/fleet.ts` decides that from the agent's stream where
 * the stream speaks, and from the run rows where it does not — a live agent
 * answers 200 with `x-eve-stream-tail-index: -1` for a session it has never
 * heard of, and that empty fold is indistinguishable from a turn in flight. The
 * run rows are the only witness left, so what they count has to be right.
 *
 * Four things here are PostgreSQL's semantics rather than JavaScript's, which
 * is why they are asserted against a real server:
 *
 * 1. **Finished means `completed_at IS NOT NULL`, never `status`.** This is
 *    lib/monitors.ts's definition and this probe pins fleet.ts to it. A turn
 *    that errored, one a human cancelled and one that never reached a provider
 *    have all FINISHED; monitors.ts counts two of them as failures. A wedge
 *    test on `status <> 'completed'` would report all three as work in flight —
 *    210 turns in the seeded database, against 8 that are really open.
 *
 * 2. **Untagged runs are not turns.** eve writes a companion run per session
 *    that never completes. They carry no `$eve.root` today so the join drops
 *    them; the type filter is what keeps that true if they ever gain one.
 *
 * 3. **`count(*) OVER ()` counts past the LIMIT.** The report says how many
 *    candidates went unprobed, and it used to fetch `limit + 1` rows to find
 *    out — which can only ever say "1 more" while 149 sessions went unchecked.
 *
 * 4. **`timestamp without time zone` compared to `now()` is read in the
 *    server's zone.** The idle cut is `< (now() AT TIME ZONE 'utc') - interval`
 *    for that reason: the CLI port of this file hit the bare-`now()` version
 *    for real, and a session quiet for three hours looked five hours in the
 *    future while the sweep returned nothing.
 *
 * Mirrors the expressions in lib/fleet.ts. Drift between them should be read as
 * this probe going stale rather than as a discovery.
 */
import { randomUUID } from "node:crypto";

/** The evidence columns, verbatim from lib/fleet.ts's candidate query. */
const EVIDENCE = `
  COUNT(t.id) FILTER (
    WHERE t.attributes->>'$eve.type' IN ('turn', 'subagent')
  ) AS turns,
  COUNT(t.id) FILTER (
    WHERE t.attributes->>'$eve.type' IN ('turn', 'subagent')
      AND t.completed_at IS NULL
  ) AS unfinished_turns,
  MIN(t.started_at) FILTER (
    WHERE t.attributes->>'$eve.type' IN ('turn', 'subagent')
      AND t.completed_at IS NULL
  ) AS in_flight_since,
  COUNT(*) OVER () AS candidate_count
`;

/** The cheaper wedge test that must never be substituted for the real one. */
const BY_STATUS = `
  COUNT(t.id) FILTER (
    WHERE t.attributes->>'$eve.type' IN ('turn', 'subagent')
      AND t.status <> 'completed'
  ) AS open_by_status
`;

async function connect() {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.WORKFLOW_POSTGRES_URL });
  await client.connect();
  return client;
}

export default {
  id: "fleet/wedged-means-an-open-turn-row",
  title: "the fleet banner's wedge evidence counts the rows that are really open",
  needs: ["postgres"],
  why:
    "The first version of lib/fleet.ts called 22 healthy sessions wedged, and a banner that " +
    "cries wolf teaches its reader to ignore it. The seeded 30-day database has 113 errored " +
    "turns, 62 that never reached a provider and 37 a human cancelled — all finished — against " +
    "8 that are genuinely open. Counting failures as work in flight would report 166 healthy " +
    "sessions as faults; missing the 8 would hide the only fault eve has no recovery path for.",

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
      // `timestamp without time zone`, because that is what the workflow schema
      // uses and assertion 4 is about exactly that choice.
      await client.query(`
        CREATE TABLE ${schema}.workflow_runs (
          id           text PRIMARY KEY,
          status       text NOT NULL,
          error_code   text,
          created_at   timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
          started_at   timestamp,
          completed_at timestamp,
          updated_at   timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
          attributes   jsonb NOT NULL DEFAULT '{}'::jsonb
        )
      `);

      const insert = async (row) => {
        await client.query(
          `INSERT INTO ${schema}.workflow_runs
             (id, status, error_code, created_at, started_at, completed_at, updated_at, attributes)
           VALUES ($1, $2, $3,
                   (now() AT TIME ZONE 'utc') - $4::interval,
                   (now() AT TIME ZONE 'utc') - $4::interval,
                   CASE WHEN $5 THEN (now() AT TIME ZONE 'utc') - $6::interval END,
                   (now() AT TIME ZONE 'utc') - $6::interval,
                   $7::jsonb)`,
          [
            row.id,
            row.status,
            row.errorCode ?? null,
            row.startedAgo,
            row.finished,
            row.finished ? row.endedAgo : row.startedAgo,
            JSON.stringify(row.attributes),
          ],
        );
      };

      const session = (id) => ({
        id,
        status: "running",
        startedAgo: "6 hours",
        finished: false,
        endedAgo: "3 hours",
        attributes: { "$eve.type": "session", "$eve.title": "probe" },
      });

      // A session whose every turn finished — badly, in three different ways.
      await insert({ ...session("quiet"), startedAgo: "3 hours" });
      await insert({
        id: "quiet-ok",
        status: "completed",
        startedAgo: "5 hours",
        finished: true,
        endedAgo: "5 hours",
        attributes: { "$eve.type": "turn", "$eve.root": "quiet", "$eve.model": "openai/gpt-5-mini" },
      });
      await insert({
        id: "quiet-errored",
        status: "failed",
        errorCode: "provider_overloaded",
        startedAgo: "4 hours",
        finished: true,
        endedAgo: "4 hours",
        attributes: { "$eve.type": "turn", "$eve.root": "quiet", "$eve.model": "openai/gpt-5-mini" },
      });
      await insert({
        id: "quiet-cancelled",
        status: "cancelled",
        startedAgo: "4 hours",
        finished: true,
        endedAgo: "4 hours",
        attributes: { "$eve.type": "turn", "$eve.root": "quiet", "$eve.model": "openai/gpt-5-mini" },
      });
      // Finished, and never reached the provider: no `$eve.model` at all.
      await insert({
        id: "quiet-no-model",
        status: "completed",
        startedAgo: "3 hours",
        finished: true,
        endedAgo: "3 hours",
        attributes: { "$eve.type": "turn", "$eve.root": "quiet" },
      });

      // A session with a turn that started five hours ago and never finished,
      // plus the untagged companion run that never finishes either.
      await insert({ ...session("stuck"), startedAgo: "3 hours" });
      await insert({
        id: "stuck-ok",
        status: "completed",
        startedAgo: "6 hours",
        finished: true,
        endedAgo: "6 hours",
        attributes: { "$eve.type": "turn", "$eve.root": "stuck", "$eve.model": "openai/gpt-5-mini" },
      });
      await insert({
        id: "stuck-open",
        status: "running",
        startedAgo: "5 hours",
        finished: false,
        endedAgo: "5 hours",
        attributes: { "$eve.type": "turn", "$eve.root": "stuck", "$eve.model": "openai/gpt-5-mini" },
      });
      await insert({
        id: "stuck-companion",
        status: "running",
        startedAgo: "3 hours",
        finished: false,
        endedAgo: "3 hours",
        attributes: { "$eve.root": "stuck" },
      });

      const evidenceFor = async (cut, { limit = 10 } = {}) => {
        const { rows } = await client.query(`
          SELECT s.id AS session_id,
                 GREATEST(s.updated_at, COALESCE(MAX(t.updated_at), s.updated_at)) AS last_activity,
                 ${EVIDENCE},
                 ${BY_STATUS}
          FROM ${schema}.workflow_runs s
          LEFT JOIN ${schema}.workflow_runs t
            ON t.attributes->>'$eve.root' = s.id
          WHERE s.attributes->>'$eve.type' = 'session'
            AND s.status = 'running'
          GROUP BY s.id, s.attributes, s.created_at, s.updated_at
          HAVING GREATEST(s.updated_at, COALESCE(MAX(t.updated_at), s.updated_at)) < ${cut}
          ORDER BY last_activity ASC
          LIMIT ${limit}
        `);
        return rows;
      };

      const UTC_CUT = `(now() AT TIME ZONE 'utc') - interval '30 minutes'`;
      const rows = await evidenceFor(UTC_CUT);
      const byId = new Map(rows.map((r) => [r.session_id, r]));

      const quiet = byId.get("quiet");
      const stuck = byId.get("stuck");

      t.ok(rows.length === 2, "both idle sessions are candidates", rows.length === 2 ? {} : {
        expected: 2,
        actual: rows.length,
      });

      /* 1. finished is completed_at, not status ------------------------------ */

      const quietUnfinished = Number(quiet?.unfinished_turns);
      t.ok(
        quietUnfinished === 0,
        "an errored, a cancelled and a no-model-call turn are all FINISHED — nothing in flight",
        quietUnfinished === 0
          ? {}
          : {
              expected: "0 open turns on a session whose four turns all reached completed_at",
              actual: `${quietUnfinished} — a failure is being counted as work in flight, which is how 166 healthy sessions get reported as wedged`,
            },
      );
      t.ok(
        Number(quiet?.turns) === 4,
        "all four of its turns are still counted as turns",
        Number(quiet?.turns) === 4 ? {} : { expected: 4, actual: Number(quiet?.turns) },
      );
      t.ok(
        quiet?.in_flight_since === null,
        "with nothing open there is no in-flight age to report",
        quiet?.in_flight_since === null ? {} : { expected: null, actual: quiet?.in_flight_since },
      );

      const openByStatus = Number(quiet?.open_by_status);
      t.ok(
        openByStatus > quietUnfinished,
        "the cheaper status test disagrees, so it can never be quietly substituted",
        openByStatus > quietUnfinished
          ? {}
          : {
              expected: "status <> 'completed' to over-report against completed_at IS NULL",
              actual: `${openByStatus} by status vs ${quietUnfinished} really open — if these agree the fixture has stopped covering the failed and cancelled turns`,
            },
      );
      t.note(`status <> 'completed' would call ${openByStatus} of the quiet session's turns open`);

      /* 2. the open turn, and only it ---------------------------------------- */

      t.ok(
        Number(stuck?.unfinished_turns) === 1,
        "the turn that never reached completed_at is the one open turn",
        Number(stuck?.unfinished_turns) === 1
          ? {}
          : { expected: 1, actual: Number(stuck?.unfinished_turns) },
      );
      t.ok(
        Number(stuck?.turns) === 2,
        "the untagged companion run is not a turn, however long it stays running",
        Number(stuck?.turns) === 2
          ? {}
          : {
              expected: "2 — the companion run carries no $eve.type",
              actual: `${Number(stuck?.turns)}; counting one companion run per session reports the whole fleet as wedged`,
            },
      );

      const { rows: age } = await client.query(
        `SELECT EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'utc') - $1::timestamp)) AS seconds`,
        [stuck?.in_flight_since],
      );
      const hours = Number(age[0].seconds) / 3600;
      const measured = Math.abs(hours - 5) < 0.1;
      t.ok(
        measured,
        "the in-flight age is the open turn's own start, not the session's idle time",
        measured
          ? {}
          : {
              expected: "5 hours — the open turn started then; the session was touched 3 hours ago",
              actual: `${hours.toFixed(2)} hours`,
            },
      );

      /* 3. the unchecked count survives the LIMIT ----------------------------- */

      const paged = await evidenceFor(UTC_CUT, { limit: 1 });
      const total = Number(paged[0]?.candidate_count);
      t.ok(
        paged.length === 1 && total === 2,
        "count(*) OVER () reports every candidate, not just the page",
        paged.length === 1 && total === 2
          ? {}
          : {
              expected: "1 row carrying a candidate_count of 2",
              actual: `${paged.length} row(s) carrying ${total} — the banner would understate how many sessions went unchecked`,
            },
      );

      /* 4. the zone the naive columns are read in ----------------------------- */

      await client.query(`SET TIME ZONE 'America/Los_Angeles'`);
      const naive = await evidenceFor(`now() - interval '30 minutes'`);
      const utc = await evidenceFor(UTC_CUT);
      const zoneSafe = naive.length === 0 && utc.length === 2;
      t.ok(
        zoneSafe,
        "the idle cut must be taken in UTC, or a non-UTC server hides every candidate",
        zoneSafe
          ? {}
          : {
              expected:
                "a bare now() to find 0 of the 2 quiet sessions on a US/Pacific server, and the UTC cut to find both",
              actual: `bare now(): ${naive.length}, UTC cut: ${utc.length} — if the bare version now agrees, this server is running UTC and the assertion has stopped testing anything`,
            },
      );
      t.note(
        `on a US/Pacific server the bare-now() cut sees ${naive.length} of the ${utc.length} sessions that are really quiet`,
      );
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
      await client.end();
    }
  },
};
