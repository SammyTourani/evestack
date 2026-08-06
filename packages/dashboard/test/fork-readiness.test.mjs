import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import "./register-ts-resolve.mjs";

const { getSessionSnapshot, parkedSince } = await import("../lib/agent-client.ts");

/**
 * A fork that replays three turns has to know when the fork is ready for the
 * next one. It used to answer that with "the continuation token changed",
 * because the token was believed to rotate on every turn boundary.
 *
 * It does not. Driven live against eve 0.30.8 on @workflow/world-postgres, a
 * session that ran two turns emitted three `session.waiting` events and every
 * one of them carried the SAME token — the one `POST /eve/v1/session` returned
 * when the session was created. So after the first follow-up the token check
 * could never come true again, and `POST /api/control/sessions/:id/fork` with
 * `fromTurn: 3` sat through its whole 90s per-turn timeout and returned
 * `{turnsDelivered: 2, complete: false, stopped: {atTurn: 3, code: "timeout"}}`
 * against a fork that was parked and ready the entire time.
 *
 * The transcript below is trimmed from that run. The first test is the fact
 * that broke the old rule; the second is the rule that replaces it.
 */

const TOKEN = "eve:e6d11595-32ac-4f2d-806b-637f2e92c83f";

const TRANSCRIPT = [
  { type: "session.started", data: { runtime: { eveVersion: "0.30.8" } } },
  { type: "turn.started", data: { turnId: "turn_0", sequence: 0 } },
  { type: "message.received", data: { turnId: "turn_0", message: "one" } },
  { type: "turn.completed", data: { turnId: "turn_0", sequence: 0 } },
  { type: "session.waiting", data: { continuationToken: TOKEN, wait: "next-user-message" } },
  { type: "turn.started", data: { turnId: "turn_1", sequence: 1 } },
  { type: "message.received", data: { turnId: "turn_1", message: "two" } },
  { type: "turn.completed", data: { turnId: "turn_1", sequence: 1 } },
  { type: "session.waiting", data: { continuationToken: TOKEN, wait: "next-user-message" } },
];

/**
 * eve serves the durable stream as NDJSON with the absolute tail index in a
 * header, so a stub only has to reproduce those two things.
 */
function stubAgent(events) {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(events.map((e) => JSON.stringify(e)).join("\n") + "\n", {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "x-eve-stream-tail-index": String(events.length - 1),
      },
    });
  return () => {
    globalThis.fetch = original;
  };
}

let restore;
afterEach(() => {
  restore?.();
  restore = undefined;
});

test("eve does not rotate the continuation token between turns", async () => {
  restore = stubAgent(TRANSCRIPT);
  const afterTurnTwo = await getSessionSnapshot("wrun_fork");
  restore();

  restore = stubAgent(TRANSCRIPT.slice(0, 5));
  const afterTurnOne = await getSessionSnapshot("wrun_fork");

  assert.equal(afterTurnOne.waiting, true);
  assert.equal(afterTurnTwo.waiting, true);
  assert.equal(
    afterTurnTwo.continuationToken,
    afterTurnOne.continuationToken,
    "if this ever fails eve started rotating tokens and the old rule would work again",
  );
  assert.ok(
    afterTurnTwo.tailIndex > afterTurnOne.tailIndex,
    "the stream position is the thing that does advance",
  );
});

test("a park further along the stream is ready; the one already spent is not", () => {
  const parked = {
    sessionId: "wrun_fork",
    continuationToken: TOKEN,
    waiting: true,
    terminal: false,
    pendingRequests: [],
    tailIndex: 8,
  };

  // Turn 2's park, having spent turn 1's park at index 4.
  assert.equal(parkedSince(parked, 4), true);

  // The race the old code was right to guard: the follow-up is accepted before
  // `turn.started` is durable, so the snapshot still describes the park we just
  // spent. Same tail index, so not ready.
  assert.equal(parkedSince(parked, 8), false);

  // Mid-turn: `turn.started` cleared `waiting`, so a growing stream is not a park.
  assert.equal(parkedSince({ ...parked, waiting: false, tailIndex: 12 }, 8), false);

  // Parked but no token published yet — nothing to send the next turn with.
  assert.equal(parkedSince({ ...parked, continuationToken: undefined }, 4), false);
});

test("the rule the fork used to apply cannot advance past the first follow-up", () => {
  // Kept as an executable statement of the bug: with a token that never
  // changes, "the token differs from the one I spent" is false at every park
  // after the first, which is why the replay hung instead of sending turn 3.
  const spentToken = TOKEN;
  const atSecondPark = { continuationToken: TOKEN };
  assert.equal(
    Boolean(atSecondPark.continuationToken && atSecondPark.continuationToken !== spentToken),
    false,
  );
});
