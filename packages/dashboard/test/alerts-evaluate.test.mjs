import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";

import { STUCK_TURN_MS } from "../lib/facts.ts";
import { ORPHAN_AFTER_MS } from "../lib/sandboxes.ts";
import { THRESHOLDS, evaluateAlerts, wedgedAlert } from "../lib/alerts.ts";
import { installStubPool, uninstallStubPool, undefinedTable } from "./stub-pool.mjs";

/**
 * `evaluateAlerts` decides whether an operator gets paged, and until this file
 * nothing tested it.
 *
 * test/alerts.test.mjs covers `rankAlerts` and the threshold constants, which
 * are the two pure things in lib/alerts.ts. Everything that actually decides a
 * state lives in the 190 lines between them: nine checks, each folding a
 * database answer into `ok` / `firing` / `unknown`. The module's own header
 * (lib/alerts.ts:41-47) calls collapsing `unknown` into `ok` "the single most
 * dangerous thing an alerting page can do", and that claim was unenforced.
 *
 * ── What is being pinned, and why each one ───────────────────────────────────
 *
 *   THE WEDGE THRESHOLD IS DERIVED, NOT TYPED. The wedged query
 *   (lib/alerts.ts:377-385, whose own comment records this) used to carry a
 *   literal 15 minutes while sql/facts.sql, lib/fleet.ts and the `wedged`
 *   outcome all used STUCK_TURN_MS = 1 hour. Three surfaces then disagreed about
 *   the same turn: this alert counted turns the fleet banner called healthy, and
 *   its own "look at these" link — which filters the sessions list on the wedged
 *   outcome — led to a SHORTER list than the number it had just reported. The
 *   value now comes from lib/facts.ts, and the assertions below read both the
 *   SQL parameter and the prose, because a fix that changed only one of them
 *   would leave the page saying a number it did not measure.
 *
 *   AN EMPTY ANSWER AND AN UNANSWERABLE QUESTION ARE DIFFERENT. Every check has
 *   a branch for "there was nothing to measure". Getting one of those to return
 *   `ok` is exactly how a dashboard reports all-clear for something it never
 *   looked at, so each is asserted as `unknown` and separately asserted not to
 *   be `ok`.
 *
 *   THE FACT TABLE IS REFRESHED BEFORE IT IS SUMMED. `dailySpend()` read
 *   evestack.fact_turn with no refresh in front of it. Nothing about the result
 *   looked wrong — the spend figure was simply missing every turn since the last
 *   refresh, so the cap that exists to fire BEFORE you overspend did not fire.
 *   That defect is invisible in the returned alert and visible only in the order
 *   of the queries, which is why the stub records them.
 *
 * The stub pool (test/stub-pool.mjs) explains how the database is stood in for.
 */

/* ── fixtures ──────────────────────────────────────────────────────────────── */

/** One row of lib/monitors.ts's turn-statistics query. */
const turnStats = (over = {}) => [
  {
    total: 100,
    errored: 0,
    no_model_call: 0,
    failed: 0,
    p50: 1000,
    p75: 2000,
    p95: 3000,
    p99: 4000,
    max: 5000,
    count: 100,
    ...over,
  },
];

const SPEND_SQL = "FROM evestack.fact_turn";
const REFRESH_SQL = "evestack.refresh_facts";
const WEDGED_SQL = "completed_at IS NULL";
const TURN_STATS_SQL = "AS no_model_call";
// Deliberately the UTC-converted bound rather than the bare `interval '1 hour'`
// the two ingest queries share: the spans half uses a bare now() on purpose
// (evestack.spans is timestamptz), so the shorter fragment matched both halves
// and quietly answered the span count with the turn count.
const INGEST_TURNS_SQL = "(now() AT TIME ZONE 'utc') - interval '1 hour'";
const SPANS_SQL = "FROM evestack.spans WHERE received_at";

async function evaluate(routes = []) {
  const pool = installStubPool(routes);
  const alerts = await evaluateAlerts();
  const by = new Map(alerts.map((alert) => [alert.id, alert]));
  return { pool, alerts, by, get: (id) => by.get(id) };
}

/**
 * The environment is pinned for the whole file.
 *
 * Every one of these changes an outcome: the two budget variables decide whether
 * "Spend today" has a cap at all, and EVESTACK_DOCKER_SOCKET decides whether the
 * two sandbox checks are evaluated or reported `unknown`. A developer with any
 * of them set in their shell would otherwise see different alerts than CI.
 */
const CONTROLLED = [
  "EVESTACK_ALERT_DAILY_SPEND_USD",
  "EVESTACK_BUDGET_DAILY_USD",
  "EVESTACK_BUDGET_DISABLED",
  "EVESTACK_DOCKER_SOCKET",
];
const saved = {};

beforeEach(() => {
  for (const name of CONTROLLED) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  uninstallStubPool();
  for (const name of CONTROLLED) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

/* ── the shape of the page ─────────────────────────────────────────────────── */

test("every check reports, even when nothing can be answered", async () => {
  // Promise.allSettled, not all. A source that is down must report `unknown`
  // rather than taking the other eight with it — a page that renders nothing
  // because one check threw hides the seven that were fine and the one that was
  // firing.
  const { alerts } = await evaluate();
  assert.deepEqual(
    [...alerts].map((alert) => alert.id).sort(),
    [
      "daily_spend",
      "no_spans_while_active",
      "sandbox_long_lived",
      "sandbox_networked",
      "schedule_failing",
      "turn_failure_rate",
      "turn_latency_p95",
      "unpriced_spend",
      "wedged",
    ],
    "a check that disappears from the list is a check nobody notices is gone",
  );
});

test("one broken data source does not silence the others", async () => {
  const { get } = await evaluate([
    [TURN_STATS_SQL, new Error("connection terminated unexpectedly")],
    [WEDGED_SQL, [{ n: "4" }]],
  ]);
  assert.equal(get("turn_failure_rate").state, "unknown");
  assert.equal(get("turn_latency_p95").state, "unknown");
  assert.equal(get("wedged").state, "firing", "the wedge count still reached the page");
  assert.match(get("turn_failure_rate").detail, /Could not be evaluated/);
});

test("the answer is ranked, so the page never opens on a pass", async () => {
  const { alerts } = await evaluate([[WEDGED_SQL, [{ n: "1" }]]]);
  assert.equal(alerts[0].id, "wedged");
  assert.equal(alerts[0].state, "firing");
  assert.equal(alerts.at(-1).state, "ok", "and the passes sink");
});

/* ── wedged: the threshold that was typed twice ────────────────────────────── */

test("the wedge query asks Postgres for the shared threshold, in seconds", async () => {
  const { pool } = await evaluate();
  const [wedgeQuery] = pool.matching("make_interval(secs => $1)");
  assert.ok(wedgeQuery, "the wedged check no longer parameterises its interval");
  assert.deepEqual(
    wedgeQuery.params,
    [STUCK_TURN_MS / 1000],
    "a literal here is how this alert came to count turns the fleet banner called healthy",
  );
  assert.equal(wedgeQuery.params[0], 3600);
});

test("the prose quotes the same threshold the query used", async () => {
  // The number in the SQL and the number on the screen are one constant, so an
  // operator reading "none stalled past 1 hour" is reading what was measured.
  const { get } = await evaluate([[WEDGED_SQL, [{ n: "0" }]]]);
  const hours = STUCK_TURN_MS / 3_600_000;
  const label = `${hours} hour${hours === 1 ? "" : "s"}`;
  assert.equal(get("wedged").threshold, `none stalled past ${label}`);
  assert.match(get("wedged").detail, new RegExp(`within its first ${label}`));
  assert.ok(
    !/15 minutes/.test(`${get("wedged").detail} ${get("wedged").threshold}`),
    "the old hard-coded 15-minute wedge threshold is back in the prose",
  );
});

test("one wedged turn is the whole threshold, and zero is not", async () => {
  assert.equal(THRESHOLDS.wedgedSessions, 1, "this test is written against a threshold of one");

  const none = await evaluate([[WEDGED_SQL, [{ n: "0" }]]]);
  assert.equal(none.get("wedged").state, "ok");

  const one = await evaluate([[WEDGED_SQL, [{ n: "1" }]]]);
  assert.equal(one.get("wedged").state, "firing", "nothing in eve retries these, so one is enough");
  assert.match(one.get("wedged").detail, /^1 turn started/, "singular, for a count of one");

  const many = await evaluate([[WEDGED_SQL, [{ n: "12" }]]]);
  assert.equal(many.get("wedged").state, "firing");
  assert.match(many.get("wedged").detail, /^12 turns started/);
});

test("the wedge state and its sentence come from one condition, not two that agree", () => {
  /*
   * lib/alerts.ts:392 decided the STATE with `n >= THRESHOLDS.wedgedSessions`
   * and :394 decided the PROSE with `n > 0`. Those are the same question only
   * while the threshold is exactly 1 — which it is, so nothing was visibly
   * wrong and nothing would be until someone tuned it. At a threshold of 3 with
   * two turns stalled the alert reported `ok` and printed, word for word, the
   * sentence it prints when it fires.
   *
   * The threshold is a parameter of `wedgedAlert` for this test and only this
   * test: it is the sole way to reach the configuration where the split was
   * observable, and a test that can only run at the shipped value could not
   * have caught this and cannot catch it coming back.
   */
  assert.equal(THRESHOLDS.wedgedSessions, 1, "the shipped threshold, which hides this bug");
  assert.equal(wedgedAlert(0).state, "ok");
  assert.equal(wedgedAlert(1).state, "firing", "the default is still the shipped threshold");

  const below = wedgedAlert(2, 3);
  assert.equal(below.state, "ok");
  assert.notEqual(
    below.detail,
    wedgedAlert(2, 1).detail,
    "an `ok` row printed the firing sentence verbatim; the operator has to guess which half to believe",
  );
  assert.match(below.detail, /under the 3 it takes to fire/);
  assert.match(
    below.detail,
    /^2 turns started over .+ ago and never finished\./,
    "and the count is still reported, because two stalled turns are not zero",
  );

  // Not folded into the zero sentence: "every turn that started has finished"
  // would be a different lie, told about the same two turns.
  assert.match(wedgedAlert(0, 3).detail, /Every turn that started has finished/);

  for (const [n, threshold] of [
    [0, 1],
    [1, 1],
    [7, 1],
    [0, 3],
    [1, 3],
    [2, 3],
    [3, 3],
    [9, 3],
  ]) {
    const alert = wedgedAlert(n, threshold);
    const where = `n=${n} threshold=${threshold}`;
    assert.equal(alert.state, n >= threshold ? "firing" : "ok", where);
    assert.equal(
      /it takes to fire/.test(alert.detail),
      alert.state === "ok" && n > 0,
      `${where}: the sentence disagrees with the state it was printed next to`,
    );
  }
});

test("the wedge alert links to the list that shows the same turns", async () => {
  // The link is part of the claim: it filters the sessions list on the `wedged`
  // outcome, which sql/facts.sql computes from STUCK_TURN_MS. A link to an
  // unfiltered list made the operator count the rows themselves and find fewer
  // than the alert reported.
  const { get } = await evaluate([[WEDGED_SQL, [{ n: "3" }]]]);
  assert.equal(get("wedged").href, "/sessions?outcome=wedged");
});

test("a wedge count that cannot be read is unknown, never ok", async () => {
  const { get } = await evaluate([[WEDGED_SQL, undefinedTable("workflow.workflow_runs")]]);
  assert.equal(get("wedged").state, "unknown");
  assert.notEqual(get("wedged").state, "ok", "a check that could not run has not passed");
  assert.match(get("wedged").detail, /Could not be evaluated/);
});

/* ── turn failure rate: the boundary ───────────────────────────────────────── */

test("a failure rate exactly at the threshold does not page anyone", async () => {
  // `rate > THRESHOLDS.failureRate`, strictly. The documented promise is "at or
  // under 10%", and the alert's own `threshold` string says so — a `>=` here
  // would page an install sitting exactly on its stated budget.
  const at = Math.round(THRESHOLDS.failureRate * 100);
  const { get } = await evaluate([
    [TURN_STATS_SQL, turnStats({ total: 100, errored: at, failed: at })],
  ]);
  assert.equal(get("turn_failure_rate").state, "ok");
  assert.equal(get("turn_failure_rate").threshold, "at or under 10.0%");
});

test("one failure past the threshold fires", async () => {
  const past = Math.round(THRESHOLDS.failureRate * 100) + 1;
  const { get } = await evaluate([
    [TURN_STATS_SQL, turnStats({ total: 100, errored: past, failed: past })],
  ]);
  assert.equal(get("turn_failure_rate").state, "firing");
  assert.equal(get("turn_failure_rate").severity, "page");
  assert.match(get("turn_failure_rate").detail, /11\.0% of 100 turns failed/);
});

test("the detail names both ways a turn can fail, because they overlap", async () => {
  // lib/monitors.ts counts `failed` DISTINCT rather than errored + noModelCall,
  // since a provider rejection is usually both. The prose has to show the two
  // components or a reader adds them back up and gets a number over 100%.
  const { get } = await evaluate([
    [TURN_STATS_SQL, turnStats({ total: 10, errored: 5, no_model_call: 5, failed: 5 })],
  ]);
  assert.equal(get("turn_failure_rate").state, "firing");
  assert.match(get("turn_failure_rate").detail, /50\.0% of 10 turns failed/);
  assert.match(get("turn_failure_rate").detail, /5 carried an error code/);
  assert.match(get("turn_failure_rate").detail, /5 finished without ever reaching a model/);
});

test("no turns at all is unknown — there is no rate to be wrong about", async () => {
  const { get } = await evaluate([[TURN_STATS_SQL, turnStats({ total: 0, count: 0 })]]);
  assert.equal(get("turn_failure_rate").state, "unknown");
  assert.match(get("turn_failure_rate").detail, /no rate to judge/);
});

/* ── p95 latency: the boundary ─────────────────────────────────────────────── */

test("p95 exactly on the limit is ok and one millisecond past it fires", async () => {
  const limit = THRESHOLDS.latencyP95Ms;

  const on = await evaluate([[TURN_STATS_SQL, turnStats({ p95: limit })]]);
  assert.equal(on.get("turn_latency_p95").state, "ok");
  assert.equal(on.get("turn_latency_p95").threshold, `at or under ${limit / 1000}s`);

  const past = await evaluate([[TURN_STATS_SQL, turnStats({ p95: limit + 1 })]]);
  assert.equal(past.get("turn_latency_p95").state, "firing");
  assert.equal(past.get("turn_latency_p95").severity, "warn", "slow is not the same as broken");
});

test("nothing finished means no latency, which is unknown rather than fast", async () => {
  // toPercentiles returns null when count is 0. Reading that as a p95 of zero
  // would render the quietest possible install as the healthiest one.
  const { get } = await evaluate([[TURN_STATS_SQL, turnStats({ count: 0, p95: null })]]);
  assert.equal(get("turn_latency_p95").state, "unknown");
  assert.match(get("turn_latency_p95").detail, /no latency to measure/);
});

/* ── spend: an empty fact table versus a stale one ─────────────────────────── */

test("the fact table is refreshed before it is summed", async () => {
  // The regression this pins is silent: without the refresh the sum is missing
  // every turn since the last one, so the daily cap under-reports and the alert
  // that exists to fire before you overspend does not fire. Nothing about the
  // rendered alert looks wrong — only the order of the queries shows it.
  const { pool } = await evaluate();
  const refreshedAt = pool.firstIndexOf(REFRESH_SQL);
  const summedAt = pool.firstIndexOf(SPEND_SQL);
  assert.notEqual(refreshedAt, -1, "dailySpend() no longer refreshes the facts at all");
  assert.notEqual(summedAt, -1, "dailySpend() no longer reads the fact table");
  assert.ok(
    refreshedAt < summedAt,
    `refresh_facts ran at call ${refreshedAt} and the sum at ${summedAt}; the cap would be armed with stale money`,
  );
});

test("an empty fact table is a measured $0.00, not a shrug", async () => {
  const { get } = await evaluate([[SPEND_SQL, []]]);
  assert.equal(get("daily_spend").state, "ok");
  assert.match(get("daily_spend").detail, /^\$0\.00 of \$10\.00 spent today\./);
  assert.equal(get("unpriced_spend").state, "ok");
  assert.match(get("unpriced_spend").detail, /today's spend figure is complete/);
});

test("a fact table that cannot be refreshed is unknown on both money checks", async () => {
  // The dangerous direction. A refresh that throws used to be indistinguishable
  // from a quiet day, because both arrive as "no rows" if the failure is
  // swallowed — so the two checks are asserted to degrade together and to say
  // why, rather than to report a healthy $0.00 nobody measured.
  const { get } = await evaluate([[REFRESH_SQL, undefinedTable("evestack.refresh_facts")]]);
  assert.equal(get("daily_spend").state, "unknown");
  assert.equal(get("unpriced_spend").state, "unknown");
  for (const id of ["daily_spend", "unpriced_spend"]) {
    assert.match(get(id).detail, /Could not be evaluated/);
    assert.ok(!/\$0\.00/.test(get(id).detail), `${id} reported a dollar figure it never measured`);
  }
});

test("spend over the cap fires, and exactly at the cap does not", async () => {
  process.env.EVESTACK_ALERT_DAILY_SPEND_USD = "25";

  const at = await evaluate([[SPEND_SQL, [{ model: "m", priced: true, cost: "25", n: "5" }]]]);
  assert.equal(at.get("daily_spend").state, "ok", "`total > cap`, so the cap itself is allowed");
  assert.equal(at.get("daily_spend").threshold, "under $25.00/day");

  const over = await evaluate([[SPEND_SQL, [{ model: "m", priced: true, cost: "25.01", n: "5" }]]]);
  assert.equal(over.get("daily_spend").state, "firing");
  assert.match(over.get("daily_spend").detail, /\$25\.01 of \$25\.00 spent today\./);
});

test("the install-wide cap names no scope; the borrowed per-principal one does", async () => {
  // dailySpend() sums the whole INSTALL and @evestack/budget's cap is per
  // PRINCIPAL. They are the same number on a single-user install and a different
  // one the moment there are two, so the fallback says which it just compared.
  process.env.EVESTACK_ALERT_DAILY_SPEND_USD = "25";
  const own = await evaluate([[SPEND_SQL, []]]);
  assert.ok(!/per-principal/.test(own.get("daily_spend").detail));

  delete process.env.EVESTACK_ALERT_DAILY_SPEND_USD;
  const borrowed = await evaluate([[SPEND_SQL, []]]);
  assert.match(borrowed.get("daily_spend").detail, /per-principal daily cap/);
  assert.match(borrowed.get("daily_spend").detail, /EVESTACK_ALERT_DAILY_SPEND_USD/);
});

test("spend alerting switched off says so, and does not blame the budget", async () => {
  // Two different nulls out of dailySpendCap. Telling someone who deliberately
  // switched off spend alerting that their budget cap is missing sends them to
  // check a setting that is fine.
  process.env.EVESTACK_ALERT_DAILY_SPEND_USD = "false";
  const { get } = await evaluate([[SPEND_SQL, [{ model: "m", priced: true, cost: "3", n: "1" }]]]);
  assert.equal(get("daily_spend").state, "unknown");
  assert.match(get("daily_spend").detail, /EVESTACK_ALERT_DAILY_SPEND_USD=false/);
  assert.ok(!/@evestack\/budget/.test(get("daily_spend").detail));
  assert.match(get("daily_spend").detail, /^\$3\.00 so far today/, "the number is still reported");
});

test("budgets disabled entirely blames the budget, not the alert variable", async () => {
  process.env.EVESTACK_BUDGET_DISABLED = "1";
  const { get } = await evaluate([[SPEND_SQL, []]]);
  assert.equal(get("daily_spend").state, "unknown");
  assert.match(get("daily_spend").detail, /@evestack\/budget has no daily cap/);
});

test("a single unpriced turn is enough, because the bill is then unknown", async () => {
  // Not a cost threshold. Any unpriced traffic makes the spend figure wrong, and
  // every surface that forgets to read `priced` renders it as $0.00.
  const { get } = await evaluate([
    [
      SPEND_SQL,
      [
        { model: "priced-model", priced: true, cost: "4.50", n: "9" },
        { model: "mystery-model", priced: false, cost: null, n: "1" },
      ],
    ],
  ]);
  assert.equal(get("unpriced_spend").state, "firing");
  assert.match(get("unpriced_spend").detail, /^1 turn today ran a model with no catalog price/);
  assert.match(get("unpriced_spend").detail, /mystery-model/);
  assert.match(get("unpriced_spend").detail, /the \$4\.50 above excludes them entirely/);
  assert.equal(
    get("daily_spend").detail.startsWith("$4.50"),
    true,
    "the unpriced turn must not be counted as zero dollars in the total",
  );
});

/* ── priced is three states, and two of them are not "unpriced" ────────────── */

/**
 * `fact_turn.priced` is TRUE / FALSE / NULL (sql/facts.sql:155-158), written by
 * `CASE WHEN model IS NULL THEN NULL ELSE rate IS NOT NULL END` at
 * sql/facts.sql:515. NULL means no model call happened — the turn failed, was
 * cancelled, or was budget-stopped before it reached a provider.
 *
 * `dailySpend()` read the column with `if (r.priced) … else …`, which puts the
 * third state in the `else` and counts every turn that never reached a provider
 * as unpriced spend. The seeded month app/page.tsx:35 describes has 62 of them
 * in 1,922 turns, so the row would have been permanently red on a stack where
 * nothing was mispriced.
 */

test("a turn that never reached a provider is neither spend nor an unpriced model", async () => {
  const { get } = await evaluate([
    [
      SPEND_SQL,
      [
        { model: "priced-model", priced: true, cost: "4.50", n: "9" },
        // priced NULL only ever arrives with model NULL — the same CASE decides
        // both — so these rows cannot even be named in the prose.
        { model: null, priced: null, cost: null, n: "62" },
      ],
    ],
  ]);
  assert.equal(
    get("unpriced_spend").state,
    "ok",
    "62 failed turns are not an unpriced model, and this row cannot be acted on",
  );
  assert.match(get("unpriced_spend").detail, /today's spend figure is complete/);
  assert.ok(
    !/\(\)/.test(get("unpriced_spend").detail),
    "the empty parenthetical: the turns have no model to name, because there was no model",
  );
  assert.match(
    get("daily_spend").detail,
    /^\$4\.50 of /,
    "and a turn with no model call must not move the spend total either",
  );
});

test("a genuinely unpriced model is counted alone, not summed with the no-model-call turns", async () => {
  // The sharper half: without the three-way branch `unpricedTurns` is 2 + 62,
  // so the page reports 64 turns on a model it then names exactly one of.
  const { get } = await evaluate([
    [
      SPEND_SQL,
      [
        { model: "priced-model", priced: true, cost: "4.50", n: "9" },
        { model: "mystery-model", priced: false, cost: null, n: "2" },
        { model: null, priced: null, cost: null, n: "62" },
      ],
    ],
  ]);
  assert.equal(get("unpriced_spend").state, "firing");
  assert.match(
    get("unpriced_spend").detail,
    /^2 turns today ran a model with no catalog price \(mystery-model\)\./,
    "the count and the list have to describe the same population",
  );
  assert.match(get("daily_spend").detail, /^\$4\.50 of /);
});

/* ── trace ingest: the path that fails silently ────────────────────────────── */

test("turns running with no spans is the only symptom of a bad ingest token", async () => {
  const { get } = await evaluate([
    [INGEST_TURNS_SQL, [{ n: "7" }]],
    [SPANS_SQL, [{ n: "0" }]],
  ]);
  assert.equal(get("no_spans_while_active").state, "firing");
  assert.match(get("no_spans_while_active").detail, /7 turns ran in the last hour/);
  assert.match(get("no_spans_while_active").detail, /401/);
});

test("a quiet hour proves nothing either way, so it is unknown", async () => {
  const { get } = await evaluate([
    [INGEST_TURNS_SQL, [{ n: "0" }]],
    [SPANS_SQL, [{ n: "0" }]],
  ]);
  assert.equal(get("no_spans_while_active").state, "unknown");
  assert.match(get("no_spans_while_active").detail, /says nothing either way/);
});

test("a spans table that has never been created counts as zero spans, not an error", async () => {
  // evestack.spans is created lazily on first ingest. Not existing is the
  // strongest possible evidence that nothing has ever been exported — which is
  // precisely what this check is asking about.
  const { get } = await evaluate([
    [INGEST_TURNS_SQL, [{ n: "3" }]],
    [SPANS_SQL, undefinedTable("evestack.spans")],
  ]);
  assert.equal(get("no_spans_while_active").state, "firing");
  assert.ok(!/Could not be evaluated/.test(get("no_spans_while_active").detail));
});

/* ── the machine, and the schedules ────────────────────────────────────────── */

test("no Docker socket means the containers were never looked at", async () => {
  const { get } = await evaluate();
  for (const id of ["sandbox_networked", "sandbox_long_lived"]) {
    assert.equal(get(id).state, "unknown", `${id} reported a verdict about nothing`);
    assert.match(get(id).detail, /EVESTACK_DOCKER_SOCKET is not set/);
    assert.equal(get(id).href, "/sandboxes");
  }
  assert.equal(get("sandbox_networked").severity, "page");
});

test("the long-lived threshold has one home, and lib/alerts.ts reads it", () => {
  // This test used to assert only that the two numbers were EQUAL. They were —
  // both literal — and that is all an equality assertion can ever establish: it
  // proves two definitions agree today, it does not make them one definition.
  // `sandbox_long_lived` counts `concerns()` entries of kind `orphaned`, which
  // lib/sandboxes.ts:321 decides with ORPHAN_AFTER_MS, while every sentence the
  // alert printed about the limit came from a separate `sandboxLongLivedHours: 1`
  // in lib/alerts.ts. Raising one would have left the page stating a limit it
  // does not apply, and this assertion would have failed pointing at the symptom
  // rather than the cause.
  //
  // So the value is now derived from ORPHAN_AFTER_MS and the source is read to
  // prove it — the same move test/facts.test.mjs makes to pin STUCK_TURN_MS
  // against lib/fleet.ts, which does not export it.
  const source = readFileSync(new URL("../lib/alerts.ts", import.meta.url), "utf8");
  const match = /sandboxLongLivedHours: ([^,\n]+),/.exec(source);
  assert.ok(match, "lib/alerts.ts still declares sandboxLongLivedHours");
  assert.match(
    match[1],
    /ORPHAN_AFTER_MS/,
    `lib/alerts.ts types its own value (${match[1]}) instead of reading lib/sandboxes.ts's`,
  );
  assert.ok(
    !/longer than an hour/.test(source),
    "the passing sentence still spells the threshold out in words, where the constant cannot reach it",
  );
  assert.equal(
    THRESHOLDS.sandboxLongLivedHours * 3_600_000,
    ORPHAN_AFTER_MS,
    `the alert says ${THRESHOLDS.sandboxLongLivedHours}h and lib/sandboxes.ts filters at ${ORPHAN_AFTER_MS}ms`,
  );
});

test("a schedule table that has never existed is unknown, not 'no failures'", async () => {
  // failingSchedules() throws rather than returning an empty list here. The
  // first version of this check queried a run attribute eve does not write, so
  // it matched zero rows and reported "No schedule has a failing streak" on
  // every install forever — a monitor that cannot fire, counted among the passes.
  const { get } = await evaluate([["to_regclass('evestack.schedule_runs')", [{ exists: false }]]]);
  assert.equal(get("schedule_failing").state, "unknown");
  assert.match(get("schedule_failing").detail, /no schedule has ever run/);
});
