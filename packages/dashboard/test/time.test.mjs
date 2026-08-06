import assert from "node:assert/strict";
import { test } from "node:test";
import { ago, clock, duration, stamp } from "../lib/time.ts";

/**
 * The defect these tests exist for is invisible in CI and in the container,
 * because both run with TZ=UTC. lib/db.ts installs a UTC parser for `timestamp
 * without time zone`, so lib/queries.ts already returns correct instants; the
 * session and evals pages then applied a *second* correction by reading
 * `getMonth()/getDate()/getHours()`, which are the host's zone. Asserting the
 * expected string under whatever zone the suite happens to run in would pass
 * against that broken code, so the assertions below set `process.env.TZ`
 * themselves — Node re-reads it per Date operation — and require the same
 * instant to format identically in Los Angeles and in UTC. There is no zone a
 * local-accessor formatter can pass that in.
 *
 * 2026-08-06T04:40:00Z is the instant RESEARCH.md measured the bug with: on a
 * PDT laptop the old code printed it as "Aug 5 21:40".
 */
const INSTANT = "2026-08-06T04:40:07.123Z";

function underTz(tz, fn) {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

const ZONES = ["America/Los_Angeles", "UTC", "Asia/Kolkata", "Pacific/Kiritimati"];

test("an instant formats the same in every host timezone", () => {
  for (const precision of ["day", "minute", "second", "millisecond"]) {
    const rendered = ZONES.map((tz) => underTz(tz, () => stamp(INSTANT, precision)));
    assert.deepEqual(
      new Set(rendered),
      new Set([rendered[0]]),
      `stamp(${precision}) drifted with the host zone: ${rendered.join(" | ")}`,
    );
  }
  const ticks = ZONES.map((tz) => underTz(tz, () => clock(INSTANT, "millisecond")));
  assert.deepEqual(new Set(ticks), new Set([ticks[0]]), ticks.join(" | "));
});

test("the instant printed is the one the database holds, in UTC", () => {
  // Not "Aug 5 21:40", which is what the local-accessor version printed in PDT.
  assert.equal(underTz("America/Los_Angeles", () => stamp(INSTANT)), "Aug 6 04:40 UTC");
  assert.equal(underTz("Asia/Kolkata", () => stamp(INSTANT, "second")), "Aug 6 04:40:07 UTC");
  assert.equal(
    underTz("Pacific/Kiritimati", () => stamp(INSTANT, "millisecond")),
    "Aug 6 04:40:07.123 UTC",
  );
  // A date with no time is the one case with no other anchor, so it keeps the year.
  assert.equal(underTz("America/Los_Angeles", () => stamp(INSTANT, "day")), "Aug 6, 2026 UTC");
});

test("every absolute stamp names its zone", () => {
  for (const precision of ["day", "minute", "second", "millisecond"]) {
    assert.match(stamp(INSTANT, precision), /UTC$/, `stamp(${precision}) hid its zone`);
  }
});

test("clock is time-of-day only, for axes that carry one UTC label", () => {
  assert.equal(underTz("America/Los_Angeles", () => clock(INSTANT)), "04:40");
  assert.equal(underTz("America/Los_Angeles", () => clock(INSTANT, "second")), "04:40:07");
  assert.equal(clock(INSTANT, "millisecond"), "04:40:07.123");
  // Milliseconds pad: 004, not 4 — spans in one step start in the same second.
  assert.equal(clock("2026-08-06T04:40:07.004Z", "millisecond"), "04:40:07.004");
  // A date-only tick would be a blank axis; fall back to the time.
  assert.equal(clock(INSTANT, "day"), "04:40");
});

test("a missing or unparseable instant renders as a dash, never as an epoch", () => {
  for (const bad of [null, "", "not a timestamp"]) {
    assert.equal(stamp(bad), "—");
    assert.equal(clock(bad), "—");
    assert.equal(ago(bad), "—");
  }
});

test("ago counts down from an explicit now", () => {
  const now = Date.parse("2026-08-06T04:40:07.123Z");
  assert.equal(ago(new Date(now - 5_000).toISOString(), now), "5s ago");
  assert.equal(ago(new Date(now - 90_000).toISOString(), now), "1m ago");
  assert.equal(ago(new Date(now - 3 * 3_600_000).toISOString(), now), "3h ago");
  assert.equal(ago(new Date(now - 2 * 86_400_000).toISOString(), now), "2d ago");
  // The zone the host runs in is not an input to elapsed time.
  assert.equal(
    underTz("America/Los_Angeles", () => ago(new Date(now - 3 * 3_600_000).toISOString(), now)),
    "3h ago",
  );
  // A future instant is skew between the database host and this one. The old
  // per-page copies printed "-8h ago" here, because the double correction put
  // every timestamp one UTC offset in the future.
  assert.equal(ago(new Date(now + 60_000).toISOString(), now), "just now");
});

test("duration is a span, so it has no zone and no negative", () => {
  assert.equal(duration(null), "—");
  assert.equal(duration(-1), "—");
  assert.equal(duration(Number.NaN), "—");
  assert.equal(duration(0), "0ms");
  assert.equal(duration(999.6), "1000ms");
  assert.equal(duration(1500), "1.5s");
  assert.equal(duration(65_000), "1m 05s");
  assert.equal(duration(3_600_000), "60m 00s");
});
