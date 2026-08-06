/**
 * `verify` must never report another project's dashboard as yours.
 *
 * The same bug as find-agent.test.mjs guards for the agent, on the other half of
 * the stack. The dashboard URL came from EVESTACK_DASHBOARD_URL, and when that was
 * unset the code fell back to a hardcoded `http://localhost:4000` and reported
 * whatever answered as a plain pass — "answering, database connected".
 *
 * `create` and `attach` both write the variable, so a generated project was right.
 * But it is documented as OPTIONAL (trace export is off by default, and
 * .env.example ships the line commented), so removing it is ordinary. Do that in a
 * project the scaffolder had to move to 4001 — because 4000 was already taken —
 * and the probe necessarily lands on the OTHER project's dashboard, connected to a
 * database this project has never written to. Observed: a green `dashboard` line
 * while this project's dashboard was not running at all.
 *
 * There is no recorded port to pin against here, so certainty is not available.
 * Honesty is: `recorded` says whether the answer came from configuration or from
 * a guess, and verify prints the difference.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { dashboardTarget, DEFAULT_DASHBOARD_URL } from "../template/scripts/checks.mjs";

test("a recorded ingest URL is believed, and reduced to its origin", () => {
  const target = dashboardTarget("http://127.0.0.1:4001/api/ingest/v1/traces");
  assert.equal(target.url, "http://localhost:4001");
  assert.equal(target.recorded, true);
  assert.equal(target.malformed, undefined);
});

test("a non-default port survives — this is the whole point", () => {
  // 4001 rather than 4000 is what the scaffolder writes when 4000 is busy, which
  // is exactly when guessing 4000 finds someone else.
  assert.equal(dashboardTarget("http://127.0.0.1:4044/api/ingest/v1/traces").url, "http://localhost:4044");
  assert.equal(dashboardTarget("https://agents.example.com/api/ingest/v1/traces").url, "https://agents.example.com");
});

test("nothing recorded means the default port, flagged as NOT recorded", () => {
  for (const missing of [undefined, null, "", "   "]) {
    const target = dashboardTarget(missing);
    assert.equal(target.url, DEFAULT_DASHBOARD_URL, `for ${JSON.stringify(missing)}`);
    assert.equal(target.recorded, false, "a guess must never claim to be recorded");
  }
});

test("a malformed URL is reported, not thrown", () => {
  // `new URL(...)` threw a bare TypeError out of the middle of verify, ending the
  // run rather than failing one check. A typo in .env.local should not do that.
  const target = dashboardTarget("localhost:4000/api/ingest/v1/traces");
  assert.equal(target.recorded, false);
  assert.equal(target.malformed, "localhost:4000/api/ingest/v1/traces");
  assert.equal(target.url, DEFAULT_DASHBOARD_URL);
});

test("127.0.0.1 is rewritten to localhost, and only in the host", () => {
  // Cosmetic but load-bearing: the URL is printed for a human to click, and
  // browsers treat `localhost` as the more trustworthy origin of the pair.
  assert.equal(dashboardTarget("http://127.0.0.1:4000/api/ingest/v1/traces").url, "http://localhost:4000");
  // A port that merely contains the digits must not be mangled.
  assert.equal(dashboardTarget("http://192.168.1.9:4000/api/ingest/v1/traces").url, "http://192.168.1.9:4000");
});
