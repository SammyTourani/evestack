import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import "./register-ts-resolve.mjs";

const { POST } = await import("../app/api/control/sessions/[id]/cancel/route.ts");

/**
 * The stop button must not report success for a session that does not exist.
 *
 * eve answers a cancel with 202 `{status: "no_active_turn"}` for an id it has
 * never heard of, measured live. The route passed that through as 202
 * `{ok: true}`, so a typo looked like a cancelled run, while the message,
 * approve and stream routes all 404 the same id.
 *
 * A session that is merely parked is a different case and still a success: eve
 * returns `accepted` for it (also measured -- `no_active_turn` is not the
 * "nothing was running" answer the name suggests), and even an expired session
 * keeps its events, so only "no events at all" earns the 404.
 */

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

/**
 * Two upstream calls to fake: the cancel itself, and the tail read the route
 * uses to tell an unknown id from a real one.
 */
function stubAgent({ cancelStatus, tailIndex }) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const path = String(url);
    calls.push(path);
    if (path.endsWith("/cancel")) {
      return Response.json({ ok: true, sessionId: "wrun_x", status: cancelStatus }, { status: 202 });
    }
    return new Response("\n", {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "x-eve-stream-tail-index": String(tailIndex),
      },
    });
  };
  return calls;
}

const request = () =>
  new Request("http://dash/api/control/sessions/wrun_x/cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });

const context = { params: Promise.resolve({ id: "wrun_x" }) };

test("an id the agent has never seen is a 404, not a cancelled run", async () => {
  stubAgent({ cancelStatus: "no_active_turn", tailIndex: -1 });
  const response = await POST(request(), context);
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.ok, false);
  assert.equal(body.code, "session_not_found");
});

test("a session that exists keeps the outcome verbatim even when it is inactive", async () => {
  // Expired or otherwise unreachable, but real: its events are still there, so
  // the operator gets the agent answer rather than a misleading 404.
  stubAgent({ cancelStatus: "no_active_turn", tailIndex: 12 });
  const response = await POST(request(), context);
  const body = await response.json();

  assert.equal(response.status, 202);
  assert.equal(body.ok, true);
  assert.equal(body.status, "no_active_turn");
});

test("an accepted cancel does not pay for the extra tail read", async () => {
  const calls = stubAgent({ cancelStatus: "accepted", tailIndex: 5 });
  const response = await POST(request(), context);

  assert.equal(response.status, 202);
  assert.equal((await response.json()).status, "accepted");
  assert.equal(calls.length, 1, "expected only the cancel call: " + calls.join(", "));
});
