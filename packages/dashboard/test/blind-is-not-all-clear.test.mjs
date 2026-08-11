/**
 * One rule, applied to every surface in this package that renders a verdict:
 *
 *     A SIGNAL THAT COULD NOT LOOK MUST NOT READ AS ALL-CLEAR.
 *
 * ── Why one file rather than four more per-surface tests ─────────────────────
 *
 * The same defect was found four separate times, by four people looking at four
 * unrelated subsystems, and each was fixed on its own:
 *
 *   1. GET /api/fleet answered `{"wedged":0,"unknown":0,"checked":0}` whether
 *      the stack was healthy or the agent was dead — the same bytes for "I
 *      examined the fleet and it is well" and "I examined nothing".
 *   2. The turn failure rate was `CASE WHEN outcome IN ('failed',
 *      'no_model_call') THEN 1 ELSE 0 END`, which scored a `running` or
 *      `wedged` turn as 0 — a SUCCESS — while keeping it in the denominator. On
 *      a 50-turn fixture that read 6% and `ok` where the truth was 30% and
 *      `firing`. A crashed agent improved the number.
 *   3. GET /api/health answered `healthy` for two hours against a database it
 *      could not read, while every trace page was empty.
 *   4. The trace-ingest monitor reported `ok, 109 spans arrived in the last
 *      hour` on an install whose ingest endpoint was answering 503 to every
 *      batch, and would then have fired with bad-ingest-token advice, sending
 *      someone to rotate a credential that was fine.
 *
 * Four independent discoveries of one habit is not four bugs, and patching four
 * sites does not stop the fifth. The fifth was already here: the fleet BANNER,
 * the component instance 1 was fixed FOR, caught a failed sweep and returned
 * `null` — byte-for-byte what it renders when nothing is wrong.
 *
 * So every assertion below is written over a POPULATION rather than over an
 * instance: `every alert`, `every health value`, `every outcome`. A tenth
 * alert, a sixth session health, an eighth outcome is covered the day it is
 * added, with no list to remember — which is the only version of this guard
 * that survives the next person.
 *
 * That paragraph was true of one spelling and false of the other, and the gap
 * is worth keeping written down because it is easy to reintroduce. `every alert
 * produced` only ever ranged over the alerts that WERE produced: a tenth alert
 * reporting `state: "ok"` from its catch block failed two assertions here with
 * no test edit, while the same alert written as
 *
 *     try { out.push(...) } catch { /* table not created yet *\/ }
 *
 * left the list entirely the moment its query threw and passed every one of
 * them. Measured, on this checkout. A population you filter is not a population
 * you counted, so the sweep is now compared — set against set — with a run of
 * the same function against a database that could answer.
 *
 * ── The two shapes ───────────────────────────────────────────────────────────
 *
 * BLIND IS NOT CLEAR. Take a working stack, remove one input, and the output
 * must change. If the payload for "could not look" is identical to the payload
 * for "looked, all well", the surface has no way to say the thing that matters.
 *
 * A PARTITION COVERS ITS POPULATION. If a report splits N things into buckets,
 * the buckets must sum to N. `wedged + idle + awaitingHuman + unknown` summing
 * to less than `checked` is how a session falls into the gap between them while
 * the page stays quiet.
 *
 * ── Deliberately not mocked ──────────────────────────────────────────────────
 *
 * Everything below drives the shipped modules through the real `query()`, with
 * test/stub-pool.mjs standing in for Postgres — the same seam
 * test/alerts-evaluate.test.mjs uses, and for the same reason: every
 * distinction being asserted here is a judgement about what the database said,
 * and none of them is reachable from a pure function.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, test } from "node:test";

// The `@/` alias, which app/api/health/route.ts uses. See charts-loader.mjs.
import "./charts-loader.mjs";

import { evaluateAlerts } from "../lib/alerts.ts";
import { bannerState, classifySession, inspectFleet, summarize } from "../lib/fleet.ts";
import { CATALOG, FINISHED_OUTCOMES, UNFINISHED_OUTCOMES } from "../lib/metrics.ts";
import { failureRate } from "../lib/monitors.ts";
import { concerns } from "../lib/sandboxes.ts";
import { installStubPool, uninstallStubPool, undefinedTable } from "./stub-pool.mjs";

afterEach(() => uninstallStubPool());

/* -------------------------------------------------------------------------- */
/* 1. blind is not clear: the alert engine, over every alert it produces       */
/* -------------------------------------------------------------------------- */

/**
 * A database that answers every question this build knows how to ask.
 *
 * The reference run. Every route below exists so that one source is ANSWERED
 * rather than merely unroutable: the stub pool returns zero rows for a query no
 * route matches, so a fixture of `[]` would be a database that is present and
 * empty, not one that is well. The difference matters here because the whole
 * point of the comparison below is that the two runs differ in exactly one
 * thing — whether the database could be read — and an empty-database reference
 * would let a check that only fails on real data agree with itself.
 *
 * Nothing here is asserted on. It is the control, and `healthyAlertIds()`
 * checks that it is one.
 */
const HEALTHY_DATABASE = [
  ["evestack.refresh_facts", []],
  ["FROM evestack.fact_turn", [{ model: "sonnet", priced: true, cost: "1.25", n: "40" }]],
  [
    "AS no_model_call",
    [
      {
        total: 40,
        finished: 40,
        unfinished: 0,
        stalled: 0,
        errored: 1,
        no_model_call: 0,
        failed: 1,
        p50: 900,
        p75: 1400,
        p95: 3000,
        p99: 4000,
        max: 5000,
        count: 40,
      },
    ],
  ],
  ["completed_at IS NULL", [{ n: "0" }]],
  ["(now() AT TIME ZONE 'utc') - interval '1 hour'", [{ n: "12" }]],
  ["to_regclass('evestack.schema_version')", [{ present: "evestack.schema_version" }]],
  // v1 rather than v99: the database is exactly as new as this build, so
  // nothing is refused and the span count below means what it says.
  ["SELECT component, version FROM evestack.schema_version", [{ component: "spans", version: 1 }]],
  ["FROM evestack.spans WHERE received_at", [{ n: "340" }]],
  ["to_regclass('evestack.schedule_runs')", [{ exists: true }]],
];

/**
 * The ids a run of `evaluateAlerts()` produced, sorted.
 *
 * Taken from the RESULT on both sides of every comparison below, so no alert id
 * is ever typed as an expectation. That is the whole mechanism: alert number ten
 * is compared against itself on the day it is written, by a line nobody has to
 * remember to extend. (One id is named further down, in the trace-ingest test,
 * because that test is about one specific monitor's sentence rather than about
 * the population.)
 */
const idsOf = (alerts) => alerts.map((a) => a.id).sort();

/**
 * The inventory this build produces when every question can be answered.
 *
 * Two controls on the fixture itself, because a reference set that silently
 * collapsed would make every comparison below pass by agreeing with nothing:
 *
 *   NOTHING REJECTED. `unknownFrom()` is the only thing in lib/alerts.ts that
 *   writes "Could not be evaluated", and it is reached only from a settled
 *   REJECTION — so one of those sentences in the reference run means the
 *   fixture is not healthy and the comparison is between two blind runs.
 *   (The sandbox pair reports `unknown` here, because EVESTACK_DOCKER_SOCKET is
 *   not set on a test machine and the containers on it were genuinely never
 *   looked at. That is a measured verdict from a source that answered, it does
 *   not go through `unknownFrom`, and it is not what this is testing.)
 *
 *   A FLOOR. Nine checks ship today. The number is a floor and not an
 *   enumeration: it never needs raising when a tenth alert is added, and it
 *   fails loudly if the sweep ever stops producing the ones already here.
 */
async function healthyAlertIds() {
  installStubPool(HEALTHY_DATABASE);
  const alerts = await evaluateAlerts();
  assert.deepEqual(
    alerts.filter((a) => /Could not be evaluated/.test(a.detail)).map((a) => `${a.id}: ${a.detail}`),
    [],
    "the reference database is not answering, so it cannot say what a healthy sweep produces",
  );
  assert.ok(
    alerts.length >= 9,
    `the reference run produced only ${alerts.length} alerts: ${alerts.map((a) => a.id)}`,
  );
  return idsOf(alerts);
}

/**
 * The strongest single statement of the rule available in this codebase.
 *
 * Nine checks fold a database answer into `ok` / `firing` / `unknown`, and
 * lib/alerts.ts's own header calls collapsing `unknown` into `ok` "the single
 * most dangerous thing an alerting page can do". This turns the whole database
 * off and asserts that header.
 *
 * ── Both halves, because the property is two-sided ───────────────────────────
 *
 * An alert that cannot answer must STILL BE THERE and must SAY it could not
 * look. Asserting only the second half is a guard against one spelling of the
 * defect and no guard at all against the other, which was measured: a tenth
 * alert written as
 *
 *     try { out.push(...) } catch { /* table not created yet *\/ }
 *
 * disappears from the list entirely the moment its query throws, reports
 * nothing, and passed every assertion in this file untouched — while the same
 * alert written to report `state: "ok"` from its catch failed two of them. The
 * enumerated nine-id list in test/alerts-evaluate.test.mjs is not the guard
 * either: it fires on an id being ADDED, so an author who adds their new id to
 * it makes the whole suite green with an alert that vanishes whenever its table
 * is missing.
 *
 * So the identical set is asserted against a run that COULD answer, and the
 * expected list comes from that run rather than from a literal here.
 */
test("with the database refusing every query, every alert is still there and none says ok", async () => {
  const expected = await healthyAlertIds();

  installStubPool([[/.*/, new Error("57P01: terminating connection, administrator command")]]);
  const alerts = await evaluateAlerts();

  assert.deepEqual(
    idsOf(alerts),
    expected,
    "an alert the healthy sweep produces is missing from the blind one: it did not report that it could not look, it reported nothing",
  );
  assert.deepEqual(
    alerts.filter((a) => a.state === "ok").map((a) => `${a.id}: ${a.detail}`),
    [],
    "an alert reported ok against a database that answered nothing",
  );
});

/**
 * The same question one layer down: a table that does not exist.
 *
 * Not the same fixture as a dead connection, and the difference is where the
 * bugs live. `evestack.spans`, `evestack.fact_turn` and
 * `evestack.schedule_runs` are all created lazily, so "the relation is missing"
 * is a NORMAL state the code has explicit handling for, and explicit handling
 * for an absent table is exactly where "absent" gets quietly rendered as
 * "empty, therefore fine" — or, as the mutation above records, quietly dropped
 * from the page altogether by a `catch` that only meant to be forgiving.
 */
test("with every evestack table missing, every alert is still there and none says ok", async () => {
  const expected = await healthyAlertIds();

  installStubPool([
    [/evestack\./, undefinedTable("evestack.fact_turn")],
    [/.*/, undefinedTable("workflow.workflow_runs")],
  ]);
  const alerts = await evaluateAlerts();

  assert.deepEqual(
    idsOf(alerts),
    expected,
    "an alert vanished when its table did not exist, which is the state this whole file is about",
  );
  assert.deepEqual(
    alerts.filter((a) => a.state === "ok").map((a) => a.id),
    [],
    "an alert reported ok about a table it could not read",
  );
});

/**
 * Instance 4, as behaviour rather than as a string.
 *
 * The install that produced the original report had turns running, spans in the
 * table, and an ingest endpoint answering 503 to every batch, because the
 * database had been migrated by a NEWER dashboard than the one serving the
 * page. The monitor compared a span count against zero, found 109, and said
 * `ok`. Had the count been zero it would have said `firing` and blamed the
 * ingest token, sending someone to rotate a credential that was fine.
 *
 * Both halves are asserted: not `ok`, and not accusing the token.
 */
test("the ingest monitor is unknown, not ok, when the trace tier is refusing writes", async () => {
  installStubPool([
    ["IN ('turn','subagent')", [{ n: "42" }]],
    ["FROM evestack.spans", [{ n: "109" }]],
    ["to_regclass('evestack.schema_version')", [{ present: "evestack.schema_version" }]],
    ["SELECT component, version FROM evestack.schema_version", [{ component: "spans", version: 99 }]],
  ]);
  const alerts = await evaluateAlerts();
  const ingest = alerts.find((a) => a.id === "no_spans_while_active");
  assert.ok(ingest, "the trace-ingest monitor did not run at all");
  assert.notEqual(ingest.state, "ok", `reported "${ingest.detail}" while ingest was refused`);
  assert.doesNotMatch(
    ingest.detail,
    /ingest token/,
    "sent the reader to rotate a credential when the credential is not the problem",
  );
});

/* -------------------------------------------------------------------------- */
/* 2. a partition covers its population: the fleet sweep                      */
/* -------------------------------------------------------------------------- */

/**
 * Every value `SessionHealth` can take is counted by `summarize()`.
 *
 * Read out of lib/fleet.ts rather than restated here, because the failure mode
 * of restating it is silent: `active` was the one health value summarize() did
 * not report, so four counters were allowed to sum to LESS than `checked` and a
 * session in flight fell into the gap between them. A sixth health value added
 * tomorrow is covered by this line without anyone remembering it exists.
 */
const HEALTH_UNION = /export type SessionHealth =([\s\S]*?);\n/;

function declaredHealths() {
  const source = readFileSync(new URL("../lib/fleet.ts", import.meta.url), "utf8");
  const block = HEALTH_UNION.exec(source);
  assert.ok(block, "could not find the SessionHealth union in lib/fleet.ts");
  const stripped = block[1].replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
  return [...stripped.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
}

const entryOf = (health, i) => ({
  sessionId: `wrun_${i}`,
  title: null,
  trigger: null,
  createdAt: new Date().toISOString(),
  idleMs: 3_600_000,
  health,
  pendingCount: health === "awaiting-human" ? 1 : 0,
  reason: "fixture",
});

const reportOf = (entries, over = {}) => ({
  entries,
  checked: entries.length,
  unchecked: 0,
  tooRecent: 0,
  idleThresholdMs: 1_800_000,
  wedgeAfterMs: 3_600_000,
  ...over,
});

test("every session health the classifier can produce lands in exactly one bucket", () => {
  const healths = declaredHealths();
  assert.ok(healths.length >= 5, `only found ${healths.length} health values: ${healths}`);

  const report = reportOf(healths.map(entryOf));
  const counts = summarize(report);
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

  assert.equal(
    total,
    report.checked,
    `summarize() accounts for ${total} of ${report.checked} probed sessions. ` +
      `declared: ${healths.join(", ")}; counted: ${Object.keys(counts).join(", ")}`,
  );
  for (const [bucket, n] of Object.entries(counts)) {
    assert.equal(n, 1, `${bucket} counted ${n} of one ${bucket} session`);
  }
});

/**
 * The other direction of the same partition: `classifySession` never invents a
 * health outside the declared union. That is the one way a value could escape
 * counting even while summarize() covers every name it knows about.
 */
test("the classifier only ever returns a declared health", () => {
  const declared = new Set(declaredHealths());
  const snapshots = [
    { terminal: true, waiting: false, pendingRequests: [] },
    { terminal: false, waiting: true, pendingRequests: [] },
    { terminal: false, waiting: false, pendingRequests: [{}] },
    { terminal: false, waiting: false, pendingRequests: [] },
  ];
  for (const snapshot of snapshots) {
    for (const age of [0, 10 * 3_600_000]) {
      const { health } = classifySession(snapshot, age, age);
      assert.ok(declared.has(health), `classifySession produced an uncounted health: ${health}`);
    }
  }
});

/**
 * Instance 1, as behaviour, and against the two databases that produced it.
 *
 * The original report is one payload answering two opposite questions:
 *
 *   NOTHING IS OPEN     no session in this database carries an unfinished turn.
 *                       Nothing to probe, and that is the good news.
 *   NOTHING WAS LOOKED  a session DOES carry an unfinished turn and the quiet
 *   AT                  gate skipped it, because it moved four minutes ago.
 *
 * Both leave `checked` at zero and every health counter at zero, and before the
 * fix that was the whole payload — so the stranger who had just killed an agent
 * mid-turn read the first from a sweep that meant the second. Only a term for
 * what was NOT examined can separate them, which is why forcing `tooRecent` to
 * zero has to turn this red.
 */
test("a sweep that examined nothing does not serialise like one that found nothing", async () => {
  const openButRecent = [
    {
      session_id: "wrun_open",
      title: "still going",
      trigger: "http",
      created_at: new Date(Date.now() - 7_200_000),
      last_activity: new Date(Date.now() - 240_000),
      in_flight_since: new Date(Date.now() - 7_200_000),
      candidate_count: "0",
      too_recent_count: "1",
      quiet: false,
    },
  ];

  // A database where nothing carries an unfinished turn at all.
  installStubPool([[/workflow_runs/, []]]);
  const clear = await inspectFleet({ limit: 25 });

  // The same sweep, same gate, against one where a session does and was skipped.
  installStubPool([[/workflow_runs/, openButRecent]]);
  const blind = await inspectFleet({ limit: 25 });

  const shape = (r) =>
    JSON.stringify({ ...summarize(r), checked: r.checked, unchecked: r.unchecked, tooRecent: r.tooRecent });
  assert.equal(clear.checked, 0, "the fixture must put both sweeps at checked: 0 to mean anything");
  assert.equal(blind.checked, 0, "the fixture must put both sweeps at checked: 0 to mean anything");
  assert.notEqual(
    shape(clear),
    shape(blind),
    `both sweeps serialised to ${shape(blind)}: a caller cannot tell "nothing is open" from "nothing was examined"`,
  );
  assert.ok(
    Number.isFinite(blind.idleThresholdMs) && Number.isFinite(blind.wedgeAfterMs),
    "the payload does not state the gates its zeros were produced by",
  );
});

/**
 * Instance 5, found by this audit: the BANNER built for instance 1's fix
 * rendered `null` on a failed sweep, which is exactly what it renders when all
 * is well.
 *
 * `bannerState` is where the component's decision lives, so the registers are
 * asserted through it. The catch itself is read off the source, because
 * rendering a React server component to find out whether it returned null is a
 * far larger apparatus for a far smaller fact.
 */
test("an empty banner means nothing is open, never nothing was examined", () => {
  assert.equal(bannerState(reportOf([])).register, "silent", "a clear sweep renders nothing");
  assert.notEqual(
    bannerState(reportOf([], { tooRecent: 1 })).register,
    "silent",
    "a session with an open turn that the quiet gate skipped rendered as all-clear",
  );
  assert.notEqual(
    bannerState(reportOf([], { unchecked: 3 })).register,
    "silent",
    "candidates the probe budget never reached rendered as all-clear",
  );

  const source = readFileSync(new URL("../app/fleet-banner.tsx", import.meta.url), "utf8");
  const caught = /\n  \} catch[\s\S]*?\n  \}\n/.exec(source);
  assert.ok(caught, "the banner no longer catches a failed sweep; check this still means something");
  assert.doesNotMatch(
    caught[0],
    /return null;/,
    "a sweep that threw renders the same nothing as a sweep that found nothing wrong",
  );
});

/* -------------------------------------------------------------------------- */
/* 3. an unresolved row is not a passing one: rates                           */
/* -------------------------------------------------------------------------- */

/**
 * Instance 2, evaluated rather than pattern-matched.
 *
 * `CASE WHEN outcome IN (...) THEN ... END` is a tiny language and this reads
 * it, so the assertion is about what the expression MEANS for each outcome the
 * database can store rather than about which words it contains. A rewrite that
 * spells the same bug differently fails this; a rewrite that spells the same
 * correctness differently passes it.
 */
function evaluateCase(sql, outcome) {
  const body = /^\s*CASE\s+([\s\S]*?)\s*END\s*$/i.exec(sql);
  assert.ok(body, `not a CASE expression: ${sql}`);
  const arms = body[1];
  for (const arm of arms.matchAll(/WHEN\s+outcome\s+IN\s*\(([^)]*)\)\s+THEN\s+(NULL|-?\d+)/gi)) {
    const values = [...arm[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
    if (!values.includes(outcome)) continue;
    return arm[2].toUpperCase() === "NULL" ? null : Number(arm[2]);
  }
  const fallback = /ELSE\s+(NULL|-?\d+)/i.exec(arms);
  if (!fallback) return null;
  return fallback[1].toUpperCase() === "NULL" ? null : Number(fallback[1]);
}

test("no unfinished turn scores as a successful one in the failure rate", () => {
  const sql = CATALOG.turns.measures.failure_rate.sql;
  assert.deepEqual(
    CATALOG.turns.measures.failure_rate.aggregations,
    ["avg"],
    "the failure rate is an avg() of a 0/1/NULL column; another aggregation changes what NULL means",
  );

  for (const outcome of UNFINISHED_OUTCOMES) {
    const scored = evaluateCase(sql, outcome);
    assert.equal(
      scored,
      null,
      `a '${outcome}' turn scores ${scored}. avg() keeps it in the denominator, so every ` +
        "stuck turn LOWERS the reported failure rate and a crashed agent improves the number",
    );
  }

  const judged = FINISHED_OUTCOMES.map((o) => evaluateCase(sql, o));
  assert.ok(
    judged.every((v) => v === 0 || v === 1),
    `a finished outcome is not judged: ${JSON.stringify(
      Object.fromEntries(FINISHED_OUTCOMES.map((o, i) => [o, judged[i]])),
    )}`,
  );
  assert.ok(judged.includes(1), "no finished outcome counts as a failure, so the rate cannot rise");
});

/**
 * The property the original bug violated, stated directly: wedging a turn must
 * never move the number in the flattering direction.
 *
 * `failed / total` fell as turns got stuck, on the one page someone opens to
 * find out whether the agent has crashed. `failed / finished` cannot.
 */
test("wedging a turn cannot improve the failure rate", () => {
  const failed = 15;
  const before = failureRate(failed, 50);
  const after = failureRate(failed, 35);
  assert.ok(after >= before, `the rate fell from ${before} to ${after} because turns got stuck`);
});

/* -------------------------------------------------------------------------- */
/* 4. a check that could not run is not a check that passed: sandboxes        */
/* -------------------------------------------------------------------------- */

/**
 * Found by this audit, and the same shape as instance 2 on a page-severity
 * alert: `concerns()` guarded both of its first two tests with `!== null`, and
 * both of those nulls mean "Docker would not describe this container".
 */
test("a container Docker would not describe is reported, not skipped", () => {
  const unreadable = {
    id: "c1",
    name: "eve-sbx-1",
    image: "x",
    state: "running",
    status: "Up",
    startedAt: null,
    uptimeMs: null,
    networkMode: null,
    sessionId: "wrun_1",
    agent: null,
    channel: null,
    templateKey: null,
    role: null,
    stats: null,
  };
  const flags = concerns([unreadable], new Set(["wrun_1"]));
  assert.ok(
    flags.some((f) => f.kind === "unreadable"),
    `a container with no readable network mode raised ${JSON.stringify(flags.map((f) => f.kind))}`,
  );

  assert.deepEqual(
    concerns([{ ...unreadable, uptimeMs: 60_000, networkMode: "none" }], new Set(["wrun_1"])),
    [],
    "the assertion above must be about the missing input, not about a noisy fixture",
  );
});

/* -------------------------------------------------------------------------- */
/* 5. instance 3: the liveness endpoint                                       */
/* -------------------------------------------------------------------------- */

/**
 * A database this build cannot migrate is not a healthy one.
 *
 * The measured original: a container answered `{"ok":true}` here for two hours
 * while sql/traces.sql and sql/facts.sql were refusing to apply, every trace
 * page was empty and the OTLP endpoint was answering 503 to every batch.
 *
 * The route is imported and called directly, because it is an ordinary async
 * function returning a Response. So this asserts the shipped handler rather
 * than a restatement of it.
 */
test("/api/health does not answer ok against a database this build cannot read", async () => {
  // /api/health refuses before it queries anything when auth is unconfigured,
  // and that refusal would make the assertion below pass for the wrong reason.
  const previous = { ...process.env };
  process.env.EVESTACK_AUTH_USER = "guard";
  process.env.EVESTACK_AUTH_PASSWORD = "guard-password";
  try {
    const { GET } = await import("../app/api/health/route.ts");

    installStubPool([
      ["to_regclass('workflow.workflow_runs')", [{ present: "workflow.workflow_runs" }]],
      ["to_regclass('evestack.schema_version')", [{ present: "evestack.schema_version" }]],
      ["SELECT component, version FROM evestack.schema_version", [{ component: "spans", version: 99 }]],
    ]);
    const degraded = await (await GET()).json();
    assert.equal(
      degraded.ok,
      false,
      `answered ${JSON.stringify(degraded)} while its own SQL would refuse to apply`,
    );

    // The negative control. Without it the assertion above would pass for the
    // wrong reason on any future change that simply broke the endpoint.
    installStubPool([
      ["to_regclass('workflow.workflow_runs')", [{ present: "workflow.workflow_runs" }]],
      ["to_regclass('evestack.schema_version')", [{ present: "evestack.schema_version" }]],
      ["SELECT component, version FROM evestack.schema_version", [{ component: "spans", version: 1 }]],
    ]);
    const healthy = await (await GET()).json();
    assert.equal(healthy.ok, true, `refused a healthy database: ${JSON.stringify(healthy)}`);
  } finally {
    for (const key of ["EVESTACK_AUTH_USER", "EVESTACK_AUTH_PASSWORD"]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

/**
 * The same rule applied to the sentence the degraded payload adds: a page it
 * calls still-working is one this build actually serves.
 *
 * `available` carried `/charts` for as long as the list existed, under a comment
 * asserting that "each entry was checked against the code, not assumed". It had
 * not been: app/charts/page.tsx calls `notFound()` when NODE_ENV is production,
 * so the one page the payload named as a consolation prize was the one page that
 * 404s on every image anyone can pull. Nothing was wrong with the mechanism —
 * the list is hand-written and nothing read it, so "checked" was a claim about
 * an author's memory, and this file exists because that is not a check.
 *
 * ── What is detected, and what is not ────────────────────────────────────────
 *
 * The lists are read out of the ROUTE's own answer rather than restated here, so
 * a sixth entry is walked the day it is added. Each is resolved to the file that
 * serves it, which is the assertion that would have failed on `/charts` if that
 * page had simply not existed.
 *
 * The production check is a heuristic and is written down as one: a page source
 * containing both `notFound(` and the literal `"production"` is taken to remove
 * itself from a production build. It cannot see a page that 404s for a reason
 * spelled some other way, and reading the branch properly needs a parser rather
 * than a regex. It does catch the shape the defect took, and every entry in
 * these lists is a static page today.
 */
test("every page the degraded payload calls available is one this build serves", async () => {
  const previous = { ...process.env };
  process.env.EVESTACK_AUTH_USER = "guard";
  process.env.EVESTACK_AUTH_PASSWORD = "guard-password";
  try {
    const { GET } = await import("../app/api/health/route.ts");
    installStubPool([
      ["to_regclass('workflow.workflow_runs')", [{ present: "workflow.workflow_runs" }]],
      ["to_regclass('evestack.schema_version')", [{ present: "evestack.schema_version" }]],
      ["SELECT component, version FROM evestack.schema_version", [{ component: "spans", version: 99 }]],
    ]);
    const degraded = await (await GET()).json();

    // The fixture control: with no lists in the payload the loop below would
    // assert nothing at all and report a pass.
    const claimed = [...(degraded.available ?? []), ...(degraded.degradedButUp ?? [])];
    assert.ok(
      claimed.length >= 5,
      `the degraded payload claims only ${claimed.length} working pages: ${JSON.stringify(degraded)}`,
    );

    for (const entry of claimed) {
      // "/ (overview)" — the annotation is for the reader, the path is the claim.
      const path = entry.replace(/\s*\(.*\)\s*$/, "").trim();
      const dir = new URL(`../app${path === "/" ? "/" : `${path}/`}`, import.meta.url);
      const served = ["page.tsx", "route.ts"]
        .map((file) => new URL(file, dir))
        .find((at) => existsSync(at));
      assert.ok(served, `the degraded payload names ${entry}, and app${path} serves nothing`);

      const source = readFileSync(served, "utf8");
      assert.ok(
        !(source.includes("notFound(") && source.includes('"production"')),
        `${entry} is listed as working, but ${served.pathname.split("/app/")[1]} removes itself ` +
          "from a production build — the payload is advertising a 404 to an operator who has " +
          "just been told half their dashboard is down",
      );
    }
  } finally {
    for (const key of ["EVESTACK_AUTH_USER", "EVESTACK_AUTH_PASSWORD"]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

/**
 * The same rule, one view over — which is where it was missing.
 *
 * `fact_tool_call.ok` was `status_code <> 2` and NOT NULL, so OTel UNSET (0) —
 * what every tracer that only sets a status on failure emits for a call that
 * WORKED — recorded as a success, and the "Tool failure rate" averaged it in
 * while claiming 100% coverage. Facts v3 made the column nullable, which fixes
 * the write but moves the danger to the readers: `CASE WHEN ok THEN 0 ELSE 1 END`
 * sends NULL to the ELSE arm, so the very upgrade that stopped over-counting
 * successes would have started counting every unjudged call as a FAILURE. An
 * exporting install's tool failure rate would have gone from 0% to 100% on the
 * first boot after the upgrade.
 *
 * The turns measure has been guarded above since the fleet work. Nothing guarded
 * the tools measure, which is exactly why the same defect was still living in it.
 */
function armFor(sql, value) {
  const body = /^\s*CASE\s+([\s\S]*?)\s*END\s*$/i.exec(sql);
  assert.ok(body, `not a CASE expression: ${sql}`);
  const arms = body[1];
  if (value === null) {
    const isNull = /WHEN\s+ok\s+IS\s+NULL\s+THEN\s+(NULL|'[^']*'|-?\d+)/i.exec(arms);
    return isNull ? isNull[1] : null;
  }
  const m = new RegExp(`WHEN\\s+ok\\s+THEN\\s+(NULL|'[^']*'|-?\\d+)`, "i").exec(arms);
  return m ? m[1] : null;
}

test("a tool call nobody judged is not scored as one that failed", () => {
  const sql = CATALOG.tool_calls.measures.failure_rate.sql;
  assert.deepEqual(
    CATALOG.tool_calls.measures.failure_rate.aggregations,
    ["avg"],
    "the tool failure rate is an avg() of a 0/1/NULL column; another aggregation changes what NULL means",
  );
  assert.equal(
    armFor(sql, null),
    "NULL",
    "an unjudged tool call (OTel UNSET, stored as NULL) must leave the rate entirely. " +
      "Without an `ok IS NULL` arm it falls to ELSE and every call a tracer never " +
      "judged is counted as a failure",
  );
  assert.equal(armFor(sql, true), "0", "a judged-successful call scores 0");
});

test("the tool status dimension has a bucket for calls nobody judged", () => {
  const sql = CATALOG.tool_calls.dimensions.status.sql;
  const unknown = armFor(sql, null);
  assert.ok(
    unknown && unknown !== "'failed'",
    `an unjudged tool call groups as ${unknown ?? "the ELSE arm"}. A chart whose job is ` +
      "telling ok from failed must not put 'never reported' in the failed bucket",
  );
});
