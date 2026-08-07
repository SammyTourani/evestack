import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * The two days a year the walker cannot assume a minute is a minute.
 *
 * Pinned to a real zone rather than the host's, because a suite that only ever
 * runs where nothing shifts is a suite that cannot see this class of bug at all —
 * and until this file existed, no test covered a transition day. `TZ` is set
 * before the module is loaded so the parser and the walker read the same zone;
 * node:test runs each file in its own process, so it cannot leak into the others.
 *
 * 2027-03-14 is the US spring forward (01:59 EST is followed by 03:00 EDT, and
 * 02:00–02:59 never happens) and 2027-11-07 is the fall back (01:00–01:59
 * happens twice).
 */
process.env.TZ = "America/New_York";
const { missedFires, nextFire } = await import("../dist/cron.js");

const clock = (date) =>
  `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ` +
  `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;

test("the zone is the one this file is about", () => {
  // Cheap guard: if setting TZ ever stops taking effect, every assertion below
  // would still pass in a zone without DST and prove nothing.
  assert.equal(new Date(2027, 0, 1).getTimezoneOffset(), 300);
  assert.equal(new Date(2027, 6, 1).getTimezoneOffset(), 240);
});

test("SPRING FORWARD: a 02:00 daily fires on the day 02:00 does not exist", () => {
  // Before the fix this answered Mar 15, skipping Mar 14 in silence: the walker
  // stepped by local minutes, so it went 01:59 -> 03:00 and never tested 02:00.
  // Vixie cron runs a job whose slot a forward jump ate, when the clock lands.
  assert.equal(clock(nextFire("0 2 * * *", new Date(2027, 2, 13, 12, 0))), "03-14 03:00");
  // And the day after is an ordinary 02:00 again.
  assert.equal(clock(nextFire("0 2 * * *", new Date(2027, 2, 14, 4, 0))), "03-15 02:00");
});

test("SPRING FORWARD: the erased fire is reported missed, so catch-up replays it", () => {
  // This is the half that matters after a restart. The fire was invisible twice
  // over — not the next fire, and not a missed one — so catch-up could not have
  // replayed it even in principle.
  const { fires } = missedFires("0 2 * * *", new Date(2027, 2, 13, 12, 0), new Date(2027, 2, 15, 12, 0));
  assert.deepEqual(fires.map(clock), ["03-14 03:00", "03-15 02:00"]);
});

test("SPRING FORWARD: an hour of erased slots is one fire, not one per slot", () => {
  // `*/15 2 * * *` wanted 02:00, 02:15, 02:30 and 02:45, and none of them
  // happened. That is one hour the schedule owes, not four fires — and four rows
  // would collide on (name, fire_at) anyway.
  const { fires } = missedFires("*/15 2 * * *", new Date(2027, 2, 13, 12, 0), new Date(2027, 2, 14, 12, 0));
  assert.deepEqual(fires.map(clock), ["03-14 03:00"]);
});

test("SPRING FORWARD: a per-minute schedule gets one fire per minute that exists", () => {
  // The jump must not double-count the minute it lands on: 03:00 matches on its
  // own, so the erased-slot check has to stay quiet about it.
  const { fires } = missedFires("* * * * *", new Date(2027, 2, 14, 1, 57), new Date(2027, 2, 14, 3, 2));
  assert.deepEqual(fires.map(clock), [
    "03-14 01:58",
    "03-14 01:59",
    "03-14 03:00",
    "03-14 03:01",
    "03-14 03:02",
  ]);
});

test("FALL BACK: the hour that happens twice fires once", () => {
  // Unchanged by the fix, and worth pinning: the fields are wall-clock fields, so
  // a 01:00 daily fires once on the day 01:00 comes round twice — not twice.
  const { fires } = missedFires("0 1 * * *", new Date(2027, 10, 6, 12, 0), new Date(2027, 10, 8, 12, 0));
  assert.deepEqual(fires.map(clock), ["11-07 01:00", "11-08 01:00"]);
});
