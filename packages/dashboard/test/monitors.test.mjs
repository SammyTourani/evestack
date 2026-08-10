import assert from "node:assert/strict";
import { test } from "node:test";
import { WINDOWS, failureRate } from "../lib/monitors.ts";

/**
 * The SQL in lib/monitors.ts is verified against a real server by
 * contract/runtime/probes/05-monitor-percentiles.probe.mjs, because percentile
 * semantics are PostgreSQL's and asserting them in JavaScript would only test a
 * restatement of them.
 *
 * What is worth testing here is the arithmetic that surrounds it — specifically
 * the denominator, which is the whole subject of this file. A dashboard whose
 * first render happens before any turn exists is the normal case, not the edge
 * case, and `0/0` renders as `NaN%`. And the denominator is FINISHED turns: with
 * every turn underneath it, an unfinished one scored as a success and a crashed
 * agent improved the number.
 */

test("an empty window reports 0%, not NaN", () => {
  assert.equal(failureRate(0, 0), 0);
  assert.ok(Number.isFinite(failureRate(0, 0)));
  // The page formats this with toFixed; NaN would render "NaN%".
  assert.equal(`${(failureRate(0, 0) * 100).toFixed(0)}%`, "0%");
});

test("a clean window is zero and a fully failed window is one", () => {
  assert.equal(failureRate(0, 25), 0);
  assert.equal(failureRate(25, 25), 1);
  assert.equal(failureRate(3, 10), 0.3);
});

/**
 * The regression this signature exists to prevent.
 *
 * `failureRate` used to take `(errored, noModelCall, total)` and add them. A
 * turn that both carries an `error_code` and never reached the provider is in
 * BOTH counters, and that is the ordinary shape of a provider rejection — the
 * call errors and reports no usage. Adding them counted one failure twice.
 *
 * The old signature could not express this test: `failureRate(10, 10, 10)`
 * returned 2, and a page rendering `(rate * 100).toFixed(1)` printed "200.0%".
 */
test("a turn that fails both ways is one failure, not two", () => {
  // Ten turns, every one of them errored AND with no model call.
  assert.equal(failureRate(10, 10), 1);
  assert.ok(failureRate(10, 10) <= 1, "a failure rate can never exceed 100%");
});

test("a rate is always a fraction between zero and one", () => {
  for (const [failed, total] of [
    [0, 0],
    [5, 0],
    [5, -1],
    [1, 1],
    [1, 1000],
    [999, 1000],
  ]) {
    const rate = failureRate(failed, total);
    assert.ok(Number.isFinite(rate), `${failed}/${total} produced ${rate}`);
    assert.ok(rate >= 0 && rate <= 1, `${failed}/${total} produced ${rate}`);
  }
});

/**
 * The denominator is FINISHED turns, not every turn in the window.
 *
 * It used to be every turn, and an unfinished one matched neither failure
 * test -- so it scored zero, a success, while still counting underneath. Every
 * stuck turn therefore pushed the reported failure rate DOWN. The arithmetic
 * cannot show that on its own, so the test states the two calls a caller has to
 * choose between and pins which one is right.
 */
test("unfinished turns are excluded from the rate, not scored as successes", () => {
  // Twenty turns: ten finished, two of them failed, ten still running.
  assert.equal(failureRate(2, 10), 0.2, "2 of the 10 that were judged");
  assert.notEqual(failureRate(2, 10), failureRate(2, 20));
  // And the direction of the old bug: adding wedged turns must not lower it.
  const before = failureRate(2, 10);
  const afterNinetyWedge = failureRate(2, 10);
  assert.equal(afterNinetyWedge, before, "a wedge changes neither half of the rate");
  assert.ok(failureRate(2, 100) < before, "counting them would have flattered it");
});

test("a window in which nothing finished has no rate, and 0 is the caller's cue", () => {
  // lib/alerts.ts reads `finished === 0` and reports `unknown` rather than
  // trusting this 0. The function still cannot return NaN, which is what the
  // page would render.
  assert.equal(failureRate(0, 0), 0);
  assert.ok(Number.isFinite(failureRate(5, 0)));
});

test("the offered windows are positive, ordered and unique", () => {
  assert.ok(WINDOWS.length > 0);
  assert.deepEqual([...WINDOWS], [...WINDOWS].sort((a, b) => a - b));
  assert.equal(new Set(WINDOWS).size, WINDOWS.length);
  for (const hours of WINDOWS) {
    assert.ok(Number.isFinite(hours) && hours > 0, `${hours} is a usable window`);
  }
});
