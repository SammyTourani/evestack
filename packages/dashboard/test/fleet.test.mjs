import assert from "node:assert/strict";
import { test } from "node:test";
import { classifySession } from "../lib/fleet.ts";

/**
 * The fleet classifier has exactly two ways to be useless, and both have
 * happened. Calling a healthy session wedged trains its reader to ignore the
 * banner — the first version of lib/fleet.ts did that to 22 sessions. Calling a
 * wedged session healthy is the failure the module exists to catch.
 *
 * So every test here is a state or a boundary between two states, and the
 * inputs are the ones a real deployment produces rather than tidy ones:
 *
 *   - a stream with no events at all, which is what a live agent returns for a
 *     session it has never heard of (verified: it answers 200 with
 *     `x-eve-stream-tail-index: -1`, so the fold sees `waiting: false,
 *     terminal: false` — indistinguishable from a turn in flight);
 *   - a turn row that was created and never picked up, which has no
 *     `started_at` to measure an age from.
 *
 * EVERY SESSION THAT REACHES THIS FUNCTION HAS A TURN ROW THAT NEVER CLOSED —
 * `inspectFleet`'s query refuses the rest, so the 166-of-174 sessions whose
 * turns all finished are settled in SQL and never probed at all. That half is
 * asserted against a real server by
 * contract/runtime/probes/06-fleet-wedge-evidence.probe.mjs, because a
 * JavaScript test would only restate it.
 */

const HOUR = 60 * 60 * 1000;

const SILENT = { terminal: false, waiting: false, pendingRequests: [] };
const WAITING = { terminal: false, waiting: true, pendingRequests: [] };
const TERMINAL = { terminal: true, waiting: false, pendingRequests: [] };
const parked = (n) => ({
  terminal: false,
  waiting: false,
  pendingRequests: Array.from({ length: n }, (_, i) => ({ requestId: `r${i}`, kind: "tool-approval" })),
});

/* -- the states ------------------------------------------------------------ */

test("a waiting stream is idle, not wedged, however long it has been quiet", () => {
  // The 22-false-positives case. A session's run row stays `running` and its
  // stream stays `waiting` for the life of the conversation, so a month of
  // silence here is a healthy finished conversation.
  const got = classifySession(WAITING, 30 * 24 * HOUR, 30 * 24 * HOUR);
  assert.equal(got.health, "idle");
  assert.equal(got.pendingCount, 0);
});

test("an outstanding input request is awaiting-human, and the count is reported", () => {
  const one = classifySession(parked(1), 5 * HOUR, 5 * HOUR);
  assert.equal(one.health, "awaiting-human");
  assert.equal(one.pendingCount, 1);
  assert.match(one.reason, /parked on a decision/);

  const three = classifySession(parked(3), 5 * HOUR, 5 * HOUR);
  assert.equal(three.health, "awaiting-human");
  assert.equal(three.pendingCount, 3);
  assert.match(three.reason, /parked on 3 decisions/);
});

test("an ended session is idle — a session that is over has nothing in flight", () => {
  // This is the assertion that fails against the old code, which called a
  // terminal session `active`: same "not a fault" verdict, but it put a
  // finished conversation in the bucket that means a turn is burning tokens.
  const got = classifySession(TERMINAL, 9 * HOUR, 9 * HOUR);
  assert.equal(got.health, "idle");
  assert.notEqual(got.health, "active");
  assert.match(got.reason, /stale bookkeeping/);
});

test("an open turn row older than an hour is wedged", () => {
  const got = classifySession(SILENT, 6 * HOUR, 6 * HOUR);
  assert.equal(got.health, "wedged");
  assert.match(got.reason, /never finished/);
});

test("an open turn row that is minutes old is active, not wedged", () => {
  const got = classifySession(SILENT, 4 * 60 * 1000, 45 * 60 * 1000);
  assert.equal(got.health, "active");
  assert.equal(got.reason, "a turn is running");
});

/* -- the boundaries between them ------------------------------------------- */

test("the wedge threshold is exactly one hour of an OPEN turn", () => {
  assert.equal(classifySession(SILENT, HOUR - 1, 0).health, "active");
  assert.equal(classifySession(SILENT, HOUR, 0).health, "active");
  assert.equal(classifySession(SILENT, HOUR + 1, 0).health, "wedged");
});

test("the wedge is timed from the open turn, not from the session's idle time", () => {
  // A row touching the session recently must not disguise a turn that has been
  // open for four hours, and an old session must not manufacture a wedge out of
  // a turn that started a minute ago.
  assert.equal(classifySession(SILENT, 4 * HOUR, 60 * 1000).health, "wedged");
  assert.equal(classifySession(SILENT, 60 * 1000, 40 * HOUR).health, "active");
});

test("with no started_at to measure from, idle time is the fallback", () => {
  // A run row created and never picked up has completed_at AND started_at null,
  // so MIN(started_at) is null even though the row is genuinely open. Falling
  // back to idle time keeps a queued turn that has sat for a day visible
  // instead of silently healthy.
  assert.equal(classifySession(SILENT, null, 25 * HOUR).health, "wedged");
  assert.equal(classifySession(SILENT, null, 2 * 60 * 1000).health, "active");
});

test("the stream outranks the tables where the stream speaks", () => {
  // A turn row left open by a crash, on a session the agent says is waiting,
  // is stale bookkeeping — not a wedge. Reading SQL first would resurrect the
  // original 22-false-positive bug in a new place.
  assert.equal(classifySession(WAITING, 50 * HOUR, 50 * HOUR).health, "idle");
  assert.equal(classifySession(TERMINAL, 50 * HOUR, 50 * HOUR).health, "idle");
  assert.equal(classifySession(parked(2), 50 * HOUR, 50 * HOUR).health, "awaiting-human");
});

test("a parked session is awaiting-human even though its stream is not waiting", () => {
  // eve emits `turn.completed` BEFORE `session.waiting` on a HITL pause, so a
  // parked session is routinely caught mid-way with waiting still false. It is
  // not wedged and never has been.
  assert.equal(classifySession(parked(1), 9 * HOUR, 9 * HOUR).health, "awaiting-human");
});
