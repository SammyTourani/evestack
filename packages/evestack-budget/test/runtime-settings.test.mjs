import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateBudgetPolicy,
  runtimeBudgetConfig,
} from "../dist/runtime-settings.js";

test("runtime budget policy validates caps and pins enforcement to strict controls", () => {
  const policy = validateBudgetPolicy({
    sessionUsd: 2,
    dailyUsd: 10,
    timeZone: "America/Toronto",
    mode: "observe",
    failClosed: false,
  });
  assert.equal(policy.mode, "fail");
  assert.equal(policy.failClosed, true);
  assert.equal(policy.preflight, true);
  assert.equal(policy.unpricedModel, "stop");
  for (const value of [NaN, Infinity, -1, "10", null, 1000001])
    assert.throws(() =>
      validateBudgetPolicy({
        sessionUsd: value,
        dailyUsd: 10,
        timeZone: "UTC",
      }),
    );
  assert.throws(() =>
    validateBudgetPolicy({
      sessionUsd: 1,
      dailyUsd: 10,
      timeZone: "Bogus/Zone",
    }),
  );
  assert.equal(
    validateBudgetPolicy({ sessionUsd: false, dailyUsd: 10, timeZone: "UTC" })
      .sessionUsd,
    false,
  );
});
test("existing agents keep their config without opening the dashboard settings store", async () => {
  const config = {
    sessionUsd: 2,
    dailyUsd: 10,
    dashboardControls: false,
    databaseUrl: "postgres://invalid:1/never-connect",
  };
  assert.equal(await runtimeBudgetConfig(config), config);
});
