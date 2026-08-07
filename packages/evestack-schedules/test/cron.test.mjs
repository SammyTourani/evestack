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

test("day and month names are case-insensitive, as the doc promises", () => {
  // Every uppercase spelling of a Wednesday or a July used to throw. The
  // unsupported-syntax guard tested `/[LW#?]/` over the whole expression before a
  // single name had been resolved, and WED carries a W, JUL an L. `tracked()`
  // parses at wrap time, so `0 9 * * WED` took the agent down at import — for
  // syntax it does not use, with a diagnosis about a seconds field.
  assert.deepEqual([...parseCron("0 9 * * Wed").daysOfWeek], [3]);
  assert.deepEqual([...parseCron("0 9 * * WED").daysOfWeek], [3]);
  assert.deepEqual([...parseCron("0 9 * * wed").daysOfWeek], [3]);
  assert.deepEqual([...parseCron("0 9 * * MON-WED").daysOfWeek].sort((a, b) => a - b), [1, 2, 3]);
  assert.deepEqual([...parseCron("0 0 1 JUL *").months], [7]);
  assert.deepEqual([...parseCron("0 0 1 Jul *").months], [7]);
  assert.deepEqual([...parseCron("0 0 1 JAN-JUL *").months].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);
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

test("REFUSES L, W, # and ?, in either case, now that names are checked first", () => {
  // Lower case included: `0 0 l * *` is the same mistake and used to get the
  // vaguer "not a number or known name".
  const refused = ["0 0 L * *", "0 0 l * *", "0 0 15W * *", "0 0 15w * *", "0 0 * * 5#2", "0 0 ? * *", "0 0 * * 5L"];
  for (const expression of refused) {
    assert.throws(() => parseCron(expression), /not supported/, `should refuse ${expression}`);
  }
});

test("REFUSES a timezone for the timezone, not for seconds", () => {
  // `CRON_TZ=…` makes the expression six fields, so the seconds diagnosis fired
  // and told the author to delete a field they had never written.
  assert.throws(() => parseCron("CRON_TZ=America/New_York 0 9 * * *"), /carries a timezone/);
  assert.throws(() => parseCron("TZ=UTC 0 9 * * *"), /carries a timezone/);
  // A genuine sixth field still reads as seconds.
  assert.throws(() => parseCron("0 0 9 * * *"), /Seconds are not supported/);
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

test("describeCron never claims a broader schedule than the day fields allow", () => {
  // The bug this pins: the "every minute" and "hourly" branches read only the
  // minute and hour fields, so a schedule restricted to one day of the month was
  // described as if it ran every day. `* * 1 * *` fires 1,440 times a month and was
  // reported as "every minute" — 44,640 — on the page a user checks to find out how
  // often something runs. Same for `0 * * * 1`, which only fires on Mondays.
  assert.equal(describeCron("* * 1 * *"), "every minute on day 1");
  assert.equal(describeCron("* * * * 1"), "every minute on mon");
  assert.equal(describeCron("0 * 1 * *"), "hourly at :00 on day 1");
  assert.equal(describeCron("0 * * * 1"), "hourly at :00 on mon");
  assert.equal(describeCron("* * * 6 *"), "every minute in month 6");

  // And the unrestricted forms must not have grown a qualifier.
  assert.equal(describeCron("* * * * *"), "every minute");
  assert.equal(describeCron("0 * * * *"), "hourly at :00");
});

test("describeCron still answers the cases it already got right", () => {
  // Guarding against a fix that improves one branch by breaking another.
  assert.equal(describeCron("0 9 * * *"), "daily at 09:00");
  assert.equal(describeCron("*/15 * * * *"), "every 15 minutes");
  assert.equal(describeCron("not a cron expression"), "not a cron expression");
});

test("describeCron: an 'every N minutes' rate reads the day and month fields too", () => {
  // This is the branch the earlier fix missed, and the reason it survived: the
  // regression test above only ever asked about `*/15 * * * *`, which is not
  // restricted by anything. `*/15 * * * 1` is 96 fires a week, not 672.
  assert.equal(describeCron("*/15 * * * 1"), "every 15 minutes on mon");
  assert.equal(describeCron("*/15 * 1 * *"), "every 15 minutes on day 1");
  assert.equal(describeCron("*/5 * * * sun"), "every 5 minutes on sun");
  assert.equal(describeCron("*/30 * * jan *"), "every 30 minutes in month 1");
});

test("describeCron: a minute set that does not wrap at 60 is not a rate", () => {
  // `0-10/5` is evenly spaced inside the hour and fires three times an hour; it
  // was described as twelve. `0,1` fires twice and was described as sixty — and
  // as "every 1 minutes". Falling back to the raw expression is the honest
  // answer, so the label never claims more often than the truth.
  assert.equal(describeCron("0-10/5 * * * *"), "0-10/5 * * * *");
  assert.equal(describeCron("0,1 * * * *"), "0,1 * * * *");
  assert.equal(describeCron("1,2,3 * * * *"), "1,2,3 * * * *");
  // A set that wraps is still a rate, even offset: 5,15,25,35,45,55.
  assert.equal(describeCron("5/10 * * * *"), "every 10 minutes");
});

test("describeCron: 'daily' has to satisfy the month field as well", () => {
  // `0 9 * 1 *` fires 31 times a year and was reported as 365.
  assert.equal(describeCron("0 9 * 1 *"), "09:00 in month 1");
  assert.equal(describeCron("0 9 * * *"), "daily at 09:00");
});

test("describeCron: both day fields restricted reads as OR and names both halves", () => {
  // Vixie's rule again, on the label this time: `0 9 13 * 5` fires every Friday
  // AND every 13th, and the label printed only the weekday.
  assert.equal(describeCron("0 9 13 * 5"), "09:00 on fri or day 13");
  assert.equal(describeCron("* * 13 * 5"), "every minute on fri or day 13");
  // The other side of the same rule: a restricted weekday field that covers the
  // whole week is no restriction at all once it is OR-ed, so this is daily.
  assert.equal(describeCron("0 0 1 * 0-6"), "daily at 00:00");
});
