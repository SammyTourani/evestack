/**
 * `npm run dev` and `npm run start` must agree about where the agent listens.
 *
 * They did not. `dev` passed EVESTACK_AGENT_PORT through to eve as `--port`;
 * `start` was the bare string `"eve start"` and passed nothing, so a BUILT server
 * took eve's own default of 3000. Everything else in the project reads that
 * variable as the answer to "where is the agent" — `verify` probes it, and the
 * generated compose file points the dashboard's EVESTACK_AGENT_URL at it — so in
 * production all of them were looking somewhere the agent was not.
 *
 * Nothing caught it because nothing had ever run `npm run start`. Measured on a
 * real build: it bound 3000, which on that machine was an unrelated Next app, so
 * the built agent served nothing and said so nowhere, while verify reported
 * "nothing is answering at http://127.0.0.1:2041, the port this project records"
 * — a true sentence about the wrong port.
 *
 * Both scripts now build their argv here, so they cannot drift apart again.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { eveArgsWithPort } from "../template/scripts/checks.mjs";

test("the recorded port is applied to whichever command is being run", () => {
  assert.deepEqual(eveArgsWithPort("dev", [], "2041"), ["dev", "--port", "2041"]);
  assert.deepEqual(eveArgsWithPort("start", [], "2041"), ["start", "--port", "2041"]);
});

test("a port the caller typed wins, in both spellings", () => {
  // The pin is a default, not a rule. `--port N` and `--port=N` both count, which
  // is the case a naive equality check would miss and then double the flag.
  assert.deepEqual(eveArgsWithPort("start", ["--port", "9999"], "2041"), ["start", "--port", "9999"]);
  assert.deepEqual(eveArgsWithPort("start", ["--port=9999"], "2041"), ["start", "--port=9999"]);
});

test("no recorded port means eve's own default, untouched", () => {
  for (const pinned of [undefined, null, "", "   "]) {
    assert.deepEqual(eveArgsWithPort("start", [], pinned), ["start"], `for ${JSON.stringify(pinned)}`);
  }
});

test("other passthrough flags survive, and the port lands after them", () => {
  assert.deepEqual(eveArgsWithPort("dev", ["--host", "0.0.0.0"], "2041"), [
    "dev",
    "--host",
    "0.0.0.0",
    "--port",
    "2041",
  ]);
});

test("a padded recorded port is trimmed, not passed through as-is", () => {
  // .env.local is hand-editable, and `--port " 2041"` is not a port.
  assert.deepEqual(eveArgsWithPort("start", [], " 2041 "), ["start", "--port", "2041"]);
});

test("a flag that merely starts with the same letters is not mistaken for --port", () => {
  // `--portal` would have satisfied a `startsWith("--port")` check, suppressing
  // the pin for no reason. The real check requires `--port=`.
  assert.deepEqual(eveArgsWithPort("start", ["--portal"], "2041"), [
    "start",
    "--portal",
    "--port",
    "2041",
  ]);
});
