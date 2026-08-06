/**
 * The judgements, tested without a database.
 *
 * These cover the three places this tool could lie: calling a genuine failure a
 * process death, calling an inert leftover a fault, and calling a finished
 * conversation a wedged session. The third one is not hypothetical — the
 * dashboard's first classifier made exactly that mistake against real data.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyDeadJob, availabilityExpression, runIdExpression } from "../src/queue.mjs";
import { partitionDeadJobs, buildFindings, exitCodeFor } from "../src/findings.mjs";
import { classifySession, foldSnapshot, STUCK_TURN_MS } from "../src/sessions.mjs";
import { remediationSql } from "../src/remediate.mjs";

const deadRow = (over = {}) => ({
  id: 1,
  attempts: 3,
  max_attempts: 3,
  last_error: null,
  job_key: null,
  locked_at: null,
  locked_by: null,
  run_at: new Date(0),
  created_at: new Date(0),
  run_id: "wrun_a",
  sibling_claimable: 0,
  sibling_id: null,
  ...over,
});

/* -------------------------------------------------------------------------- */
/* dead jobs                                                                   */
/* -------------------------------------------------------------------------- */

test("a recorded last_error is a genuine failure, never a process death", () => {
  assert.equal(classifyDeadJob(deadRow({ last_error: "boom" })), "failed");
  // Even the empty string means failJob ran and wrote something.
  assert.equal(classifyDeadJob(deadRow({ last_error: "" })), "failed");
});

test("a NULL last_error with no claimable sibling is the process-death case", () => {
  assert.equal(classifyDeadJob(deadRow()), "process-death");
});

test("a live sibling job for the same run makes a dead row a retired leftover", () => {
  assert.equal(classifyDeadJob(deadRow({ sibling_claimable: 1, sibling_id: 9 })), "superseded");
});

test("a failed job stays failed even when a sibling exists — the error wins", () => {
  assert.equal(
    classifyDeadJob(deadRow({ last_error: "boom", sibling_claimable: 1 })),
    "failed",
  );
});

test("process death only counts as wedging when the run still expects to run", () => {
  const runs = new Map([
    ["wrun_live", { id: "wrun_live", status: "running" }],
    ["wrun_done", { id: "wrun_done", status: "completed" }],
  ]);
  const parts = partitionDeadJobs(
    [
      { ...deadRow({ id: 1, run_id: "wrun_live" }), kind: "process-death" },
      { ...deadRow({ id: 2, run_id: "wrun_done" }), kind: "process-death" },
      { ...deadRow({ id: 3, run_id: "wrun_missing" }), kind: "process-death" },
      { ...deadRow({ id: 4, run_id: null }), kind: "process-death" },
    ],
    runs,
  );
  assert.deepEqual(parts.wedging.map((j) => j.id), [1]);
  assert.deepEqual(parts.leftover.map((j) => j.id), [2]);
  assert.deepEqual(parts.unknownRun.map((j) => j.id), [3, 4]);
});

/* -------------------------------------------------------------------------- */
/* remediation                                                                 */
/* -------------------------------------------------------------------------- */

test("remediation resets attempts, guards on the state it was diagnosed in, and never auto-commits", () => {
  const sql = remediationSql([{ ...deadRow({ id: 42 }), run: { root: "wrun_session" } }], {
    schema: "graphile_worker",
    generatedAt: new Date("2026-08-05T00:00:00Z"),
  });
  assert.match(sql, /set attempts {2}= 0/);
  assert.match(sql, /where id = 42/);
  // The two guards are the whole reason this is safe to paste into psql later.
  assert.match(sql, /and attempts >= max_attempts/);
  assert.match(sql, /and last_error is null/);
  assert.match(sql, /^begin;$/m);
  assert.match(sql, /commit; {3}-- or: rollback;/);
  // The finding itself has to survive being read out of the SQL alone.
  assert.match(sql, /locked_at is already NULL/);
});

test("nothing is emitted when nothing is safe to fix", () => {
  assert.equal(remediationSql([], { schema: "graphile_worker" }), null);
});

test("a job id that is not an integer refuses to render rather than emitting broken SQL", () => {
  // pg hands bigints back as strings, so "42" is normal and must still work.
  assert.match(remediationSql([deadRow({ id: "42" })], { schema: "gw" }), /where id = 42\n/);
  assert.throws(
    () => remediationSql([deadRow({ id: "7; drop table jobs" })], { schema: "gw" }),
    /non-numeric job id/,
  );
});

test("a run id cannot break out of the comment it is printed in", () => {
  const sql = remediationSql([deadRow({ run_id: "wrun_a\ndrop table jobs; --" })], {
    schema: "gw",
  });
  assert.match(sql, /-- job 1: 3\/3 attempts spent, last_error NULL, run wrun_adroptablejobs--\n/);
  assert.doesNotMatch(sql, /\ndrop table/);
});

/* -------------------------------------------------------------------------- */
/* sessions — the 22-false-positives regression                                */
/* -------------------------------------------------------------------------- */

test("a session waiting with nothing outstanding is idle, not wedged, however long it has been", () => {
  const week = 7 * 24 * 60 * 60 * 1000;
  const result = classifySession({ terminal: false, waiting: true, pendingRequests: [] }, week);
  assert.equal(result.health, "idle");
});

test("a parked approval is awaiting-human, not wedged", () => {
  const result = classifySession(
    { terminal: false, waiting: true, pendingRequests: [{ requestId: "r1", kind: "tool-approval" }] },
    STUCK_TURN_MS * 10,
  );
  assert.equal(result.health, "awaiting-human");
  assert.equal(result.pendingCount, 1);
});

test("a turn in flight is only wedged after the hour threshold", () => {
  const inFlight = { terminal: false, waiting: false, pendingRequests: [] };
  assert.equal(classifySession(inFlight, STUCK_TURN_MS - 1).health, "active");
  assert.equal(classifySession(inFlight, STUCK_TURN_MS + 1).health, "wedged");
});

test("a terminal stream beats a stale `running` row", () => {
  assert.equal(
    classifySession({ terminal: true, waiting: false, pendingRequests: [] }, STUCK_TURN_MS * 10)
      .health,
    "active",
  );
});

test("a new turn retires a parked request; turn.completed does not", () => {
  // eve emits turn.completed BEFORE session.waiting on a HITL pause, so
  // completion cannot mean answered. Only turn.started does.
  const parked = foldSnapshot([
    { type: "input.requested", data: { requests: [{ requestId: "r1", kind: "question" }] } },
    { type: "turn.completed", data: {} },
    { type: "session.waiting", data: {} },
  ]);
  assert.equal(parked.pendingRequests.length, 1);
  assert.equal(classifySession(parked, STUCK_TURN_MS * 2).health, "awaiting-human");

  const answered = foldSnapshot([
    { type: "input.requested", data: { requests: [{ requestId: "r1", kind: "question" }] } },
    { type: "turn.started", data: {} },
    { type: "session.waiting", data: {} },
  ]);
  assert.equal(answered.pendingRequests.length, 0);
  assert.equal(classifySession(answered, STUCK_TURN_MS * 2).health, "idle");
});

test("an approved tool call is retired by its action.result", () => {
  const snapshot = foldSnapshot([
    {
      type: "input.requested",
      data: {
        requests: [{ requestId: "r1", kind: "tool-approval", action: { callId: "call_1" } }],
      },
    },
    { type: "action.result", data: { result: { callId: "call_1" } } },
  ]);
  assert.equal(snapshot.pendingRequests.length, 0);
});

/* -------------------------------------------------------------------------- */
/* findings                                                                    */
/* -------------------------------------------------------------------------- */

const basePre = {
  schema: "graphile_worker",
  workflowSchema: "workflow",
  hasWorkflowRuns: true,
  columns: new Set(["is_available", "payload", "last_error", "key"]),
};

const findingsFor = (input) =>
  buildFindings({ pre: basePre, health: { availabilityDerived: false }, limit: 50, ...input });

test("a clean queue produces no findings and exit 0", () => {
  const findings = findingsFor({});
  assert.deepEqual(findings, []);
  assert.equal(exitCodeFor(findings), 0);
});

test("a genuine failure is a warning that does not offer to reset attempts", () => {
  const findings = findingsFor({
    dead: [{ ...deadRow({ last_error: "TypeError: x" }), kind: "failed" }],
  });
  const failed = findings.find((f) => f.id === "failed-jobs");
  assert.equal(failed.severity, "warning");
  assert.match(failed.action, /NOT the process-death case/);
  // Exit 0: a job that failed on purpose is not an incident this tool declares.
  assert.equal(exitCodeFor(findings), 0);
});

test("a dead job blocking a live run is a fault and exits 1", () => {
  const findings = findingsFor({
    dead: [{ ...deadRow(), kind: "process-death" }],
    runs: new Map([["wrun_a", { id: "wrun_a", status: "running", root: "wrun_s" }]]),
  });
  const wedged = findings.find((f) => f.id === "wedged-jobs");
  assert.equal(wedged.severity, "critical");
  assert.match(wedged.action, /Clear `attempts`, not `locked_at`/);
  assert.equal(exitCodeFor(findings), 1);
});

test("a dead job whose run already finished is a note, not a fault", () => {
  const findings = findingsFor({
    dead: [{ ...deadRow(), kind: "process-death" }],
    runs: new Map([["wrun_a", { id: "wrun_a", status: "completed" }]]),
  });
  assert.equal(findings.find((f) => f.id === "leftover-jobs").severity, "info");
  assert.equal(exitCodeFor(findings), 0);
});

test("an unreachable agent produces one refusal to classify, not a pile of guesses", () => {
  const findings = findingsFor({
    sessions: {
      entries: [],
      agentReachable: false,
      agentError: new Error("connect ECONNREFUSED"),
      candidates: [{ sessionId: "wrun_1", title: null, idleMs: 99_999_999 }],
      idleMs: 1_800_000,
    },
  });
  const unclassified = findings.find((f) => f.id === "sessions-unclassified");
  assert.equal(unclassified.severity, "warning");
  assert.equal(findings.filter((f) => f.id === "wedged-sessions").length, 0);
  assert.match(unclassified.detail.join(" "), /22 healthy sessions/);
  assert.equal(exitCodeFor(findings), 0);
});

test("flooding is only raised above a floor, so a small queue stays quiet", () => {
  assert.equal(
    findingsFor({ ratio: { jobs: 6, distinct_runs: 1, ratio: 6, undecodable: 0 } }).length,
    0,
  );
  assert.equal(
    findingsFor({ ratio: { jobs: 60, distinct_runs: 10, ratio: 6, undecodable: 0 } })[0].id,
    "enqueue-flooding",
  );
});

test("every finding carries exactly one action sentence", () => {
  const findings = findingsFor({
    dead: [
      { ...deadRow({ id: 1 }), kind: "process-death" },
      { ...deadRow({ id: 2, last_error: "boom" }), kind: "failed" },
      { ...deadRow({ id: 3, sibling_claimable: 1, sibling_id: 9 }), kind: "superseded" },
    ],
    atRisk: [{ id: 4, attempts: 2, max_attempts: 3, locked_at: null, run_id: "wrun_a" }],
    locked: [
      {
        id: 5,
        attempts: 1,
        max_attempts: 3,
        locked_at: new Date(0),
        locked_by: "worker-1",
        locked_for_ms: 5 * 60 * 60 * 1000,
      },
    ],
    runs: new Map([["wrun_a", { id: "wrun_a", status: "running" }]]),
  });
  assert.ok(findings.length >= 5);
  for (const f of findings) {
    assert.equal(typeof f.action, "string", `${f.id} has no action`);
    assert.ok(f.action.length > 0, `${f.id} has an empty action`);
    assert.equal(
      f.action.split(/(?<=[.!?])\s+/).length,
      1,
      `${f.id} says more than one sentence: ${f.action}`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* SQL construction                                                            */
/* -------------------------------------------------------------------------- */

test("availability falls back to graphile's own definition when the column is gone", () => {
  assert.deepEqual(availabilityExpression(new Set(["is_available"])), {
    sql: "j.is_available",
    derived: false,
  });
  const derived = availabilityExpression(new Set());
  assert.equal(derived.derived, true);
  assert.match(derived.sql, /locked_at is null and j\.attempts < j\.max_attempts/);
});

test("run correlation guards the base64 before decoding and never casts to json", () => {
  const expression = runIdExpression(new Set(["payload"]));
  assert.match(expression, /\^\[A-Za-z0-9\+\/\]\+=\{0,2\}\$/);
  // A ::json cast would abort the whole diagnostic query on one bad row.
  assert.doesNotMatch(expression, /::json/);
  assert.equal(runIdExpression(new Set()), "null::text");
});
