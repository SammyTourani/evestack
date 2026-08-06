import assert from "node:assert/strict";
import { test } from "node:test";
import "./register-ts-resolve.mjs";

const { readCancelOutcome } = await import("../lib/cancel-outcome.ts");

/**
 * The Stop button used to throw the cancel response away and swallow the
 * throw, so every ending looked the same on screen: the banner stayed up, the
 * run finished in full, and no "Run cancelled." line ever appeared. A refused
 * cancellation and an accepted one were indistinguishable to the operator.
 *
 * The statuses here are the ones the agent really produces. Measured against
 * eve 0.30.8: a parked session with nothing running answers `accepted`, and
 * `no_active_turn` comes back when the command cannot be delivered to the
 * session at all -- for an unknown id the route now turns that into a 404.
 */

test("an accepted cancel is the only outcome that leaves the banner up", () => {
  assert.deepEqual(readCancelOutcome(202, { ok: true, status: "accepted" }), {
    kind: "cancelling",
  });
});

test("no_active_turn is not a cancellation and must clear the banner", () => {
  const outcome = readCancelOutcome(202, { ok: true, status: "no_active_turn" });
  assert.equal(outcome.kind, "nothing-to-cancel");
  assert.match(outcome.message, /no running turn/i);
});

test("a refusal carries the reason instead of pretending to have worked", () => {
  const outcome = readCancelOutcome(404, {
    ok: false,
    error: "No session 'wrun_typo' has emitted any events, so there was nothing to cancel.",
    code: "session_not_found",
  });
  assert.equal(outcome.kind, "refused");
  assert.match(outcome.message, /wrun_typo/);
});

test("a refusal with no message still says something a person can act on", () => {
  const outcome = readCancelOutcome(502, {});
  assert.equal(outcome.kind, "refused");
  assert.match(outcome.message, /502/);
});

test("an unfamiliar success status is treated as accepted, not as a failure", () => {
  // The agent may grow a third status. Guessing that it means failure would
  // stop a cancellation that is in fact running.
  assert.equal(readCancelOutcome(202, { ok: true, status: "queued" }).kind, "cancelling");
});
