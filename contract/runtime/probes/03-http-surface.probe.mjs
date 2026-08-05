/**
 * The HTTP surface the dashboard drives, exercised against a booted agent.
 *
 * `contract/contracts/05-http-protocol.contract.mjs` pins the route *strings* by
 * reading eve's compiled route table. That catches a rename and nothing else. It
 * cannot see what a route actually does — and the dashboard is a write client,
 * so what a route does when it is asked something wrong is the part that
 * matters.
 *
 * The specific worry, in the shape this project keeps hitting: a route that
 * answers 200 and is wrong. An unknown session id that quietly starts a NEW
 * session — billing a model call nobody asked for and orphaning the id the
 * caller was tracking. A stream for a session that does not exist returning 200
 * and then hanging forever, so a dashboard tab waits on an event that can never
 * arrive. Both are silent, both look healthy from the outside, and neither is
 * visible to a static assertion.
 *
 * ── Why every check here avoids a model call ─────────────────────────────────
 *
 * Every request below is deliberately malformed or aimed at an id that does not
 * exist, so a correct eve rejects it *before* reaching a provider. That is what
 * makes this probe free, deterministic, and safe to run on every commit — and
 * it is also the point: if one of these requests DOES reach a provider, the
 * probe has found exactly the bug it is looking for. A missing model key is
 * therefore not a prerequisite here; it is closer to a control.
 *
 * ── This probe does not boot the agent ───────────────────────────────────────
 *
 * It expects one already running at EVESTACK_PROBE_AGENT_URL and skips
 * otherwise. Booting is left to the caller because the caller knows what it can
 * afford: on a GitHub runner that is `eve dev` beside a Postgres service
 * container, and on an 8 GB laptop it is nothing at all — eve re-enqueues active
 * runs on startup and the Docker sandbox spawns a container per session, which
 * has taken a developer machine down.
 */
const BASE = process.env.EVESTACK_PROBE_AGENT_URL ?? "";

/** Long enough to prove a stream does not hang, short enough that a hung stream
 *  fails the job rather than sitting in it. */
const STREAM_TIMEOUT_MS = 10_000;

const UNKNOWN = "wrun_00000000000000000000000000";

async function request(path, init = {}, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BASE}${path}`, { ...init, signal: controller.signal });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not every response is JSON; the raw text is kept either way */
    }
    return { status: response.status, headers: response.headers, text, json, timedOut: false };
  } catch (error) {
    if (error.name === "AbortError") return { status: 0, headers: null, text: "", json: null, timedOut: true };
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export default {
  id: "protocol/wrong-requests-are-refused-not-absorbed",
  title: "unknown sessions and malformed requests are refused, and streams never hang",
  needs: ["agent"],
  why:
    "The dashboard's whole write path is these routes. A route that answers 200 to a session " +
    "that does not exist either starts a new one — spending money and orphaning the id the " +
    "caller is tracking — or leaves a stream open on an event that can never arrive. Both look " +
    "healthy from outside and neither is visible to a route-name assertion.",

  async available() {
    if (!BASE) return ["EVESTACK_PROBE_AGENT_URL is not set (no agent to probe)"];
    try {
      const res = await request("/", {}, 5_000);
      if (res.timedOut) return [`${BASE} did not answer within 5s`];
      return [];
    } catch (error) {
      return [`cannot reach ${BASE}: ${error.message}`];
    }
  },

  async run(t) {
    t.note(`probing ${BASE}`);

    /* ---------------------------------------------------------------------- */
    /* an unknown session must not be silently adopted                         */
    /* ---------------------------------------------------------------------- */

    const continued = await request(`/eve/v1/session/${UNKNOWN}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { role: "user", content: "probe" } }),
    });

    t.ok(
      continued.status !== 200 || continued.json?.ok !== true,
      "continuing an unknown session is not answered with a bare ok:true",
      continued.status === 200 && continued.json?.ok === true
        ? {
            expected: "a refusal, or a body that names the session it actually acted on",
            actual: `200 ${continued.text.slice(0, 200)}`,
          }
        : { actual: `${continued.status}` },
    );

    // Whatever it answers, it must not have invented a different session and
    // told us nothing about it. If a session id comes back at all, it has to be
    // the one that was asked for.
    const echoed = continued.json?.sessionId ?? continued.json?.session?.id ?? null;
    if (echoed !== null) {
      t.ok(echoed === UNKNOWN, "any session id in the response is the one that was requested", {
        ...(echoed === UNKNOWN ? {} : { expected: UNKNOWN, actual: echoed }),
      });
    }

    /* ---------------------------------------------------------------------- */
    /* a stream for a session that does not exist must end                     */
    /* ---------------------------------------------------------------------- */

    const stream = await request(`/eve/v1/session/${UNKNOWN}/stream`, {}, STREAM_TIMEOUT_MS);

    t.ok(
      !stream.timedOut,
      `streaming an unknown session terminates within ${STREAM_TIMEOUT_MS / 1000}s`,
      stream.timedOut
        ? {
            expected: "a response that ends",
            actual: "the connection was still open when the probe gave up — a dashboard tab would wait forever",
          }
        : { actual: `${stream.status}` },
    );

    /* ---------------------------------------------------------------------- */
    /* cancel answers in the vocabulary the dashboard switches on              */
    /* ---------------------------------------------------------------------- */

    const cancel = await request(`/eve/v1/session/${UNKNOWN}/cancel`, { method: "POST" });

    // The contract pins that CancelTurnStatus still *contains* these strings.
    // This checks that the running server actually answers in them, which is
    // what packages/dashboard/lib/agent-client.ts branches on.
    const status = cancel.json?.status ?? null;
    const known = status === null || status === "accepted" || status === "no_active_turn";
    t.ok(known, "cancel answers with a status the dashboard knows how to read", {
      ...(known ? { actual: `${cancel.status} ${status ?? "(no status field)"}` } : { expected: '"accepted" | "no_active_turn"', actual: `${cancel.status} ${status}` }),
    });

    /* ---------------------------------------------------------------------- */
    /* malformed bodies are rejected rather than absorbed                      */
    /* ---------------------------------------------------------------------- */

    for (const [label, body] of [
      ["an empty body", ""],
      ["invalid JSON", "{not json"],
      ["JSON that is not an object", "[]"],
      ["an object with no message", "{}"],
    ]) {
      const res = await request("/eve/v1/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      // 4xx is the right answer. A 5xx is worse than a 4xx but still a refusal,
      // so it is reported as a note rather than conflated with success. The
      // failure being hunted is 2xx: silently accepting nonsense and starting a
      // run from it.
      const refused = res.status >= 400;
      t.ok(refused, `creating a session with ${label} is refused`, {
        ...(refused ? { actual: `${res.status}` } : { expected: "4xx", actual: `${res.status} ${res.text.slice(0, 160)}` }),
      });
      if (res.status >= 500) t.note(`${label} was refused with ${res.status} rather than a 4xx`);
    }
  },
};
