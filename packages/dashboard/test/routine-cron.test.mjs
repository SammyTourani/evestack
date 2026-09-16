import { test } from "node:test";
import assert from "node:assert/strict";
import { nextRoutineFires, previousRoutineFire } from "../lib/routine-cron.ts";

const next = (cron, zone, after, count = 1) =>
  nextRoutineFires(cron, zone, new Date(after), count).map((date) =>
    date.toISOString(),
  );
test("routine calendar uses its named zone independently of the process zone", () => {
  assert.deepEqual(
    next("0 9 * * 1-5", "America/Toronto", "2026-09-15T12:59:00Z", 3),
    [
      "2026-09-15T13:00:00.000Z",
      "2026-09-16T13:00:00.000Z",
      "2026-09-17T13:00:00.000Z",
    ],
  );
  assert.deepEqual(next("0 9 * * *", "Asia/Kolkata", "2026-09-15T00:00:00Z"), [
    "2026-09-15T03:30:00.000Z",
  ]);
});
test("spring gap runs once at the first valid minute", () => {
  assert.deepEqual(
    next("30 2 * * *", "America/Toronto", "2027-03-14T00:00:00Z", 2),
    ["2027-03-14T07:00:00.000Z", "2027-03-15T06:30:00.000Z"],
  );
  assert.deepEqual(
    next("0,15,30,45 2 * * *", "America/Toronto", "2027-03-14T00:00:00Z", 2),
    ["2027-03-14T07:00:00.000Z", "2027-03-15T06:00:00.000Z"],
  );
});
test("fall repeated time chooses only its first occurrence even after restart inside the fold", () => {
  assert.deepEqual(
    next("30 1 * * *", "America/Toronto", "2027-11-07T00:00:00Z", 2),
    ["2027-11-07T05:30:00.000Z", "2027-11-08T06:30:00.000Z"],
  );
  assert.deepEqual(
    next("30 1 * * *", "America/Toronto", "2027-11-07T06:00:00Z"),
    ["2027-11-08T06:30:00.000Z"],
  );
});
test("half-hour transitions follow the same gap and fold policy", () => {
  assert.deepEqual(
    next("15 2 * * *", "Australia/Lord_Howe", "2026-10-03T12:00:00Z"),
    ["2026-10-03T15:30:00.000Z"],
  );
  assert.deepEqual(
    next("45 1 * * *", "Australia/Lord_Howe", "2026-04-04T12:00:00Z", 2),
    ["2026-04-04T14:45:00.000Z", "2026-04-05T15:15:00.000Z"],
  );
});
test("latest missed fire uses the same calendar as preview", () => {
  const at = previousRoutineFire(
    "30 2 * * *",
    "America/Toronto",
    new Date("2027-03-14T12:00:00Z"),
  );
  assert.equal(at.toISOString(), "2027-03-14T07:00:00.000Z");
  assert.deepEqual(
    next(
      "30 2 * * *",
      "America/Toronto",
      new Date(at.getTime() - 1).toISOString(),
    ),
    [at.toISOString()],
  );
});
test("leap calendar, aliases, Vixie day OR, validation and impossible schedules", () => {
  assert.deepEqual(next("0 9 29 2 *", "UTC", "2026-01-01T00:00:00Z"), [
    "2028-02-29T09:00:00.000Z",
  ]);
  assert.deepEqual(next("@daily", "UTC", "2026-09-15T00:00:00Z"), [
    "2026-09-16T00:00:00.000Z",
  ]);
  assert.deepEqual(next("0 9 13 * FRI", "UTC", "2026-09-15T00:00:00Z"), [
    "2026-09-18T09:00:00.000Z",
  ]);
  assert.deepEqual(next("0 9 30 2 *", "UTC", "2026-01-01T00:00:00Z"), []);
  assert.throws(() =>
    next("* * * * *", "Invalid/Zone", "2026-01-01T00:00:00Z"),
  );
  assert.throws(() => next("* * * * * *", "UTC", "2026-01-01T00:00:00Z"));
});
