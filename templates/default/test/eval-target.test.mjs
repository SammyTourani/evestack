/**
 * `npm run eval` has to work on a project whose agent is running, because that
 * is the state the quickstart leaves you in.
 *
 * Measured on a clean scaffold, agent up on the recorded port:
 *
 *   npx eve eval smoke                    exit 1, A dev server is already
 *                                         running for this eve agent
 *   npx eve eval smoke --url http://...   1 passed, 1 gate, 3.6s
 *
 * eve boots its own dev server when it is not given a --url and refuses to boot
 * a second one for an app root that already has one, so the difference between
 * those two lines is the whole feature. These cases pin the argv, not the run:
 * whether the flag is added, and whether one the caller typed is left alone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { evalArgsWithTarget } from "../scripts/checks.mjs";

test("no running agent: eve boots its own dev server, so no --url is added", () => {
  assert.deepEqual(evalArgsWithTarget([], null), ["eval"]);
  assert.deepEqual(evalArgsWithTarget(["smoke"], null), ["eval", "smoke"]);
});

test("a running agent becomes the target, after the caller arguments", () => {
  assert.deepEqual(evalArgsWithTarget(["smoke"], "http://127.0.0.1:2001/"), [
    "eval",
    "smoke",
    "--url",
    "http://127.0.0.1:2001/",
  ]);
});

test("a --url the caller typed always wins, in either spelling", () => {
  const typed = "http://127.0.0.1:2998/";
  const found = "http://127.0.0.1:2001/";
  assert.deepEqual(evalArgsWithTarget(["deny-survives", "--url", typed], found), [
    "eval",
    "deny-survives",
    "--url",
    typed,
  ]);
  assert.deepEqual(evalArgsWithTarget([`--url=${typed}`], found), ["eval", `--url=${typed}`]);
});

test("the flag never lands twice, which eve would read as two targets", () => {
  const args = evalArgsWithTarget(["--url", "http://127.0.0.1:2998/"], "http://127.0.0.1:2001/");
  assert.equal(args.filter((a) => a === "--url").length, 1);
});
