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

/**
 * Opens a streaming response and reports what happened, without ever waiting on
 * a body that may legitimately never end.
 *
 * `fetch` resolves once headers arrive, so the status is known immediately. The
 * body is then read incrementally until it ends or the window closes, which is
 * the only way to distinguish the three outcomes that matter: refused, alive and
 * saying something, and alive and saying nothing.
 */
async function openStream(path, windowMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), windowMs);
  try {
    const response = await fetch(`${BASE}${path}`, { signal: controller.signal });
    if (!response.body) {
      return { status: response.status, ended: true, bytes: 0 };
    }
    const reader = response.body.getReader();
    let bytes = 0;
    let ended = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          ended = true;
          break;
        }
        bytes += value?.byteLength ?? 0;
        // Anything at all is enough: the question is whether the stream speaks,
        // not how much it says. Stopping here also keeps a live stream from
        // holding the probe for the whole window.
        if (bytes > 0) break;
      }
    } catch {
      // Aborted by the timer — the stream was still open and silent.
    } finally {
      reader.cancel().catch(() => {});
    }
    return { status: response.status, ended, bytes };
  } catch (error) {
    // Aborted before headers ever arrived: the server accepted the connection
    // and said nothing at all, which is the worst of the three outcomes.
    if (error.name === "AbortError") return { status: 0, ended: false, bytes: 0 };
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

    // Status and body have to be judged separately, and the first version of
    // this probe did not — it awaited response.text(), which on a streaming
    // endpoint never resolves, then blamed the timeout on the session being
    // unknown. A live stream staying open is correct behaviour; the question is
    // only what it does for a session that never existed. fetch() resolves as
    // soon as headers arrive, so the status is available without reading a byte
    // of the body.
    const streamed = await openStream(`/eve/v1/session/${UNKNOWN}/stream`, STREAM_TIMEOUT_MS);

    t.note(`stream of an unknown session answered ${streamed.status}`);

    if (streamed.status >= 400) {
      // The unambiguous good outcome: refused outright.
      t.ok(true, "streaming an unknown session is refused with an error status");
    } else {
      // A 2xx here is not automatically wrong — but then it must SAY something.
      // A stream that reports success and then emits nothing, forever, is the
      // failure: a dashboard tab waits on an event that can never arrive, with
      // no error to render and nothing to retry.
      t.ok(
        streamed.ended || streamed.bytes > 0,
        `a ${streamed.status} stream for an unknown session either ends or emits something ` +
          `within ${STREAM_TIMEOUT_MS / 1000}s`,
        streamed.ended || streamed.bytes > 0
          ? { actual: streamed.ended ? "the stream ended" : `${streamed.bytes} bytes emitted` }
          : {
              expected: "a terminal event, or the stream closing",
              actual: "held open with zero bytes — a dashboard tab would wait forever with nothing to show",
            },
      );
    }

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
