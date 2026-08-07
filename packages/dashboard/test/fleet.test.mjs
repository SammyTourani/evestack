/**
 * lib/fleet.ts — the arithmetic around the sweep, which is where both of its
 * bugs lived rather than in the SQL.
 *
 * The first was an interval Postgres refuses. `($1 || ' milliseconds')::interval`
 * is a text cast, so the number has to survive String(): JavaScript writes
 * exponent notation under 1e-6, and `GET /api/fleet?idleMinutes=1e-11` — which
 * passes the route's own `Number.isFinite && 0 <= x <= 43200` check untouched —
 * reached Postgres as "6e-7 milliseconds" and came back to the caller as a 500
 * carrying the failing SQL.
 *
 * The second was `unchecked`. FleetReport documents it as "candidates that
 * existed but were not probed", and it was computed as `rows.length - limit`
 * against a query that fetched `limit + 1` rows — so it was 0 or 1 and could not
 * arithmetically be anything else. 100 candidates with ?limit=25 reported 1.
 *
 * Neither needs Postgres to assert, which is the point: both survived review of
 * queries that were themselves correct.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { intervalMilliseconds, uncheckedCandidates } from "../lib/fleet.ts";

const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const MAX_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

test("the value that used to 500 is a threshold Postgres can read", () => {
  const value = intervalMilliseconds(1e-11 * 60_000);
  assert.equal(value, "0", "'idle for ~0 minutes' is what was asked for");
  assert.doesNotMatch(value, /e/i);
});

test("no threshold the route allows comes out in exponent form", () => {
  for (const minutes of [0, 1e-11, 1e-7, 0.0004, 0.5, 1, 29.999, 30, 1440, 43200]) {
    const value = intervalMilliseconds(minutes * 60_000);
    assert.match(value, /^\d+$/, `${minutes} minutes -> ${value}`);
  }
});

test("an absurd threshold is clamped, not written as 1e+30", () => {
  assert.equal(intervalMilliseconds(1e30), String(MAX_IDLE_MS));
  assert.match(intervalMilliseconds(Number.MAX_VALUE), /^\d+$/);
});

test("a threshold that is not a number falls back to the module's own default", () => {
  assert.equal(intervalMilliseconds(Number.NaN), String(DEFAULT_IDLE_MS));
  assert.equal(intervalMilliseconds(Number.POSITIVE_INFINITY), String(DEFAULT_IDLE_MS));
});

test("a negative threshold cannot become a negative interval", () => {
  assert.equal(intervalMilliseconds(-60_000), "0");
});

test("unchecked counts the candidates that were not probed", () => {
  // The documented case: 100 candidates, ?limit=25. The old answer was 1.
  const rows = Array.from({ length: 25 }, () => ({ candidate_count: "100" }));
  assert.equal(uncheckedCandidates(rows), 75);
});

test("pg hands a bigint count over as a string", () => {
  assert.equal(uncheckedCandidates([{ candidate_count: "3" }]), 2);
  assert.equal(uncheckedCandidates([{ candidate_count: 3 }]), 2);
});

test("a sweep that saw everything reports nothing left, and never NaN", () => {
  assert.equal(uncheckedCandidates([]), 0);
  assert.equal(uncheckedCandidates([{ candidate_count: "1" }]), 0);
  // A count below the rows in hand is impossible, and must not go negative.
  assert.equal(uncheckedCandidates([{ candidate_count: "0" }]), 0);
  for (const broken of [{}, { candidate_count: null }, { candidate_count: "many" }]) {
    const value = uncheckedCandidates([broken]);
    assert.ok(Number.isFinite(value), `${JSON.stringify(broken)} -> ${value}`);
    assert.equal(value, 0);
  }
});
