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
 * the denominator. A dashboard whose first render happens before any turn
 * exists is the normal case, not the edge case, and `0/0` renders as `NaN%`.
 */

test("an empty window reports 0%, not NaN", () => {
  assert.equal(failureRate(0, 0, 0), 0);
  assert.ok(Number.isFinite(failureRate(0, 0, 0)));
  // The page formats this with toFixed; NaN would render "NaN%".
  assert.equal(`${(failureRate(0, 0, 0) * 100).toFixed(0)}%`, "0%");
});

test("both failure kinds count toward the rate", () => {
  // error_code alone would report 10%, which is the direction that flatters us.
  assert.equal(failureRate(1, 1, 10), 0.2);
  assert.equal(failureRate(0, 3, 10), 0.3);
  assert.equal(failureRate(3, 0, 10), 0.3);
});

test("a clean window is zero and a fully failed window is one", () => {
  assert.equal(failureRate(0, 0, 25), 0);
  assert.equal(failureRate(25, 0, 25), 1);
  assert.equal(failureRate(10, 15, 25), 1);
});

test("a nonsensical denominator cannot produce a negative or infinite rate", () => {
  assert.equal(failureRate(5, 0, 0), 0);
  assert.equal(failureRate(5, 0, -1), 0);
  assert.ok(Number.isFinite(failureRate(5, 5, 0)));
});

test("the offered windows are positive, ordered and unique", () => {
  assert.ok(WINDOWS.length > 0);
  assert.deepEqual([...WINDOWS], [...WINDOWS].sort((a, b) => a - b));
  assert.equal(new Set(WINDOWS).size, WINDOWS.length);
  for (const hours of WINDOWS) {
    assert.ok(Number.isFinite(hours) && hours > 0, `${hours} is a usable window`);
  }
});
