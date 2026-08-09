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
    /* POSITIVE CONTROL, and it has to come first                              */
    /* ---------------------------------------------------------------------- */

    // EVERY OTHER ASSERTION IN THIS FILE IS A REFUSAL.
    //
    // "not 200", "status >= 400", "not ok:true" — read them together and the
    // probe says nothing about eve at all: a server that answered 401, or 404,
    // to every request in the world satisfied all seven checks and reported
    // green. That is the failure this tier is built to refuse, written into the
    // tier itself. `available()` did not close it either; it only required that
    // something answered / within 5s, at any status.
    //
    // So: one assertion that eve is up AND doing the right thing, before any
    // number of assertions about it doing the wrong thing correctly.
    //
    // /eve/v1/health rather than / — it is under the same prefix as every route
    // below, so a process that serves a landing page while the eve API is
    // unmounted or refusing fails here instead of sailing through. And it costs
    // nothing: no model call, no session, no row, which is the constraint the
    // header sets for this whole file.
    const alive = await request("/eve/v1/health");
    const healthy = alive.status >= 200 && alive.status < 300;
    t.ok(healthy, "the agent answers its own /eve/v1/health with a 2xx", {
      ...(healthy
        ? { actual: `${alive.status}` }
        : {
            expected: "2xx — otherwise every refusal below is satisfied by a server that refuses everything",
            actual: `${alive.status} ${alive.text.slice(0, 160)}`,
          }),
    });

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

    // One assertion covering both acceptable outcomes, rather than a branch
    // whose refusal arm was a literal `t.ok(true, ...)`. That arm was not wrong
    // — the `if` was doing the checking — but an assertion whose expression
    // cannot be false reads as a pass in the output and proves nothing on its
    // own line, which is the habit this tier exists to break.
    //
    // Refused outright is the unambiguous good outcome. A 2xx is not
    // automatically wrong, but then it must SAY something: a stream that reports
    // success and emits nothing, forever, leaves a dashboard tab waiting on an
    // event that can never arrive, with no error to render and nothing to retry.
    const refused = streamed.status >= 400;
    const spoke = streamed.ended || streamed.bytes > 0;
    t.ok(
      refused || spoke,
      `a stream for an unknown session is refused, ends, or emits something within ` +
        `${STREAM_TIMEOUT_MS / 1000}s`,
      refused || spoke
        ? {
            actual: refused
              ? `refused with ${streamed.status}`
              : `${streamed.status}, ${streamed.ended ? "stream ended" : `${streamed.bytes} bytes emitted`}`,
          }
        : {
            expected: "an error status, a terminal event, or the stream closing",
            actual: `${streamed.status} held open with zero bytes — a dashboard tab would wait forever with nothing to show`,
          },
    );

    /* ---------------------------------------------------------------------- */
    /* cancel answers in the vocabulary the dashboard switches on              */
    /* ---------------------------------------------------------------------- */

    const cancel = await request(`/eve/v1/session/${UNKNOWN}/cancel`, { method: "POST" });

    // The contract pins that CancelTurnStatus still *contains* these strings.
    // This checks that the running server actually answers in them, which is
    // what packages/dashboard/lib/agent-client.ts branches on.
    // `status === null` USED TO BE ACCEPTED HERE, and it made this assertion
    // unfailable in the one case it exists for. Any response without a `status`
    // field counted as "a status the dashboard knows how to read" — a 401, a
    // 404, a 500, all of them — and the passing detail rendered it out loud as
    //
    //     401 (no status field)
    //
    // printed under a green check. So the outcome is split by what actually
    // decides whether lib/agent-client.ts can do its job:
    //
    //   2xx  the dashboard will switch on `status`, so one of the two strings
    //        has to be there. A 200 with no status field is the exact shape that
    //        falls through that switch, and it now fails.
    //   4xx/5xx  a refusal for an id that does not exist is a legitimate answer;
    //        the dashboard never reaches the switch. Passes, and says so.
    //
    // Anything else — a 3xx, or a 0 from a timeout — is neither and fails.
    const status = cancel.json?.status ?? null;
    const answered = cancel.status >= 200 && cancel.status < 300;
    const known = answered
      ? status === "accepted" || status === "no_active_turn"
      : cancel.status >= 400;
    t.ok(known, "cancel either refuses, or answers in the vocabulary the dashboard switches on", {
      ...(known
        ? { actual: answered ? `${cancel.status} ${status}` : `refused with ${cancel.status}` }
        : {
            expected: answered
              ? '2xx carrying "accepted" or "no_active_turn"'
              : "a 4xx/5xx refusal, or a 2xx carrying a known status",
            actual: `${cancel.status} ${status ?? "(no status field)"}`,
          }),
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
