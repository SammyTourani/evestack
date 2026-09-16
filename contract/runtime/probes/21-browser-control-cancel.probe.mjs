/**
 * Drive start, stream, follow-up and cancellation through the browser's routes.
 * A 202 acknowledges a request; it does not prove a turn stopped. A terminal
 * event can arrive immediately or later, depending on the runtime/provider.
 * Pin acknowledgement vocabulary and continued access to durable history,
 * without requiring a minimum delay before termination.
 */
const DASHBOARD = process.env.EVESTACK_PROBE_DASHBOARD_URL?.replace(/\/$/, "") ?? null;
const AGENT = process.env.EVESTACK_PROBE_AGENT_URL?.replace(/\/$/, "") ?? null;
const USER = process.env.EVESTACK_PROBE_DASHBOARD_USER ?? null;
const PASSWORD = process.env.EVESTACK_PROBE_DASHBOARD_PASSWORD ?? null;

/** Long enough that a model is still working when cancel lands. */
const LONG_TASK =
  "Count from 1 to 400, one number per line, with no commentary and no skipping.";

/** The vocabulary chat-client.tsx switches on. Anything else is a new state. */
const CANCEL_STATUS = new Set(["accepted", "no_active_turn"]);

/** Terminal events the task workspace can render after an acknowledgement. */
const TERMINAL = new Set(["turn.cancelled", "turn.completed", "turn.failed", "session.failed"]);

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

/**
 * Read the durable stream for `windowMs` and return the event types seen.
 *
 * ?format=ndjson, which is what chat-client.tsx uses: the SSE transcode exists
 * for other consumers and probe 10 covers it. Reading the same format the page
 * reads is the point of driving it from here.
 */
async function collect(sessionId, windowMs, startIndex = 0) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), windowMs);
  const types = [];
  let opened = false;
  try {
    const response = await call(
      `/api/control/sessions/${encodeURIComponent(sessionId)}/stream?format=ndjson&startIndex=${startIndex}`,
      { signal: controller.signal },
    );
    if (!response.ok || !response.body) return { status: response.status, types };
    opened = true;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (typeof event.type === "string") types.push(event.type);
        } catch {
          // A half-written line is normal at a chunk boundary.
        }
      }
    }
    return { status: response.status, types };
  } catch {
    // Only our timer ending an opened stream is an expected read boundary.
    return { status: opened && controller.signal.aborted ? 200 : 0, types };
  } finally {
    clearTimeout(timer);
  }
}

export default {
  id: "seam/browser-control-start-stream-followup-cancel",
  title: "cancel acknowledges without claiming the turn stopped, and the session survives it",
  needs: ["dashboard", "agent"],
  why:
    "Cancellation acceptance must not claim termination. The stream may end immediately or " +
    "continue; the operator must still be able to inspect durable history and the follow-up response.",

  async available() {
    const missing = [];
    if (!DASHBOARD) missing.push("EVESTACK_PROBE_DASHBOARD_URL is not set");
    if (!AGENT) missing.push("EVESTACK_PROBE_AGENT_URL is not set");
    if (!USER || !PASSWORD) missing.push("EVESTACK_PROBE_DASHBOARD_{USER,PASSWORD} are not set");
    if (missing.length > 0) return missing;
    try {
      const health = await fetch(`${DASHBOARD}/api/health`, { signal: AbortSignal.timeout(5_000) });
      if (!health.ok) return [`${DASHBOARD}/api/health answered ${health.status}`];
      return [];
    } catch (error) {
      return [`cannot reach the dashboard: ${error.message}`];
    }
  },

  async run(t) {
    /* ── start ───────────────────────────────────────────────────────────── */

    const startResponse = await call("/api/control/sessions", {
      method: "POST",
      body: JSON.stringify({ message: LONG_TASK }),
      signal: AbortSignal.timeout(60_000),
    });
    const started = await json(startResponse);
    const sessionId = typeof started.sessionId === "string" ? started.sessionId : null;

    t.ok(startResponse.status === 202, "the browser can start a session", {
      expected: "202",
      actual: `${startResponse.status} ${JSON.stringify(started).slice(0, 200)}`,
    });
    // Anti-vacuity: without a session every check below would be about nothing,
    // and a probe that reports green having driven no session is the failure
    // this whole tier exists to prevent.
    if (sessionId === null) {
      t.ok(false, "no sessionId came back, so nothing below could be driven", {
        expected: "a session id",
        actual: JSON.stringify(started).slice(0, 300),
      });
      return;
    }
    t.ok(
      typeof started.streamUrl === "string" && started.streamUrl.includes(sessionId),
      "and is told where to stream it from",
      { expected: "a streamUrl naming the session", actual: String(started.streamUrl) },
    );

    /* ── stream ──────────────────────────────────────────────────────────── */

    const first = await collect(sessionId, 8_000);
    t.ok(first.status === 200, "the stream opens", {
      expected: "200",
      actual: String(first.status),
    });
    t.ok(
      first.types.length > 0,
      `and carries events (${[...new Set(first.types)].slice(0, 6).join(", ")})`,
      { expected: "at least one event", actual: "the stream was silent for 8s" },
    );

    /* ── cancel, while it is still working ───────────────────────────────── */

    const sentAt = Date.now();
    const cancelResponse = await call(
      `/api/control/sessions/${encodeURIComponent(sessionId)}/cancel`,
      { method: "POST", body: "{}", signal: AbortSignal.timeout(60_000) },
    );
    const cancelled = await json(cancelResponse);
    const ackMs = Date.now() - sentAt;

    t.ok(cancelResponse.status === 202, "cancel is accepted", {
      expected: "202",
      actual: `${cancelResponse.status} ${JSON.stringify(cancelled).slice(0, 200)}`,
    });
    t.ok(
      CANCEL_STATUS.has(cancelled.status),
      `and answers in the vocabulary the page switches on (${cancelled.status})`,
      { expected: "accepted or no_active_turn", actual: String(cancelled.status) },
    );
    // The word matters. "cancelled" or "stopped" here would be a claim the
    // route cannot support, and the page would be right to render silence.
    t.ok(
      !/cancelled|stopped|done|finished/i.test(JSON.stringify(cancelled)),
      "and never claims the acknowledgement proves the turn stopped",
      { expected: "an acknowledgement", actual: JSON.stringify(cancelled) },
    );
    t.ok(ackMs < 15_000, `the acknowledgement is fast, not a join (${ackMs}ms)`, {
      expected: "under 15s",
      actual: `${ackMs}ms - if cancel now blocks until the turn ends, README:181 is stale`,
    });
    t.note(`cancel acknowledged in ${ackMs}ms with status ${cancelled.status}`);

    if (cancelled.status === "accepted") {
      const after = await collect(sessionId, 3_000, -1);
      t.ok(after.status === 200, "the durable stream remains readable after acceptance", {
        expected: "200", actual: String(after.status),
      });
      const ended = after.types.filter((type) => TERMINAL.has(type));
      t.note(ended.length
        ? `A terminal event was already recorded: ${ended.join(", ")}. No minimum cancellation delay is promised.`
        : "No terminal event was observed in the next three seconds; cancellation remains unconfirmed.");
    } else {
      t.note("No active turn at cancellation time; the route correctly reported that state.");
    }

    /* ── a stop button, not a kill ───────────────────────────────────────── */

    // The claim on /chat is "send, approve, cancel", against a session that
    // survives. If cancelling ended the session, the page would be a
    // one-message form and Agent Runs could do the same job.
    const stream = await call(
      `/api/control/sessions/${encodeURIComponent(sessionId)}/stream?format=ndjson&startIndex=-1`,
      { signal: AbortSignal.timeout(10_000) },
    );
    const tail = stream.headers.get("x-eve-stream-tail-index");
    await stream.body?.cancel().catch(() => {});
    t.ok(
      stream.status === 200 && tail !== null && Number(tail) >= 0,
      "the session still exists after being cancelled",
      { expected: "200 with a tail index >= 0", actual: `${stream.status}, tail ${tail}` },
    );

    /* ── follow-up ───────────────────────────────────────────────────────── */

    const followUp = await call(
      `/api/control/sessions/${encodeURIComponent(sessionId)}/message`,
      {
        method: "POST",
        body: JSON.stringify({ message: "probe: a follow-up after cancelling" }),
        signal: AbortSignal.timeout(60_000),
      },
    );
    const follow = await json(followUp);
    // Three honest outcomes and no others. 409 session_busy is the real answer
    // while the cancelled turn is still winding down, and demanding a 2xx here
    // would be demanding that the ~90s tail not exist.
    const acceptable =
      (followUp.status >= 200 && followUp.status < 300) ||
      (followUp.status === 409 && ["session_busy", "session_terminal"].includes(follow.code));
    t.ok(
      acceptable,
      `a follow-up after cancel is accepted or honestly refused (${followUp.status} ${follow.code ?? ""})`,
      {
        expected: "2xx, or 409 session_busy / session_terminal",
        actual: `${followUp.status} ${JSON.stringify(follow).slice(0, 220)}`,
      },
    );
    if (followUp.status < 300) {
      t.ok(follow.sessionId === sessionId, "and continues the same session rather than starting one", {
        expected: sessionId,
        actual: String(follow.sessionId),
      });
    }

    // Leave nothing running. Best effort: the session is durable and the next
    // probe should not inherit a turn in flight.
    await call(`/api/control/sessions/${encodeURIComponent(sessionId)}/cancel`, {
      method: "POST",
      body: "{}",
      signal: AbortSignal.timeout(30_000),
    }).catch(() => {});
  },
};
