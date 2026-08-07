import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("a permanent record keeps its year", () => {
  assert.equal(
    underTz("America/Los_Angeles", () => stamp(INSTANT, "second", { year: true })),
    "Aug 6, 2026 04:40:07 UTC",
  );
  // The defect stated directly: without the year these two are one string, and
  // an audit table that cannot separate them has lost the fact it exists to keep.
  const lastYear = "2025-08-06T04:40:07.123Z";
  assert.equal(stamp(lastYear, "second"), stamp(INSTANT, "second"));
  assert.notEqual(stamp(lastYear, "second", { year: true }), stamp(INSTANT, "second", { year: true }));
  // Rolling views still pay nothing for it, and `day` does not print it twice.
  assert.equal(stamp(INSTANT, "second"), "Aug 6 04:40:07 UTC");
  assert.equal(stamp(INSTANT, "day", { year: true }), "Aug 6, 2026 UTC");
});

/**
 * The surfaces that are records rather than rolling views, and the value each
 * one stamps. `stamp` omits the year unless asked, so no input to the formatter
 * can prove these pages ask: the guard has to read the call site. Reading the
 * source is crude, but the alternative is a render harness for two table cells,
 * and the regression it catches — a formatter swap silently dropping the year
 * out of an audit log — is one that already happened once.
 */
const RECORDS = [
  ["app/approvals/page.tsx", "row.decidedAt"],
  ["app/schedules/schedules-client.tsx", "run.fireAt"],
];

test("the record surfaces ask stamp for the year", () => {
  for (const [file, value] of RECORDS) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const asksForTheYear = new RegExp(`stamp\\(\\s*${value.replace(".", "\\.")}[^)]*year:\\s*true`);
    // `assert.ok`, not `assert.match`: a failing match prints the whole page
    // source as the actual value and buries the one sentence that explains it.
    assert.ok(
      asksForTheYear.test(source),
      `${file} stamps ${value} without { year: true }, so two rows a year apart render identically`,
    );
  }
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
  // A future instant is clock skew between the database host and this one, and
  // only that: lib/db.ts hands every caller a corrected UTC instant, so elapsed
  // time has no zone bug left to inherit. Unguarded the subtraction prints
  // "-60s ago", which reads as a broken dashboard rather than as a skewed host.
  assert.equal(ago(new Date(now + 60_000).toISOString(), now), "just now");
});

test("duration is a span, so it has no zone and no negative", () => {
  assert.equal(duration(null), "—");
  assert.equal(duration(-1), "—");
  assert.equal(duration(Number.NaN), "—");
  assert.equal(duration(0), "0ms");
  assert.equal(duration(999.6), "1000ms");
  assert.equal(duration(65_000), "1m 05s");
  // One hour crosses into the hour tier; see "a duration longer than an hour".
  assert.equal(duration(3_600_000), "1h 00m");
});

test("duration holds three significant figures through the 1–10s decade", () => {
  // One decimal across the whole 1–60s range drops to two figures here, which
  // is where /monitors lives: these are real percentiles off the seeded
  // database (24h p50 and p75, and a bucket p95), and at one decimal they read
  // "4.9s", "9.6s" and "7.7s".
  assert.equal(duration(4946), "4.95s");
  assert.equal(duration(9598.5), "9.60s");
  assert.equal(duration(7681.25), "7.68s");
  assert.equal(duration(1500), "1.50s");
  // Ten seconds is where a hundredth stops being a significant figure.
  assert.equal(duration(10_000), "10.0s");
  assert.equal(duration(23_268.7), "23.3s");
});

/**
 * Durations above an hour.
 *
 * Not an edge case on this product. eve never closes a session — lib/queries.ts
 * and lib/monitors.ts both write that down — so an open session's age is the
 * ordinary value the detail page prints, and it is routinely days. Before these
 * tiers existed the page rendered a three-day-old session as "5277m 07s", and a
 * month-old one as "43200m 00s".
 */
test("a duration longer than an hour is readable", () => {
  assert.equal(duration(90_000), "1m 30s");
  assert.equal(duration(59 * 60_000), "59m 00s");
  assert.equal(duration(3_600_000), "1h 00m");
  assert.equal(duration(9 * 3_600_000), "9h 00m");
  assert.equal(duration(23.5 * 3_600_000), "23h 30m");
  assert.equal(duration(86_400_000), "1d 0h");
  assert.equal(duration(88 * 3_600_000), "3d 16h");
  assert.equal(duration(30 * 86_400_000), "30d 0h");

  // No tier may print a bare minute count above an hour.
  for (const ms of [3_600_000, 5 * 3_600_000, 88 * 3_600_000, 30 * 86_400_000]) {
    assert.doesNotMatch(duration(ms), /^\d{3,}m/, `${ms}ms rendered as a raw minute count`);
  }
});
