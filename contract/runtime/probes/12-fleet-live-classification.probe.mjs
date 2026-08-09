/**
 * The fleet classifier's agent-dependent half, against a live agent.
 *
 * `classifySession()` is pure and covered by test/fleet.test.mjs. What that
 * cannot touch is the thing the whole module is built on: how a REAL eve
 * answers when asked about a session, and in particular how it answers about a
 * session it has never heard of.
 *
 * eve does not 404 there. It serves an empty stream with
 * `x-eve-stream-tail-index: -1`, and lib/fleet.ts, the stream route, the
 * message route and the approve route each decide independently that -1 means
 * "no such session". Four call sites, one undocumented upstream convention, and
 * no test anywhere that eve still behaves that way. If a future eve returned
 * `0`, or dropped the header, every one of them would start reporting a
 * nonexistent session as a healthy one — and the fleet banner in particular
 * would silently stop being able to say `unknown`.
 *
 * ── Why a unit test cannot reach this ────────────────────────────────────────
 *
 * Every fixture in test/fleet.test.mjs hands `classifySession` a snapshot object
 * that this repository constructed. The question here is whether eve produces
 * snapshots of that shape at all, which is answerable only by asking one.
 *
 * No model key is needed: a turn that fails at the provider still creates a
 * durable session, still indexes its stream, and still publishes a tail index.
 */

const AGENT = process.env.EVESTACK_PROBE_AGENT_URL?.replace(/\/$/, "") ?? null;
const DASHBOARD = process.env.EVESTACK_PROBE_DASHBOARD_URL?.replace(/\/$/, "") ?? null;
const USER = process.env.EVESTACK_PROBE_DASHBOARD_USER ?? null;
const PASSWORD = process.env.EVESTACK_PROBE_DASHBOARD_PASSWORD ?? null;

/** Kept in step with EVE_STREAM_TAIL_INDEX_HEADER in lib/agent-client.ts:27. */
const TAIL_INDEX_HEADER = "x-eve-stream-tail-index";

/** The health values lib/fleet.ts:81 can emit. Listed so an unknown one fails. */
const HEALTH = new Set(["idle", "active", "awaiting-human", "wedged", "unknown"]);

async function dashboard(path, init = {}) {
  return fetch(`${DASHBOARD}${path}`, {
    ...init,
    headers: {
      authorization: `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

/**
 * Ask the agent about a session the way lib/fleet.ts does, and read only the
 * header. The body is cancelled immediately — this is a question about
 * existence, and draining a live turn's stream would block for its duration.
 *
 * `?includeTailIndex=1` is NOT optional and the first version of this probe
 * omitted it. eve sends the header only when the request asks for it
 * (openEventStream sets the parameter at lib/agent-client.ts:389), so without it
 * the header is absent for EVERY session, real or not — and this probe reported
 * that absence as eve having changed its convention. It had not. The parameter
 * is part of the question, not part of the answer.
 */
async function tailIndexOf(sessionId) {
  const response = await fetch(
    `${AGENT}/eve/v1/session/${encodeURIComponent(sessionId)}/stream?includeTailIndex=1`,
    { headers: { accept: "application/x-ndjson" }, signal: AbortSignal.timeout(10_000) },
  );
  const raw = response.headers.get(TAIL_INDEX_HEADER);
  await response.body?.cancel().catch(() => {});
  return { status: response.status, raw, index: raw === null ? null : Number(raw) };
}

async function connect() {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.WORKFLOW_POSTGRES_URL });
  await client.connect();
  return client;
}

export default {
  id: "seam/fleet-classification-against-a-live-agent",
  title: "eve still signals an unknown session with a tail index of -1, and the fleet report reads it",
  needs: ["dashboard", "agent", "postgres"],
  why:
    "Four routes decide 'this session does not exist' from one undocumented eve convention: a " +
    "200 with x-eve-stream-tail-index: -1. Nothing has ever checked that eve still does it. If " +
    "the header moved or the value changed, the stream, message and approve routes would each " +
    "start treating a typo as a live session, and the fleet banner would lose its ability to say " +
    "`unknown` at all — which is the one honest answer when the agent cannot be reached. Every " +
    "fixture in the unit tests is a snapshot this repository built, so none of them can tell.",

  async available() {
    const missing = [];
    if (!AGENT) missing.push("EVESTACK_PROBE_AGENT_URL is not set");
    if (!DASHBOARD) missing.push("EVESTACK_PROBE_DASHBOARD_URL is not set");
    if (!USER || !PASSWORD) missing.push("EVESTACK_PROBE_DASHBOARD_{USER,PASSWORD} are not set");
    // Postgres, because the fixture below reopens a turn row: with no provider
    // key every turn finishes instantly, so the sweep correctly has nothing to
    // classify and the whole second half would assert over an empty list.
    if (!process.env.WORKFLOW_POSTGRES_URL) missing.push("WORKFLOW_POSTGRES_URL is not set");
    if (missing.length > 0) return missing;
    try {
      const [agent, dash] = await Promise.all([
        fetch(`${AGENT}/`, { signal: AbortSignal.timeout(5_000) }).catch((e) => ({ error: e })),
        fetch(`${DASHBOARD}/api/health`, { signal: AbortSignal.timeout(5_000) }).catch((e) => ({ error: e })),
      ]);
      if (agent.error) return [`cannot reach the agent: ${agent.error.message}`];
      if (dash.error) return [`cannot reach the dashboard: ${dash.error.message}`];
      return [];
    } catch (error) {
      return [`cannot reach the stack: ${error.message}`];
    }
  },

  async run(t) {
    /* ── the convention four routes are built on ───────────────────────────── */

    const ghost = await tailIndexOf("wrun_probe_fleet_no_such_session");

    t.ok(
      ghost.status === 200,
      "eve answers 200 for a session it has never heard of — it does not 404, which is why every caller has to decide for itself",
      ghost.status === 200
        ? {}
        : {
            expected: "200, eve's documented behaviour for an unknown id",
            actual: `${ghost.status} — if eve now 404s here, the four callers that check for -1 are dead code and should be simplified rather than left`,
          },
    );

    t.ok(
      ghost.raw !== null,
      `eve still sends the ${TAIL_INDEX_HEADER} header`,
      ghost.raw !== null
        ? {}
        : {
            expected: `a ${TAIL_INDEX_HEADER} header`,
            actual: "absent — parseTailIndex() would fall back and every unknown session would read as real",
          },
    );

    t.ok(
      ghost.index === -1,
      "and its value for an unknown session is exactly -1, which is the whole existence test",
      ghost.index === -1
        ? {}
        : {
            expected: -1,
            actual: `${ghost.raw} — the stream, message, approve and fleet paths all compare against -1, so any other value turns a typo into a healthy session`,
          },
    );

    /* ── and what it is for a session that really exists ───────────────────── */

    const created = await dashboard("/api/control/sessions", {
      method: "POST",
      body: JSON.stringify({ message: "probe: fleet classification, no model call expected" }),
    });
    const body = await created.json().catch(() => ({}));

    if (typeof body.sessionId !== "string") {
      t.ok(false, "no session was created, so the live-session half of this probe did not run", {
        expected: "202 with a sessionId",
        actual: `${created.status} ${JSON.stringify(body).slice(0, 200)}`,
      });
      return;
    }

    // eve indexes the stream as the session starts; asking too early is a real
    // race rather than a bug, so this waits for the index to appear.
    let real = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      real = await tailIndexOf(body.sessionId);
      if (real.index !== null && real.index >= 0) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    t.ok(
      real !== null && real.index >= 0,
      "a session that does exist reports a tail index at or above zero, so the two cases are genuinely distinguishable",
      real !== null && real.index >= 0
        ? {}
        : {
            expected: ">= 0 within 10s",
            actual: `${real?.raw} — if a real session also reported -1 the existence test would reject every session, and this probe's -1 assertion above would be passing on a constant`,
          },
    );
    t.note(`live session ${body.sessionId} tail index ${real?.raw}`);

    /* ── the report the banner renders ─────────────────────────────────────── */

    /*
     * A fixture, because there is otherwise nothing to sweep.
     *
     * lib/fleet.ts only asks the agent about a session whose run rows cannot
     * settle it — HAVING open turns > 0. With no provider key the turn fails at
     * the model call in well under a second, so it reaches `completed_at`
     * immediately and the session is correctly NOT a candidate. The first run of
     * this probe asserted "at least one candidate" against that and failed; the
     * sweep was right and the fixture was missing.
     *
     * So the turn row for the session just created is reopened — completed_at
     * back to NULL, started_at moved ten minutes into the past — which is
     * exactly the shape of the bug this module exists for: a turn whose process
     * died mid-flight. The sweep then has to ask the LIVE agent what happened to
     * it, which is the agent-dependent branch nothing else reaches. Restored in
     * `finally`, so the row is left as it was found.
     */
    const client = await connect();
    let restored = false;
    let original = null;
    let sessionStatus = null;

    try {
      for (let attempt = 0; attempt < 40 && original === null; attempt += 1) {
        const { rows } = await client.query(
          `SELECT id, status, started_at, completed_at FROM workflow.workflow_runs
            WHERE attributes->>'$eve.root' = $1
              AND attributes->>'$eve.type' IN ('turn','subagent')
            ORDER BY created_at LIMIT 1`,
          [body.sessionId],
        );
        if (rows.length > 0) original = rows[0];
        else await new Promise((resolve) => setTimeout(resolve, 250));
      }

      t.ok(
        original !== null,
        "the live agent wrote a turn row for the new session, which is what the sweep reads",
        original !== null
          ? {}
          : {
              expected: "a $eve.type='turn' row carrying $eve.root = the session id within 10s",
              actual: "none — without it there is no fixture to reopen and the classification checks below would run over an empty sweep",
            },
      );

      if (original === null) return;

      await client.query(
        `UPDATE workflow.workflow_runs
            SET completed_at = NULL,
                started_at = (now() AT TIME ZONE 'utc') - interval '10 minutes'
          WHERE id = $1`,
        [original.id],
      );
      // The sweep only considers sessions whose own row still says running, so
      // the session has to be reopened too — and its previous value kept, or the
      // restore below would put back only half the fixture.
      const { rows: sessionRows } = await client.query(
        `SELECT status FROM workflow.workflow_runs WHERE id = $1`,
        [body.sessionId],
      );
      sessionStatus = sessionRows[0]?.status ?? null;
      await client.query(
        `UPDATE workflow.workflow_runs SET status = 'running' WHERE id = $1`,
        [body.sessionId],
      );

      // idleMinutes=0 so the session just created is a candidate; the default 30
      // would exclude it and this whole section would assert over an empty list.
      const report = await dashboard("/api/fleet?idleMinutes=0&limit=25");
      const fleet = await report.json().catch(() => ({}));

      t.ok(
        report.ok && Array.isArray(fleet.entries),
        "the fleet sweep runs against the live agent and returns a list of entries",
        report.ok && Array.isArray(fleet.entries)
          ? {}
          : { expected: "200 with an entries array", actual: `${report.status} ${JSON.stringify(fleet).slice(0, 200)}` },
      );

      const entries = Array.isArray(fleet.entries) ? fleet.entries : [];
      t.note(
        `${entries.length} entries: ${entries.map((e) => `${e.sessionId?.slice(0, 12)}…=${e.health}`).join(", ") || "(none)"}`,
      );

      // ANTI-VACUITY. Every assertion below is a `for` over `entries`, and all of
      // them pass over an empty array. The session created moments ago has an open
      // turn row, so an empty sweep means the sweep is broken, not that the fleet
      // is healthy.
      t.ok(
        entries.length > 0,
        "the sweep actually probed at least one session, so the classification assertions below have something to run over",
        entries.length > 0
          ? {}
          : {
              expected: ">= 1 candidate — a session was created seconds ago and its turn row is open",
              actual: "0 — every check after this one would pass by iterating nothing",
            },
      );

      const knownHealth = entries.every((e) => HEALTH.has(e.health));
      t.ok(
        knownHealth,
        "every entry carries one of the five documented health states",
        knownHealth
          ? {}
          : {
              expected: [...HEALTH].join(" | "),
              actual: [...new Set(entries.map((e) => e.health))].join(", "),
            },
      );

      const explained = entries.every((e) => typeof e.reason === "string" && e.reason.length > 0);
      t.ok(
        explained,
        "and a reason in words, which is what makes the banner actionable rather than a coloured dot",
        explained ? {} : { expected: "a non-empty reason on every entry", actual: "at least one entry had none" },
      );

      // The point of the whole exercise: with the agent up and answering, no
      // session may be classified `unknown`. That state means "the agent could not
      // be reached", and reporting it while eve is healthy would send an operator
      // to debug a network that is fine.
      const noneUnknown = entries.every((e) => e.health !== "unknown");
      t.ok(
        noneUnknown,
        "and none is `unknown` while the agent is up — that state means the agent could not be reached",
        noneUnknown
          ? {}
          : {
              expected: "no `unknown` entries against a live agent",
              actual: `${entries.filter((e) => e.health === "unknown").length} of ${entries.length} — the sweep is failing to reach an agent this probe just talked to`,
            },
      );

      const pendingCoherent = entries.every(
        (e) =>
          Number.isInteger(e.pendingCount) &&
          e.pendingCount >= 0 &&
          (e.health === "awaiting-human") === e.pendingCount > 0,
      );
      t.ok(
        pendingCoherent,
        "awaiting-human is exactly the entries with something outstanding, and no others",
        pendingCoherent
          ? {}
          : {
              expected: "health === 'awaiting-human' if and only if pendingCount > 0",
              actual: entries.map((e) => `${e.health}/${e.pendingCount}`).join(", "),
            },
      );
    } finally {
      // Put the row back exactly as it was, whatever happened above. This runs
      // against the agent's live database, and a probe that leaves a turn
      // permanently open would hand every later reader a wedged session that
      // never existed.
      if (original !== null) {
        await client
          .query(
            `UPDATE workflow.workflow_runs SET completed_at = $2, started_at = $3, status = $4 WHERE id = $1`,
            [original.id, original.completed_at, original.started_at, original.status],
          )
          .catch(() => {});
        if (sessionStatus !== null) {
          await client
            .query(`UPDATE workflow.workflow_runs SET status = $2 WHERE id = $1`, [
              body.sessionId,
              sessionStatus,
            ])
            .catch(() => {});
        }
        restored = true;
      }
      await client.end().catch(() => {});
    }

    t.ok(
      restored,
      "the reopened turn row was restored, so the fixture leaves nothing behind",
      restored ? {} : { expected: "the original completed_at and status put back", actual: "not restored" },
    );
  },
};
