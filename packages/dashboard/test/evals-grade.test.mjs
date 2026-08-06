import assert from "node:assert/strict";
import { test } from "node:test";

import { gradeOf } from "../app/evals/grade.ts";

/**
 * Which sessions are worth turning into a test, and in what order.
 *
 * The `failed` grade was unreachable for the life of this page. It read
 * `session.status === "failed"`, and eve never fails a SESSION run — a turn
 * killed by a provider error is handled by the workflow, so the turn carries
 * the error_code and the session row stays `completed`. Measured on the seeded
 * month: zero sessions carry their own error_code, ninety-nine contain a failed
 * turn. The page's most valuable category was permanently empty and looked fine.
 */

const s = (turnCount) => ({ turnCount });

test("a session with a failed turn is the regression candidate", () => {
  assert.equal(gradeOf(s(3), [], 1), "failed");
  // ...and the session row's own status is irrelevant, which is the whole fix.
  assert.equal(gradeOf(s(3), [], 0), "plain");
});

test("a denial outranks a failure", () => {
  // A human said no to something. That path is the one that used to break the
  // durable session outright, so it is the most valuable thing to pin.
  assert.equal(gradeOf(s(3), ["bash"], 5), "denial");
});

test("an empty session is never promotable, whatever else is true of it", () => {
  assert.equal(gradeOf(s(0), ["bash"], 3), "empty");
});

test("a clean session is still worth pinning, just last", () => {
  assert.equal(gradeOf(s(1), [], 0), "plain");
});
