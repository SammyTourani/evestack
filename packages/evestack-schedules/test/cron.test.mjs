import assert from "node:assert/strict";
import { test } from "node:test";
import { describeCron, missedFires, nextFire, parseCron } from "../dist/cron.js";

/**
 * The parser is hand-written, so it earns its place only by being tested. These
 * cases are the ones that actually bite: the day-field OR rule, step syntax,
 * Sunday's two spellings, and the expressions that must be REFUSED rather than
 * guessed at.
 */

const at = (iso) => new Date(iso);

/**
 * Compare local clock fields, never `toISOString()`. Cron is evaluated in the
 * host's timezone — that is what the field means, and what eve's own runner
 * does — so an ISO comparison is testing the machine's UTC offset rather than
 * the parser. Cost me a red test to notice.
 */
const localHM = (date) =>
  `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;

test("every minute", () => {
  const next = nextFire("* * * * *", at("2026-03-10T09:15:30"));
  assert.equal(localHM(next), "09:16");
});

test("hourly at :00 rolls to the next hour", () => {
  const next = nextFire("0 * * * *", at("2026-03-10T09:15:00"));
  assert.equal(next.getHours(), 10);
  assert.equal(next.getMinutes(), 0);
});

test("daily at 09:00 skips to tomorrow when already past", () => {
  const next = nextFire("0 9 * * *", at("2026-03-10T10:00:00"));
  assert.equal(next.getDate(), 11);
  assert.equal(next.getHours(), 9);
});

test("step syntax: */15 gives quarter hours", () => {
  const fields = parseCron("*/15 * * * *");
  assert.deepEqual([...fields.minutes].sort((a, b) => a - b), [0, 15, 30, 45]);
});

test("bare-number step means 'from here to the end'", () => {
  // Vixie cron: 5/10 in minutes is 5,15,25,35,45,55 — NOT just 5.
  const fields = parseCron("5/10 * * * *");
  assert.deepEqual([...fields.minutes].sort((a, b) => a - b), [5, 15, 25, 35, 45, 55]);
});

test("weekday names and ranges", () => {
  const fields = parseCron("0 9 * * mon-fri");
  assert.deepEqual([...fields.daysOfWeek].sort(), [1, 2, 3, 4, 5]);
});

test("Sunday is both 0 and 7", () => {
  assert.deepEqual([...parseCron("0 0 * * 7").daysOfWeek], [0]);
  assert.deepEqual([...parseCron("0 0 * * 0").daysOfWeek], [0]);
});

test("month names", () => {
  assert.deepEqual([...parseCron("0 0 1 jan *").months], [1]);
});

test("THE OR RULE: both day fields restricted fires on either", () => {
  // `0 0 13 * 5` must fire on the 13th AND on every Friday. This is the rule
  // people get wrong, and eve's own runner follows it, so we must too.
  const fields = parseCron("0 0 13 * 5");
  assert.equal(fields.bothDaysRestricted, true);

  // 2026-03-13 is a Friday, so pick a month where the 13th is not.
  // 2026-04-13 is a Monday: matches by day-of-month only.
  const nextFromApril = nextFire("0 0 13 * 5", at("2026-04-10T00:00:00"));
  assert.equal(nextFromApril.getDate(), 13, "should fire on the 13th even though it is a Monday");

  // The Friday before it (2026-04-10 is a Friday) — from the 9th, the next
  // fire must be Friday the 10th, not the 13th.
  const nextFromNinth = nextFire("0 0 13 * 5", at("2026-04-09T00:00:00"));
  assert.equal(nextFromNinth.getDate(), 10, "should fire on a Friday even though it is not the 13th");
});

test("only one day field restricted behaves as plain AND", () => {
  const fields = parseCron("0 0 * * 5");
  assert.equal(fields.bothDaysRestricted, false);
  const next = nextFire("0 0 * * 5", at("2026-04-08T00:00:00"));
  assert.equal(next.getDay(), 5);
});

test("aliases", () => {
  assert.deepEqual([...parseCron("@daily").hours], [0]);
  assert.deepEqual([...parseCron("@weekly").daysOfWeek], [0]);
});

test("REFUSES six fields rather than silently dropping seconds", () => {
  assert.throws(() => parseCron("*/30 * * * * *"), /Seconds are not supported/);
});

test("REFUSES L, W, # and ?", () => {
  for (const expression of ["0 0 L * *", "0 0 15W * *", "0 0 * * 5#2", "0 0 ? * *"]) {
    assert.throws(() => parseCron(expression), /not supported/, `should refuse ${expression}`);
  }
});

test("REFUSES out-of-range and malformed values", () => {
  assert.throws(() => parseCron("60 * * * *"), /outside/);
  assert.throws(() => parseCron("0 24 * * *"), /outside/);
  assert.throws(() => parseCron("0 0 0 * *"), /outside/);
  assert.throws(() => parseCron("0 0 * 13 *"), /outside/);
  assert.throws(() => parseCron("nonsense * * * *"), /not a number/);
  assert.throws(() => parseCron("*/0 * * * *"), /step of 0/);
  assert.throws(() => parseCron("@nope"), /unknown cron alias/);
});

test("an impossible expression returns null instead of spinning", () => {
  // 30 February never happens.
  assert.equal(nextFire("0 0 30 2 *", at("2026-01-01T00:00:00")), null);
});

test("missedFires lists every tick in the gap", () => {
  const { fires, truncated } = missedFires(
    "0 * * * *",
    at("2026-03-10T09:00:00"),
    at("2026-03-10T13:30:00"),
  );
  assert.equal(truncated, false);
  assert.deepEqual(fires.map((f) => f.getHours()), [10, 11, 12, 13]);
});

test("missedFires caps and reports truncation", () => {
  const { fires, truncated } = missedFires(
    "* * * * *",
    at("2026-03-10T09:00:00"),
    at("2026-03-10T12:00:00"),
    5,
  );
  assert.equal(fires.length, 5);
  assert.equal(truncated, true);
});

test("missedFires is exclusive of the anchor and inclusive of the end", () => {
  const { fires } = missedFires("0 * * * *", at("2026-03-10T09:00:00"), at("2026-03-10T10:00:00"));
  assert.equal(fires.length, 1, "the anchor tick itself must not be replayed");
  assert.equal(fires[0].getHours(), 10);
});

test("describeCron is readable, and falls back rather than throwing", () => {
  assert.equal(describeCron("* * * * *"), "every minute");
  assert.equal(describeCron("*/5 * * * *"), "every 5 minutes");
  assert.equal(describeCron("0 * * * *"), "hourly at :00");
  assert.equal(describeCron("30 9 * * *"), "daily at 09:30");
  assert.match(describeCron("0 9 * * 1-5"), /mon/);
  assert.equal(describeCron("not a cron"), "not a cron");
});
