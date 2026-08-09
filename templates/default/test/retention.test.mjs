/**
 * The prune query is the most destructive thing this project ships. These are
 * the properties that make it safe, asserted against the SQL text itself.
 *
 * Testing SQL as a string is normally a poor substitute for running it, and this
 * file is honest about being the cheap half: the query WAS run, against a
 * database holding 3,322 real rows, inside a transaction that was rolled back —
 * 50 sessions selected, 245 runs / 2,442 events / 740 steps removed, and zero
 * events left whose `run_id` no longer resolved. What that run cannot do is stop
 * someone deleting a line six months from now, which is what these assertions
 * are for. Each one names the row loss it prevents.
 *
 * `parseWindow` gets real unit tests, because it is the input that decides how
 * much gets deleted and `90` on its own means ninety SECONDS to Postgres.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { orphanedFactsSql, parseWindow, previewSql, pruneSql } from "../scripts/retention.mjs";

test("nothing pending or running is ever deleted", () => {
  // The guard that protects an OPEN session: eve's session run stays 'running'
  // for as long as the session is open, and world-postgres re-enqueues active
  // runs on boot. Delete this clause and the prune eats live conversations.
  for (const sql of [previewSql(), pruneSql()]) {
    assert.match(sql, /count\(\*\) FILTER \(WHERE r\.status IN \('pending', 'running'\)\) = 0/);
  }
});

test("every workflow table is deleted from explicitly", () => {
  // There are no foreign keys in the workflow schema — verified against a live
  // database (zero contype='f' rows in the workflow namespace) and confirmed in
  // world-postgres's own migrations. A delete from workflow_runs alone orphans
  // events, steps, hooks, waits and stream chunks in silence.
  const sql = pruneSql();
  for (const table of [
    "workflow.workflow_events",
    "workflow.workflow_steps",
    "workflow.workflow_hooks",
    "workflow.workflow_waits",
    "workflow.workflow_stream_chunks",
    "workflow.workflow_runs",
  ]) {
    assert.match(sql, new RegExp(`DELETE FROM ${table.replace(".", "\\.")}\\b`), `${table} is not pruned`);
  }
});

test("the prune is one statement, so it cannot half-apply", () => {
  // Six deletes across six unrelated tables. Split into six statements they are
  // six transactions, and an interrupted run leaves rows pointing at runs that
  // are gone — with no foreign key to notice.
  const sql = pruneSql().trim();
  assert.equal(sql.split(";").length, 1, "pruneSql() must contain no statement separator");
  assert.match(sql, /^WITH prunable AS \(/);
});

test("timestamps are compared in UTC, never against a bare now()", () => {
  // workflow.workflow_runs timestamps are `timestamp without time zone` holding
  // UTC. A bare now() is timestamptz, so Postgres reinterprets the stored value
  // in the server's zone — four hours out under America/New_York, in the
  // direction that makes a recent session look old enough to delete. See
  // contract/contracts/21-naive-timestamps.contract.mjs.
  for (const sql of [previewSql(), pruneSql()]) {
    const bare = sql.replace(/\(now\(\) AT TIME ZONE 'utc'\)/g, "");
    assert.doesNotMatch(bare, /now\s*\(\s*\)/, "a bare now() survives in the prune SQL");
  }
});

test("lineage is $rootRunId, so eve's untagged timeout run goes with its session", () => {
  // $rootRunId is set by the workflow runtime on every run started inside
  // another run, including the sessionTimeoutWorkflow companion that carries no
  // $eve.* attributes at all. Grouping on $eve.parent instead leaves one orphan
  // run and its events behind per session, forever.
  for (const sql of [previewSql(), pruneSql()]) {
    assert.match(sql, /COALESCE\(r\.attributes ->> '\$rootRunId', r\.id\)/);
  }
});

test("only families rooted in an eve session are eligible", () => {
  // Without this, any root run in the table — including something a future eve
  // version starts for its own bookkeeping — would be treated as a session.
  for (const sql of [previewSql(), pruneSql()]) {
    assert.match(sql, /bool_or\(r\.attributes ->> '\$eve\.type' = 'session'/);
  }
});

test("the preview deletes nothing", () => {
  assert.doesNotMatch(previewSql(), /\bDELETE\b/i);
});

test("the fact cleanup only ever touches derived evestack tables", () => {
  // evestack.approvals is retained forever by design, and memories are not
  // session state. Both live in the same schema as the fact tables.
  const sql = orphanedFactsSql();
  assert.match(sql, /DELETE FROM evestack\.fact_turn\b/);
  assert.match(sql, /DELETE FROM evestack\.fact_tool_call\b/);
  for (const forbidden of ["approvals", "memories", "memory_deletions", "spans", "budget_"]) {
    assert.doesNotMatch(sql, new RegExp(forbidden), `${forbidden} must not appear in the fact cleanup`);
  }
  // And only rows whose source run is already gone.
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM workflow\.workflow_runs r WHERE r\.id = f\.run_id\)/);
});

test("parseWindow accepts the units people type", () => {
  assert.equal(parseWindow("90d"), "90 days");
  assert.equal(parseWindow("12h"), "12 hours");
  assert.equal(parseWindow("6mo"), "6 months");
  assert.equal(parseWindow("1y"), "1 years");
  assert.equal(parseWindow(" 2 weeks "), "2 weeks");
  assert.equal(parseWindow("30 days"), "30 days");
});

test("parseWindow rejects the ones that would delete more than they look like", () => {
  // Postgres reads a bare number as SECONDS, so `--older-than=90` would prune
  // everything older than a minute and a half while reading as "90 days".
  assert.throws(() => parseWindow("90"), /not a retention window/);
  // `m` is minutes to Postgres and months to most people: a factor of 43,200,
  // in the direction that deletes everything.
  assert.throws(() => parseWindow("6m"), /unrecognised unit/);
  assert.throws(() => parseWindow("0d"), /not a positive window/);
  assert.throws(() => parseWindow(""), /required/);
  assert.throws(() => parseWindow(undefined), /required/);
  assert.throws(() => parseWindow("last tuesday"), /not a retention window/);
});
