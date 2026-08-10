/**
 * Start, stream, follow up, cancel: the four things /chat claims, driven from
 * outside the browser over the exact routes the browser uses.
 *
 * probe 14 covers what the two mutations REFUSE, and says in its own header
 * what it cannot reach: "a long-running turn that cancel interrupts
 * mid-flight". That is the half the product sells, and it is also the half
 * with a warning attached. README.md:181-183:
 *
 *   Cancellation is cooperative. The cancel route returns 202 immediately but
 *   the in-flight model call keeps streaming - we measured ~90 seconds. Do not
 *   build a stop button that assumes silence.
 *
 * So the thing to pin is not "the turn stops". It is the shape of the promise:
 *
 *   - the 202 comes back fast, because it is an acknowledgement and not a join;
 *   - it does NOT claim the turn ended, in its status vocabulary or anywhere
 *     else in the body;
 *   - the turn has not, in fact, ended at the moment it returns;
 *   - and the session survives, because this is a stop button and not a kill.
 *
 * That last one is the difference between /chat and `Agent Runs can only
 * watch`: after cancelling you can still talk to the same session.
 *
 * NOT MODEL-DEPENDENT, despite starting a real turn. Every assertion is about
 * protocol and lifecycle. Nothing here reads what the model said, how long it
 * took, or whether it called a tool, and the one timing assertion is guarded
 * on the route having reported an active turn to cancel in the first place -
 * so on a stack with no provider it declines to measure rather than flaking.
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

/** Terminal turn events. Their absence right after the 202 is the point. */
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
  try {
    const response = await call(
      `/api/control/sessions/${encodeURIComponent(sessionId)}/stream?format=ndjson&startIndex=${startIndex}`,
      { signal: controller.signal },
    );
    if (!response.ok || !response.body) return { status: response.status, types };
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
    // Aborting the read is how the window ends; it is not a failure.
    return { status: 200, types };
  } finally {
    clearTimeout(timer);
  }
}

export default {
  id: "seam/browser-control-start-stream-followup-cancel",
  title: "cancel acknowledges without claiming the turn stopped, and the session survives it",
  needs: ["dashboard", "agent"],
  why:
    "Cancellation is the one control the README warns about: the 202 is an acknowledgement and " +
    "the model keeps streaming for up to about ninety seconds. Nothing had ever cancelled a turn " +
    "that was actually running, so neither the acknowledgement nor the survival of the session " +
    "was checked. A stop button that is really a request, presented as a stop, is how an operator " +
    "concludes the product ignored them.",

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
      "and never says the turn has stopped, because it has not",
      { expected: "an acknowledgement", actual: JSON.stringify(cancelled) },
    );
    t.ok(ackMs < 15_000, `the acknowledgement is fast, not a join (${ackMs}ms)`, {
      expected: "under 15s",
      actual: `${ackMs}ms - if cancel now blocks until the turn ends, README:181 is stale`,
    });
    t.note(`cancel acknowledged in ${ackMs}ms with status ${cancelled.status}`);

    /* ── the ~90 seconds README warns about ──────────────────────────────── */

    if (cancelled.status === "accepted") {
      // There WAS a turn to cancel, so the warning is in scope. Read the
      // stream for a moment: the turn must not already be over. Asserted in
      // this direction on purpose - it cannot flake on a slow model, and it
      // goes red exactly when someone makes cancellation synchronous, which is
      // the day README:181-183 and the chat banner both need rewriting.
      const after = await collect(sessionId, 3_000, -1);
      const ended = after.types.some((type) => TERMINAL.has(type));
      t.ok(
        !ended,
        "the turn is still going three seconds after the 202: cancellation is cooperative",
        {
          expected: "no terminal turn event yet",
          actual:
            `saw ${after.types.join(", ")}. If cancellation is now immediate that is an ` +
            "improvement, but README.md:181-183, the chat banner and this probe all describe " +
            "the old behaviour and have to change together.",
        },
      );
      t.note(`3s after cancel the stream carried: ${after.types.join(", ") || "(nothing)"}`);
    } else {
      t.note(
        "no active turn at cancel time, so the cooperative-tail assertion was not run - " +
          "expected on a stack with no model provider",
      );
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
