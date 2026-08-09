/**
 * The fleet banner must call a session wedged only when a turn is genuinely
 * open — and must not spend a round trip on a session the tables already
 * settled.
 *
 * `packages/dashboard/lib/fleet.ts` asks the agent's stream about a session
 * only when the run rows cannot answer on their own. A live agent answers 200
 * with `x-eve-stream-tail-index: -1` for a session it has never heard of, and
 * that empty fold is indistinguishable from a turn in flight, so the run rows
 * decide who is worth asking. What they count has to be right.
 *
 * Five things here are PostgreSQL's semantics rather than JavaScript's, which
 * is why they are asserted against a real server:
 *
 * 1. **Finished means `completed_at IS NOT NULL`, never `status`.** This is
 *    lib/monitors.ts's definition. A turn that errored, one a human cancelled
 *    and one that never reached a provider have all FINISHED; monitors.ts
 *    counts two of them as failures. A wedge test on `status <> 'completed'`
 *    would report all three as work in flight — 210 turns in the seeded
 *    database, against 8 that are really open.
 *
 *    THIS PROBE DOES NOT PIN fleet.ts, and that sentence used to say it did.
 *    The constants below are hand-copied duplicates of the shipped SQL, and
 *    every assertion here runs the COPY against a fixture table this file
 *    builds. That is the right shape for the job — these five properties are
 *    PostgreSQL's semantics and need a real server to settle — but it means the
 *    probe stays green if lib/fleet.ts is edited and the copies are not. The
 *    file-to-file comparison is a separate job, and it now exists:
 *    contract/contracts/20-fleet-port.contract.mjs reads fleet.ts and the CLI's
 *    port and fails when either loses a term. It was written after the CLI
 *    shipped without the unfinished-turn filter in item 3 below — exactly the
 *    drift this comment claimed to be preventing and was not.
 *
 * 2. **Untagged runs are not turns.** eve writes a companion run per session
 *    that never completes. They carry no `$eve.root` today so the join drops
 *    them; the type filter is what keeps that true if they ever gain one.
 *
 * 3. **A session whose turns all closed is not a candidate at all.** The filter
 *    lives in HAVING rather than in the caller, so those rows are never
 *    fetched and never probed. Paging the quiet sessions instead reached 1 of
 *    the 8 open turns in the seeded database and spent 24 round trips
 *    re-asking about sessions the same query had already resolved.
 *
 * 4. **The filter counts rows; it does not test the age column.** A run created
 *    and never picked up has `completed_at` AND `started_at` null, so
 *    `MIN(started_at) IS NOT NULL` would drop a genuinely open turn. And
 *    `count(*) OVER ()` still counts past the LIMIT, which is how the report
 *    says how many open-turn sessions went unprobed; it used to fetch
 *    `limit + 1` rows to find out, which can only ever say "1 more".
 *
 * 5. **`timestamp without time zone` compared to `now()` is read in the
 *    server's zone.** The idle cut is `< (now() AT TIME ZONE 'utc') - interval`
 *    for that reason: the CLI port of this file hit the bare-`now()` version
 *    for real, and a session quiet for three hours looked five hours in the
 *    future while the sweep returned nothing.
 *
 * Mirrors the expressions in lib/fleet.ts. Drift between them should be read as
 * this probe going stale rather than as a discovery.
 */
import { randomUUID } from "node:crypto";

/** The wedge test, verbatim from lib/fleet.ts's HAVING clause. */
const OPEN_TURNS = `
  COUNT(t.id) FILTER (
    WHERE t.attributes->>'$eve.type' IN ('turn', 'subagent')
      AND t.completed_at IS NULL
  )
`;

/** The evidence the sweep actually reads, verbatim from its SELECT list. */
const EVIDENCE = `
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
    "sessions as faults; missing the 8 would hide the only fault eve has no recovery path for. " +
    "The same count decides who is worth an HTTP round trip, so getting it wrong is now a cost " +
    "as well as a correctness bug.",

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
      // uses and assertion 5 is about exactly that choice.
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
                   CASE WHEN $8 THEN (now() AT TIME ZONE 'utc') - $4::interval END,
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
            row.pickedUp ?? true,
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

      // A session whose only turn was created and never picked up: no
      // `completed_at`, and no `started_at` either. Assertion 4 lives on it.
      await insert({ ...session("queued"), startedAgo: "3 hours" });
      await insert({
        id: "queued-open",
        status: "pending",
        startedAgo: "2 hours",
        pickedUp: false,
        finished: false,
        endedAgo: "2 hours",
        attributes: { "$eve.type": "turn", "$eve.root": "queued" },
      });

      const evidenceFor = async (cut, { limit = 10, unsettledOnly = true } = {}) => {
        const { rows } = await client.query(`
          SELECT s.id AS session_id,
                 GREATEST(s.updated_at, COALESCE(MAX(t.updated_at), s.updated_at)) AS last_activity,
                 ${OPEN_TURNS} AS unfinished_turns,
                 ${EVIDENCE},
                 ${BY_STATUS}
          FROM ${schema}.workflow_runs s
          LEFT JOIN ${schema}.workflow_runs t
            ON t.attributes->>'$eve.root' = s.id
          WHERE s.attributes->>'$eve.type' = 'session'
            AND s.status = 'running'
          GROUP BY s.id, s.attributes, s.created_at, s.updated_at
          HAVING GREATEST(s.updated_at, COALESCE(MAX(t.updated_at), s.updated_at)) < ${cut}
            ${unsettledOnly ? `AND ${OPEN_TURNS} > 0` : ""}
          ORDER BY last_activity ASC
          LIMIT ${limit}
        `);
        return rows;
      };

      const UTC_CUT = `(now() AT TIME ZONE 'utc') - interval '30 minutes'`;
      const everyQuietSession = await evidenceFor(UTC_CUT, { unsettledOnly: false });
      const byId = new Map(everyQuietSession.map((r) => [r.session_id, r]));

      const quiet = byId.get("quiet");
      const stuck = byId.get("stuck");

      t.ok(
        everyQuietSession.length === 3,
        "all three sessions are quiet enough that only the run rows separate them",
        everyQuietSession.length === 3 ? {} : { expected: 3, actual: everyQuietSession.length },
      );

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
        "the turn that never reached completed_at is the one open turn, and the untagged companion run is not a turn however long it stays running",
        Number(stuck?.unfinished_turns) === 1
          ? {}
          : {
              expected: "1 — the companion run carries no $eve.type, so the type filter drops it",
              actual: `${Number(stuck?.unfinished_turns)}; counting one companion run per session reports the whole fleet as wedged`,
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

      /* 3. the settled session is never even fetched -------------------------- */

      const unsettled = await evidenceFor(UTC_CUT);
      const asked = unsettled.map((r) => r.session_id).sort();
      const onlyOpen = asked.length === 2 && asked[0] === "queued" && asked[1] === "stuck";
      t.ok(
        onlyOpen,
        "a session whose turns all closed is not a candidate, so no round trip is spent on it",
        onlyOpen
          ? {}
          : {
              expected: "stuck and queued — the two sessions carrying a turn row that never closed",
              actual: `${asked.join(", ") || "nothing"} — probing a settled session folds its pruned stream to silence, which is what a turn in flight looks like`,
            },
      );

      /* 4. the filter counts rows, and counts past the LIMIT ------------------ */

      const queued = unsettled.find((r) => r.session_id === "queued");
      const queuedIsOpen = Number(queued?.unfinished_turns) === 1 && queued?.in_flight_since === null;
      t.ok(
        queuedIsOpen,
        "a turn created and never picked up is open even though it has no started_at",
        queuedIsOpen
          ? {}
          : {
              expected: "1 open turn carrying a null in_flight_since",
              actual: `${Number(queued?.unfinished_turns)} open, in_flight_since ${queued?.in_flight_since} — writing the filter as MIN(started_at) IS NOT NULL would silently drop this session`,
            },
      );

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

      /* 5. the zone the naive columns are read in ----------------------------- */

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
                "a bare now() to find 0 of the 2 open-turn sessions on a US/Pacific server, and the UTC cut to find both",
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
