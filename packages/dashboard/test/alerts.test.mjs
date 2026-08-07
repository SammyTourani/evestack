import assert from "node:assert/strict";
import { test } from "node:test";

import { rankAlerts, THRESHOLDS } from "../lib/alerts.ts";

const a = (state, severity, id = `${state}-${severity}`) => ({
  id,
  title: id,
  severity,
  state,
  detail: "",
});

/**
 * The ordering IS the product here. An alert page is read top-down under time
 * pressure, so what sits at the top is the whole design decision.
 */
test("firing sorts above everything, whatever its severity", () => {
  const sorted = rankAlerts([a("ok", "page"), a("firing", "info")]);
  assert.equal(sorted[0].state, "firing");
});

test("'not checked' sorts above 'ok', which is the point of having three states", () => {
  // The Docker socket being unmounted means the question was never asked. If
  // that sorted below a list of passes, a reader scanning the top of the page
  // would see all-clear for something nothing ever looked at.
  const sorted = rankAlerts([a("ok", "page"), a("unknown", "info")]);
  assert.deepEqual(
    sorted.map((x) => x.state),
    ["unknown", "ok"],
  );
});

test("within one state, a page beats a warn beats an info", () => {
  const sorted = rankAlerts([a("firing", "info"), a("firing", "page"), a("firing", "warn")]);
  assert.deepEqual(
    sorted.map((x) => x.severity),
    ["page", "warn", "info"],
  );
});

test("ranking does not mutate its input", () => {
  const input = [a("ok", "page"), a("firing", "info")];
  const before = input.map((x) => x.id);
  rankAlerts(input);
  assert.deepEqual(
    input.map((x) => x.id),
    before,
  );
});

test("the shipped thresholds are quiet on a healthy install", () => {
  // Guards against someone "fixing" a noisy page by setting a threshold that
  // can never fire. Each of these has to be reachable by a real install.
  assert.ok(THRESHOLDS.failureRate > 0 && THRESHOLDS.failureRate < 1);
  assert.ok(THRESHOLDS.latencyP95Ms > 1000);
  assert.ok(THRESHOLDS.wedgedSessions >= 1);
  assert.ok(THRESHOLDS.scheduleFailingStreak >= 2, "one failure is not a streak");
});
