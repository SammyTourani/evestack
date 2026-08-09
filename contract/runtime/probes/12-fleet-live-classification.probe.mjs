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

export default {
  id: "seam/fleet-classification-against-a-live-agent",
  title: "eve still signals an unknown session with a tail index of -1, and the fleet report reads it",
  needs: ["dashboard", "agent"],
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
    /* ── the report the banner renders, as far as this can honestly go ────── */

    /*
     * The sweep is asked for its report, and the SHAPE of that report is
     * asserted. What is deliberately NOT asserted is the classification of any
     * particular session, and the reason is a live finding rather than laziness.
     *
     * lib/fleet.ts only probes a session whose run rows cannot settle it, and
     * with no provider key every turn in this job finishes in under a second —
     * so nothing is a candidate and there is nothing to classify. An earlier
     * version of this probe manufactured one by reopening a finished turn row
     * (completed_at back to NULL) to force the sweep to ask the agent about it.
     *
     * That fixture produced `unknown`, carrying the reason "the agent could not
     * be reached (terminated)" — undici's signal for a socket the far end closed
     * — about an agent this same probe had just talked to twice, successfully,
     * in the assertions above.
     *
     * That is either a real defect in readRecentEvents against a session eve
     * considers over, or an artefact of a database state no real install
     * reaches. Both are plausible. Neither can be settled from a machine that
     * cannot run eve, and asserting it either way would mean asserting something
     * nobody has established — which is the exact failure this tier exists to
     * prevent. So it is written down as a task, and the fixture is removed
     * rather than left in producing a red that nobody trusts and everybody
     * learns to re-run.
     */
    const report = await dashboard("/api/fleet?idleMinutes=0&limit=25");
    const fleet = await report.json().catch(() => ({}));

    t.ok(
      report.ok && Array.isArray(fleet.entries),
      "the fleet sweep runs against the live agent and returns a report",
      report.ok && Array.isArray(fleet.entries)
        ? {}
        : {
            expected: "200 with an entries array",
            actual: `${report.status} ${JSON.stringify(fleet).slice(0, 200)}`,
          },
    );

    const entries = Array.isArray(fleet.entries) ? fleet.entries : [];
    t.note(
      `${entries.length} entries: ${entries.map((e) => `${e.sessionId?.slice(0, 12)}…=${e.health}`).join(", ") || "(none)"}`,
    );

    /*
     * Shape, not verdict — and this one IS vacuous over an empty list, which is
     * said out loud rather than papered over with a count assertion the fixture
     * can no longer support. Every entry the sweep does return has to be one the
     * banner can render: an unrecognised health or a missing reason draws a
     * coloured dot with nothing to act on.
     */
    const wellFormed = entries.every(
      (e) =>
        HEALTH.has(e.health) &&
        typeof e.reason === "string" &&
        e.reason.length > 0 &&
        Number.isInteger(e.pendingCount) &&
        (e.health === "awaiting-human") === e.pendingCount > 0,
    );
    t.ok(
      wellFormed,
      "every entry the sweep returns is one the banner can render",
      wellFormed
        ? {}
        : {
            expected: `health in ${[...HEALTH].join("|")}, a non-empty reason, and awaiting-human exactly when pendingCount > 0`,
            actual: entries.map((e) => `${e.health}/${e.pendingCount}/${e.reason?.slice(0, 40)}`).join(" ; "),
          },
    );
  },
};
