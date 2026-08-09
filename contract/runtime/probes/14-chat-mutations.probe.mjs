/**
 * The two buttons on the chat page, against a live dashboard and a live agent.
 *
 * `POST /api/control/sessions/[id]/message` and `.../cancel` are what
 * `app/chat/chat-client.tsx` calls on every send and every stop click, and
 * nothing ran either of them: no unit test, no contract, no probe, no CI step.
 * The seam probes already drive this exact stack for `/stream` (10),
 * `/approve` (11), `/fleet` (12) and `/ingest` (13). These two were the control
 * routes left out.
 *
 * ── The branch that makes this worth a probe ─────────────────────────────────
 *
 * The message route has four guards, and the fourth is the reason it exists:
 *
 *     // eve answers an unknown session id by *starting a new one* and
 *     // returning its id, rather than failing. Without this check a UI sending
 *     // to a stale id gets `{ok:true}` back while a second agent run spins up
 *     // and bills against a session nobody is watching.
 *
 * That is the shape this repository keeps finding — a 200 that is wrong — and
 * the only thing standing in front of it is a comparison in a route no test has
 * ever executed.
 *
 * ── What is reachable without a model key, and what is not ───────────────────
 *
 * CI runs with no provider key on purpose, so the first turn fails at the model
 * call within a second and the session goes TERMINAL. Every refusal below is
 * still reachable — the 401, the unknown-session 404, five malformed bodies, a
 * rejected continuation token, and cancel in all four of its shapes — because
 * none of them needs a turn that succeeded.
 *
 * The follow-up message is the one assertion whose ANSWER depends on the key,
 * and it accepts both: a 2xx where the session reached a waiting boundary, or
 * 409 `session_terminal` where it had already ended. Both are the route working;
 * the probe says which one it saw. Demanding the 2xx is what the first version
 * did, and it passed on a laptop with a key in
 * `templates/default/.env.local` and failed in CI — a probe that only passes
 * where a key happens to exist is a probe that tests the key.
 *
 * What is NOT reachable at all, and is not claimed: a long-running turn that
 * cancel interrupts mid-flight. `no_active_turn` is the honest answer for a turn
 * that already settled, and the route treats it as success for that reason.
 * Interrupting real work belongs to `eve eval`, which is gated on a key.
 */
const DASHBOARD = process.env.EVESTACK_PROBE_DASHBOARD_URL?.replace(/\/$/, "") ?? null;
const AGENT = process.env.EVESTACK_PROBE_AGENT_URL?.replace(/\/$/, "") ?? null;
const USER = process.env.EVESTACK_PROBE_DASHBOARD_USER ?? null;
const PASSWORD = process.env.EVESTACK_PROBE_DASHBOARD_PASSWORD ?? null;

const UNKNOWN = "wrun_00000000000000000000000000";

async function call(path, init = {}) {
  return fetch(`${DASHBOARD}${path}`, {
    ...init,
    headers: {
      authorization: `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

const json = async (response) => {
  try {
    return await response.json();
  } catch {
    return {};
  }
};

const message = (id, body) =>
  call(`/api/control/sessions/${encodeURIComponent(id)}/message`, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const cancel = (id, body = {}) =>
  call(`/api/control/sessions/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    body: JSON.stringify(body),
  });

/**
 * Wait until the session has reached a waiting boundary and published a
 * continuation token.
 *
 * Polls with the real route rather than a side channel, because two of the four
 * guards are exactly what a not-ready session answers, and a poll that gets one
 * has proved that guard works. Nothing is sent while they fire: the route
 * refuses before it reaches `continueSession`.
 *
 *   session_not_found  the id is real but no event has landed yet. eve indexes a
 *                      session's stream the moment it starts, and `tailIndex < 0`
 *                      means "nothing yet", which is indistinguishable from
 *                      "never existed" — see the route's own comment, and probe
 *                      11's header, which records the same 404 as a thing a
 *                      probe will otherwise read as a bug. The first version of
 *                      this helper did not retry on it and failed here.
 *   session_busy       a turn is in flight, so there is no continuation token to
 *                      resolve. Normal for the first second of a session.
 */
const NOT_READY = new Set(["session_not_found", "session_busy"]);

async function waitUntilAcceptingMessages(id, budgetMs = 25_000) {
  const deadline = Date.now() + budgetMs;
  let last = null;
  for (;;) {
    const response = await message(id, { message: "probe: follow-up" });
    const body = await json(response);
    last = { status: response.status, body };
    if (!NOT_READY.has(body.code)) return last;
    if (Date.now() > deadline) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
}

export default {
  id: "seam/chat-mutations-message-and-cancel",
  title: "the chat page's two mutations refuse what they must and work when they should",
  needs: ["dashboard", "agent"],
  why:
    "POST .../message and POST .../cancel are the dashboard's only write path to a running " +
    "conversation and nothing had ever run them. The message route's fourth guard exists " +
    "because eve answers an unknown session id by starting a NEW session and returning its id: " +
    "without the comparison, a stale id in a browser tab gets ok:true while a second agent run " +
    "spins up and bills against a session nobody is watching.",

  async available() {
    const missing = [];
    if (!DASHBOARD) missing.push("EVESTACK_PROBE_DASHBOARD_URL is not set");
    if (!AGENT) missing.push("EVESTACK_PROBE_AGENT_URL is not set");
    if (!USER || !PASSWORD) missing.push("EVESTACK_PROBE_DASHBOARD_{USER,PASSWORD} are not set");
    if (missing.length) return missing;
    try {
      const health = await fetch(`${DASHBOARD}/api/health`, { signal: AbortSignal.timeout(5_000) });
      if (!health.ok) missing.push(`${DASHBOARD}/api/health answered ${health.status}`);
    } catch (error) {
      missing.push(`cannot reach ${DASHBOARD}: ${error.message}`);
    }
    return missing;
  },

  async run(t) {
    /* ── the negative control, first ───────────────────────────────────────── */
    // Everything below sends a credential. If the routes answered the same way
    // without one, none of it would be evidence about anything.
    const anonymous = await fetch(`${DASHBOARD}/api/control/sessions/${UNKNOWN}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "probe" }),
    });
    t.ok(anonymous.status === 401, "an unauthenticated message is refused", {
      ...(anonymous.status === 401 ? {} : { expected: "401", actual: `${anonymous.status}` }),
    });

    /* ── an unknown session is not adopted ─────────────────────────────────── */

    const toUnknown = await message(UNKNOWN, { message: "probe" });
    const unknownBody = await json(toUnknown);
    t.ok(
      toUnknown.status === 404 && unknownBody.code === "session_not_found",
      "messaging a session that has never emitted an event is a 404, not a new session",
      toUnknown.status === 404 && unknownBody.code === "session_not_found"
        ? {}
        : {
            expected: '404 with code "session_not_found"',
            actual: `${toUnknown.status} ${JSON.stringify(unknownBody).slice(0, 200)}`,
          },
    );

    /* ── malformed bodies are refused, not absorbed ────────────────────────── */

    for (const [label, body] of [
      ["an empty body", ""],
      ["invalid JSON", "{not json"],
      ["JSON that is not an object", "[]"],
      ["an object with no message", "{}"],
      ["a message that is not a string or a message object", '{"message":42}'],
    ]) {
      const response = await message(UNKNOWN, body);
      const refused = response.status >= 400 && response.status < 500;
      t.ok(refused, `a message with ${label} is refused with a 4xx`, {
        ...(refused
          ? { actual: `${response.status}` }
          : {
              expected: "4xx",
              actual: `${response.status} — a 5xx is a crash and a 2xx started a run from nonsense`,
            }),
      });
    }

    /* ── a real session, and the happy path ────────────────────────────────── */

    const created = await call("/api/control/sessions", {
      method: "POST",
      body: JSON.stringify({ message: "probe: this turn is expected to fail at the model call" }),
    });
    const createdBody = await json(created);
    const id = typeof createdBody.sessionId === "string" ? createdBody.sessionId : null;

    t.ok(created.status === 202 && id !== null, "the dashboard starts a real durable session", {
      ...(created.status === 202 && id !== null
        ? {}
        : {
            expected: "202 carrying a sessionId",
            actual: `${created.status} ${JSON.stringify(createdBody).slice(0, 200)}`,
          }),
    });

    if (id === null) {
      // ANTI-VACUITY. Every assertion below is about that session; continuing
      // would emit a run of checks that pass by having nothing to look at.
      t.ok(false, "no session was created, so the write path below did not run", {
        expected: "a sessionId to send to",
        actual: "none — the remaining assertions in this probe did not execute",
      });
      return;
    }
    t.note(`session ${id}`);

    // TWO OUTCOMES ARE CORRECT HERE, AND WHICH ONE YOU GET DEPENDS ON A MODEL KEY.
    //
    // With a key the first turn runs, the session reaches a waiting boundary,
    // publishes a continuation token, and the follow-up is accepted. Without one
    // — which is CI, deliberately — the turn fails at the model call and the
    // session is TERMINAL within a second, so the route answers
    // 409 session_terminal: "This session has already ended; start a new one
    // instead of continuing it." That is the third of the four guards doing
    // exactly its job, not a failure.
    //
    // The first version of this assertion demanded a 2xx. It passed on the
    // machine it was written on and failed in CI, because that machine had
    // OPENAI_API_KEY in templates/default/.env.local and CI has no key on
    // purpose. A probe that only passes where a key happens to exist is a probe
    // that tests the key.
    //
    // So both are accepted and each is asserted for what it proves. What is
    // refused either way: a 5xx, and a 2xx that quietly acted on a different
    // session.
    const followUp = await waitUntilAcceptingMessages(id);
    const accepted = followUp.status >= 200 && followUp.status < 300;
    const terminal = followUp.status === 409 && followUp.body.code === "session_terminal";

    t.ok(
      accepted || terminal,
      "a follow-up is accepted, or refused because the session had already ended",
      accepted || terminal
        ? { actual: accepted ? `${followUp.status} accepted` : "409 session_terminal" }
        : {
            expected: "2xx, or 409 session_terminal",
            actual: `${followUp.status} ${JSON.stringify(followUp.body).slice(0, 200)}`,
          },
    );

    if (terminal) {
      t.note(
        "no model key on this agent: the first turn died at the model call and the session " +
          "went terminal, so this exercised the session_terminal guard rather than the accept path",
      );
    }

    // The token was resolved BY THE DASHBOARD, off the durable stream, which is
    // the whole reason the route lets a caller omit it. `resolvedContinuationToken`
    // being true is proof the session was real, was waiting, and had published a
    // token — none of which a refusal could have produced.
    if (accepted) {
      t.ok(
        followUp.body.sessionId === id && followUp.body.resolvedContinuationToken === true,
        "the follow-up went to the session that was asked for, on a token the dashboard resolved",
        followUp.body.sessionId === id && followUp.body.resolvedContinuationToken === true
          ? {}
          : {
              expected: `sessionId ${id} and resolvedContinuationToken true`,
              actual: JSON.stringify(followUp.body).slice(0, 200),
            },
      );
    }

    /* ── a continuation token that is not one ──────────────────────────────── */
    // The route maps eve's upstream 404 onto 409 `stale_continuation_token`,
    // because a stale token is the one failure a caller can act on. Supplying a
    // token also SKIPS the tailIndex guard above, so this is the path where the
    // session-mismatch check is the only thing left standing.
    const stale = await message(id, {
      message: "probe: bogus token",
      continuationToken: "ct_probe_not_a_real_token",
    });
    const staleBody = await json(stale);
    const mapped =
      stale.status >= 400 &&
      stale.status < 500 &&
      staleBody.ok === false &&
      typeof staleBody.error === "string";
    t.ok(mapped, "a continuation token the agent rejects becomes a 4xx that explains itself", {
      ...(mapped
        ? { actual: `${stale.status} ${staleBody.code ?? ""}` }
        : {
            expected: "4xx with ok:false and an error a caller can act on",
            actual: `${stale.status} ${JSON.stringify(staleBody).slice(0, 200)}`,
          }),
    });
    // And it must not have quietly started a second run under a different id,
    // which is the failure the session-mismatch guard exists to catch.
    t.ok(
      staleBody.startedSessionId === undefined || staleBody.startedSessionId === id,
      "a rejected token did not leave a second session running under another id",
      staleBody.startedSessionId === undefined || staleBody.startedSessionId === id
        ? {}
        : {
            expected: "no other session started",
            actual: `the agent started ${staleBody.startedSessionId} instead of continuing ${id}`,
          },
    );

    /* ── cancel ────────────────────────────────────────────────────────────── */

    const stopped = await cancel(id);
    const stoppedBody = await json(stopped);
    const known = stoppedBody.status === "accepted" || stoppedBody.status === "no_active_turn";
    t.ok(
      stopped.status >= 200 && stopped.status < 300 && known,
      "cancel answers 2xx in the vocabulary chat-client.tsx switches on",
      stopped.status >= 200 && stopped.status < 300 && known
        ? { actual: `${stopped.status} ${stoppedBody.status}` }
        : {
            expected: '2xx carrying "accepted" or "no_active_turn"',
            actual: `${stopped.status} ${JSON.stringify(stoppedBody).slice(0, 200)}`,
          },
    );

    t.ok(
      stoppedBody.sessionId === id,
      "cancel names the session it acted on, not one it started",
      stoppedBody.sessionId === id ? {} : { expected: id, actual: String(stoppedBody.sessionId) },
    );

    // Cancelling twice must stay a success. The button's whole job is to reach
    // "nothing is running", and a second click that errors trains an operator to
    // distrust the first.
    const again = await json(await cancel(id));
    t.ok(
      again.status === "accepted" || again.status === "no_active_turn",
      "cancelling an already-settled turn is still a success, not an error",
      again.status === "accepted" || again.status === "no_active_turn"
        ? { actual: again.status }
        : { expected: '"no_active_turn"', actual: JSON.stringify(again).slice(0, 200) },
    );

    // A cancel aimed at a session that does not exist must not come back as a
    // bare success. eve is entitled to refuse it; the dashboard is not entitled
    // to invent one.
    const phantom = await cancel(UNKNOWN);
    const phantomBody = await json(phantom);
    const honest =
      phantom.status >= 400 ||
      phantomBody.sessionId === UNKNOWN ||
      phantomBody.status === "no_active_turn";
    t.ok(honest, "cancelling an unknown session is refused or answered about that same id", {
      ...(honest
        ? { actual: `${phantom.status} ${phantomBody.status ?? ""}` }
        : {
            expected: "a refusal, or an answer naming the id that was asked for",
            actual: `${phantom.status} ${JSON.stringify(phantomBody).slice(0, 200)}`,
          }),
    });

    // A malformed cancel body is a 4xx, for the same reason the message ones
    // are: `turnId` is read off it, and a route that absorbs nonsense here
    // cancels a turn nobody named.
    const badCancel = await call(`/api/control/sessions/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      body: '{"turnId":42}',
    });
    t.ok(
      badCancel.status >= 400 && badCancel.status < 500,
      "a cancel whose turnId is not a string is refused with a 4xx",
      badCancel.status >= 400 && badCancel.status < 500
        ? { actual: `${badCancel.status}` }
        : { expected: "4xx", actual: `${badCancel.status}` },
    );
  },
};
