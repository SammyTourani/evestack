/**
 * lib/fleet.ts — the arithmetic around the sweep, which is where both of its
 * bugs lived rather than in the SQL.
 *
 * The first was an interval Postgres refuses. `($1 || ' milliseconds')::interval`
 * is a text cast, so the number has to survive String(): JavaScript writes
 * exponent notation under 1e-6, and `GET /api/fleet?idleMinutes=1e-11` — which
 * passes the route's own `Number.isFinite && 0 <= x <= 43200` check untouched —
 * reached Postgres as "6e-7 milliseconds" and came back to the caller as a 500
 * carrying the failing SQL.
 *
 * The second was `unchecked`. FleetReport documents it as "candidates that
 * existed but were not probed", and it was computed as `rows.length - limit`
 * against a query that fetched `limit + 1` rows — so it was 0 or 1 and could not
 * arithmetically be anything else. 100 candidates with ?limit=25 reported 1.
 *
 * Neither needs Postgres to assert, which is the point: both survived review of
 * queries that were themselves correct.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bannerState,
  classifySession,
  inspectFleet,
  intervalMilliseconds,
  summarize,
  tooRecentCandidates,
  uncheckedCandidates,
} from "../lib/fleet.ts";
import { installStubPool, uninstallStubPool } from "./stub-pool.mjs";

/**
 * The fleet classifier has exactly two ways to be useless, and both have
 * happened. Calling a healthy session wedged trains its reader to ignore the
 * banner — the first version of lib/fleet.ts did that to 22 sessions. Calling a
 * wedged session healthy is the failure the module exists to catch.
 *
 * So every test here is a state or a boundary between two states, and the
 * inputs are the ones a real deployment produces rather than tidy ones:
 *
 *   - a stream with no events at all, which is what a live agent returns for a
 *     session it has never heard of (verified: it answers 200 with
 *     `x-eve-stream-tail-index: -1`, so the fold sees `waiting: false,
 *     terminal: false` — indistinguishable from a turn in flight);
 *   - a turn row that was created and never picked up, which has no
 *     `started_at` to measure an age from.
 *
 * EVERY SESSION THAT REACHES THIS FUNCTION HAS A TURN ROW THAT NEVER CLOSED —
 * `inspectFleet`'s query refuses the rest, so the 166-of-174 sessions whose
 * turns all finished are settled in SQL and never probed at all. That half is
 * asserted against a real server by
 * contract/runtime/probes/06-fleet-wedge-evidence.probe.mjs, because a
 * JavaScript test would only restate it.
 */

const HOUR = 60 * 60 * 1000;

const SILENT = { terminal: false, waiting: false, pendingRequests: [] };
const WAITING = { terminal: false, waiting: true, pendingRequests: [] };
const TERMINAL = { terminal: true, waiting: false, pendingRequests: [] };
const parked = (n) => ({
  terminal: false,
  waiting: false,
  pendingRequests: Array.from({ length: n }, (_, i) => ({ requestId: `r${i}`, kind: "tool-approval" })),
});

/* -- the states ------------------------------------------------------------ */

test("a waiting stream is idle, not wedged, however long it has been quiet", () => {
  // The 22-false-positives case. A session's run row stays `running` and its
  // stream stays `waiting` for the life of the conversation, so a month of
  // silence here is a healthy finished conversation.
  const got = classifySession(WAITING, 30 * 24 * HOUR, 30 * 24 * HOUR);
  assert.equal(got.health, "idle");
  assert.equal(got.pendingCount, 0);
});

test("an outstanding input request is awaiting-human, and the count is reported", () => {
  const one = classifySession(parked(1), 5 * HOUR, 5 * HOUR);
  assert.equal(one.health, "awaiting-human");
  assert.equal(one.pendingCount, 1);
  assert.match(one.reason, /parked on a decision/);

  const three = classifySession(parked(3), 5 * HOUR, 5 * HOUR);
  assert.equal(three.health, "awaiting-human");
  assert.equal(three.pendingCount, 3);
  assert.match(three.reason, /parked on 3 decisions/);
});

test("an ended session is idle — a session that is over has nothing in flight", () => {
  // This is the assertion that fails against the old code, which called a
  // terminal session `active`: same "not a fault" verdict, but it put a
  // finished conversation in the bucket that means a turn is burning tokens.
  const got = classifySession(TERMINAL, 9 * HOUR, 9 * HOUR);
  assert.equal(got.health, "idle");
  assert.notEqual(got.health, "active");
  assert.match(got.reason, /stale bookkeeping/);
});

test("an open turn row older than an hour is wedged", () => {
  const got = classifySession(SILENT, 6 * HOUR, 6 * HOUR);
  assert.equal(got.health, "wedged");
  assert.match(got.reason, /never finished/);
});

test("an open turn row that is minutes old is active, not wedged", () => {
  const got = classifySession(SILENT, 4 * 60 * 1000, 45 * 60 * 1000);
  assert.equal(got.health, "active");
  assert.equal(got.reason, "a turn is running");
});

/* -- the boundaries between them ------------------------------------------- */

test("the wedge threshold is exactly one hour of an OPEN turn", () => {
  assert.equal(classifySession(SILENT, HOUR - 1, 0).health, "active");
  assert.equal(classifySession(SILENT, HOUR, 0).health, "active");
  assert.equal(classifySession(SILENT, HOUR + 1, 0).health, "wedged");
});

test("the wedge is timed from the open turn, not from the session's idle time", () => {
  // A row touching the session recently must not disguise a turn that has been
  // open for four hours, and an old session must not manufacture a wedge out of
  // a turn that started a minute ago.
  assert.equal(classifySession(SILENT, 4 * HOUR, 60 * 1000).health, "wedged");
  assert.equal(classifySession(SILENT, 60 * 1000, 40 * HOUR).health, "active");
});

test("with no started_at to measure from, idle time is the fallback", () => {
  // A run row created and never picked up has completed_at AND started_at null,
  // so MIN(started_at) is null even though the row is genuinely open. Falling
  // back to idle time keeps a queued turn that has sat for a day visible
  // instead of silently healthy.
  assert.equal(classifySession(SILENT, null, 25 * HOUR).health, "wedged");
  assert.equal(classifySession(SILENT, null, 2 * 60 * 1000).health, "active");
});

test("the stream outranks the tables where the stream speaks", () => {
  // A turn row left open by a crash, on a session the agent says is waiting,
  // is stale bookkeeping — not a wedge. Reading SQL first would resurrect the
  // original 22-false-positive bug in a new place.
  assert.equal(classifySession(WAITING, 50 * HOUR, 50 * HOUR).health, "idle");
  assert.equal(classifySession(TERMINAL, 50 * HOUR, 50 * HOUR).health, "idle");
  assert.equal(classifySession(parked(2), 50 * HOUR, 50 * HOUR).health, "awaiting-human");
});

test("a parked session is awaiting-human even though its stream is not waiting", () => {
  // eve emits `turn.completed` BEFORE `session.waiting` on a HITL pause, so a
  // parked session is routinely caught mid-way with waiting still false. It is
  // not wedged and never has been.
  assert.equal(classifySession(parked(1), 9 * HOUR, 9 * HOUR).health, "awaiting-human");
});

const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const MAX_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

test("the value that used to 500 is a threshold Postgres can read", () => {
  const value = intervalMilliseconds(1e-11 * 60_000);
  assert.equal(value, "0", "'idle for ~0 minutes' is what was asked for");
  assert.doesNotMatch(value, /e/i);
});

test("no threshold the route allows comes out in exponent form", () => {
  for (const minutes of [0, 1e-11, 1e-7, 0.0004, 0.5, 1, 29.999, 30, 1440, 43200]) {
    const value = intervalMilliseconds(minutes * 60_000);
    assert.match(value, /^\d+$/, `${minutes} minutes -> ${value}`);
  }
});

test("an absurd threshold is clamped, not written as 1e+30", () => {
  assert.equal(intervalMilliseconds(1e30), String(MAX_IDLE_MS));
  assert.match(intervalMilliseconds(Number.MAX_VALUE), /^\d+$/);
});

test("a threshold that is not a number falls back to the module's own default", () => {
  assert.equal(intervalMilliseconds(Number.NaN), String(DEFAULT_IDLE_MS));
  assert.equal(intervalMilliseconds(Number.POSITIVE_INFINITY), String(DEFAULT_IDLE_MS));
});

test("a negative threshold cannot become a negative interval", () => {
  assert.equal(intervalMilliseconds(-60_000), "0");
});

test("unchecked counts the candidates that were not probed", () => {
  // The documented case: 100 candidates, ?limit=25. The old answer was 1.
  const rows = Array.from({ length: 25 }, () => ({ candidate_count: "100" }));
  assert.equal(uncheckedCandidates(rows), 75);
});

test("pg hands a bigint count over as a string", () => {
  assert.equal(uncheckedCandidates([{ candidate_count: "3" }]), 2);
  assert.equal(uncheckedCandidates([{ candidate_count: 3 }]), 2);
});

test("a sweep that saw everything reports nothing left, and never NaN", () => {
  assert.equal(uncheckedCandidates([]), 0);
  assert.equal(uncheckedCandidates([{ candidate_count: "1" }]), 0);
  // A count below the rows in hand is impossible, and must not go negative.
  assert.equal(uncheckedCandidates([{ candidate_count: "0" }]), 0);
  for (const broken of [{}, { candidate_count: null }, { candidate_count: "many" }]) {
    const value = uncheckedCandidates([broken]);
    assert.ok(Number.isFinite(value), `${JSON.stringify(broken)} -> ${value}`);
    assert.equal(value, 0);
  }
});


/* -- what the sweep says it did NOT look at -------------------------------- */

/**
 * `checked: 0` HAD TWO MEANINGS AND NO WAY TO TELL THEM APART, and this block
 * is the whole of that fix.
 *
 * "No session has a turn open, so nothing here could be wedged" and "a turn is
 * open and the sweep skipped it because it moved four minutes ago" both came
 * back as {"wedged":0,"idle":0,"awaitingHuman":0,"unknown":0,"entries":[],
 * "checked":0,"unchecked":0} — byte for byte. Someone who had just killed an
 * agent mid-turn read the first from a sweep that meant the second, and filed
 * it as a broken health check. The detection was not broken. It was silent
 * about being silent.
 *
 * The rows below are what the sweep's own query returns, quiet flag and window
 * counts included, so these pin the JavaScript that reads them. That the SQL
 * produces those columns is PostgreSQL's semantics and is asserted against a
 * real server by contract/runtime/probes/06-fleet-wedge-evidence.probe.mjs.
 *
 * No agent is listening in these, so any session that IS probed comes back
 * `unknown`. That is deliberate: it makes "was this session probed at all"
 * visible in the assertion, which is the property being tested.
 */

const AGO = (ms) => new Date(Date.now() - ms);

function candidateRow(overrides = {}) {
  return {
    session_id: "wrun_x",
    title: "t",
    trigger: null,
    created_at: AGO(3 * HOUR),
    last_activity: AGO(3 * HOUR),
    in_flight_since: AGO(3 * HOUR),
    quiet: true,
    candidate_count: "1",
    too_recent_count: "0",
    ...overrides,
  };
}

const sweep = (rows) => installStubPool([["FROM workflow.workflow_runs s", rows]]);

test("a session with an open turn that moved too recently is COUNTED, not erased", async (t) => {
  // One session whose turn stopped 21 minutes ago, against the shipped
  // 30-minute quiet gate. The old query dropped it in HAVING, so the sweep
  // could not count what it had thrown away.
  sweep([
    candidateRow({
      session_id: "stopped-21m-ago",
      quiet: false,
      last_activity: AGO(21 * 60 * 1000),
      candidate_count: "0",
      too_recent_count: "1",
    }),
  ]);
  t.after(uninstallStubPool);

  const report = await inspectFleet();
  assert.equal(report.checked, 0, "nothing was old enough to probe, which is correct");
  assert.equal(report.tooRecent, 1, "and the caller can now see that one was skipped");
  assert.equal(report.entries.length, 0, "a skipped session must not cost a round trip");
  assert.equal(report.unchecked, 0, "unchecked is the probe budget, not the quiet gate");
});

test("an empty sweep is a DIFFERENT answer from a skipped one", async (t) => {
  sweep([]);
  t.after(uninstallStubPool);

  const report = await inspectFleet();
  assert.equal(report.checked, 0);
  assert.equal(report.tooRecent, 0, "no rows at all means no session has a turn open");
  assert.notDeepEqual(
    { checked: report.checked, tooRecent: report.tooRecent },
    { checked: 0, tooRecent: 1 },
    "all clear and not-looked-at must not serialise to the same object",
  );
});

test("only the quiet rows are probed, however many came back", async (t) => {
  const stub = sweep([
    candidateRow({ session_id: "quiet-one", quiet: true, candidate_count: "1", too_recent_count: "2" }),
    candidateRow({ session_id: "busy-one", quiet: false, candidate_count: "1", too_recent_count: "2" }),
    candidateRow({ session_id: "busy-two", quiet: false, candidate_count: "1", too_recent_count: "2" }),
  ]);
  t.after(uninstallStubPool);

  const report = await inspectFleet();
  assert.equal(report.checked, 1, "one probe, not three");
  assert.deepEqual(report.entries.map((e) => e.sessionId), ["quiet-one"]);
  assert.equal(report.tooRecent, 2);
  assert.equal(stub.matching("FROM workflow.workflow_runs s").length, 1, "still one query");
});

test("the report quotes the thresholds it applied, not the ones it was asked for", async (t) => {
  sweep([]);
  t.after(uninstallStubPool);

  // 1e-11 minutes is the value that used to reach Postgres as "6e-7
  // milliseconds" and come back a 500. It rounds to a 0ms gate, and the report
  // has to say so rather than echo the request.
  const report = await inspectFleet({ idleMs: 1e-11 * 60_000 });
  assert.equal(report.idleThresholdMs, 0);
  assert.equal(report.wedgeAfterMs, HOUR, "the banner prints this; it must be the real constant");

  const shipped = await inspectFleet();
  assert.equal(shipped.idleThresholdMs, DEFAULT_IDLE_MS);
});

test("tooRecent rides on any row the sweep returned, probed or not", () => {
  assert.equal(tooRecentCandidates([{ too_recent_count: "4" }]), 4);
  assert.equal(tooRecentCandidates([{ quiet: true, too_recent_count: "4" }]), 4);
  assert.equal(tooRecentCandidates([]), 0, "no open turns anywhere");
  for (const broken of [{}, { too_recent_count: null }, { too_recent_count: "many" }]) {
    assert.equal(tooRecentCandidates([broken]), 0, JSON.stringify(broken));
  }
});

/* -- the buckets add up ---------------------------------------------------- */

const entry = (health) => ({
  sessionId: `s-${health}`,
  title: null,
  trigger: null,
  createdAt: new Date().toISOString(),
  idleMs: 0,
  health,
  pendingCount: 0,
  reason: "",
});

const reportOf = (healths, extras = {}) => ({
  entries: healths.map(entry),
  checked: healths.length,
  unchecked: 0,
  tooRecent: 0,
  idleThresholdMs: DEFAULT_IDLE_MS,
  wedgeAfterMs: HOUR,
  ...extras,
});

test("every checked session lands in exactly one reported bucket", () => {
  // `active` was the one health value summarize() did not report, so the four
  // counters were allowed to sum to LESS than `checked` with nothing in the
  // payload saying where the difference went — and the difference was exactly
  // the sessions in the 30-to-60-minute window after a process dies.
  const report = reportOf(["wedged", "idle", "awaiting-human", "unknown", "active", "active"]);
  const counts = summarize(report);
  const total = counts.wedged + counts.idle + counts.awaitingHuman + counts.unknown + counts.active;
  assert.equal(total, report.checked);
  assert.equal(counts.active, 2);
});

/* -- what the banner says -------------------------------------------------- */

test("the wedged banner CAN fire", () => {
  // The README screenshot advertises "8 sessions wedged" and nothing proved the
  // state was reachable. Confirmed against a real Postgres as well: a session
  // whose turn has been open 90 minutes classifies wedged at the shipped
  // defaults, and the sweep reports wedged: 1.
  const state = bannerState(reportOf(["wedged"]));
  assert.equal(state.register, "fault");
  assert.equal(state.counts.wedged, 1);
});

test("a park or an unreachable agent is a to-do, not a fault", () => {
  assert.equal(bannerState(reportOf(["awaiting-human"])).register, "todo");
  assert.equal(bannerState(reportOf(["unknown"])).register, "todo");
});

test("an unjudged open turn is not silence", () => {
  // The first minutes after a process dies: nothing probed, one session held
  // back by the quiet gate. This used to render an empty page next to a
  // Failure rate 0% tile.
  const skipped = bannerState(reportOf([], { tooRecent: 1 }));
  assert.equal(skipped.register, "coverage");
  assert.equal(skipped.unjudged, 1);

  // And the half hour after that: probed, and too young to call a fault.
  const young = bannerState(reportOf(["active"]));
  assert.equal(young.register, "coverage");
  assert.equal(young.unjudged, 1);
});

test("the out-of-budget line is reachable on its own", () => {
  // It sat behind an early return that fired unless something was already
  // wrong, so the one sentence saying the sweep ran out of round trips could
  // only appear once those round trips had already found a fault.
  assert.equal(bannerState(reportOf(["idle"], { unchecked: 149 })).register, "coverage");
});

test("a fleet with nothing open renders nothing at all", () => {
  // No green all-clear badge. The absence IS the good news, and a banner that
  // is always present is furniture.
  assert.equal(bannerState(reportOf([])).register, "silent");
  assert.equal(bannerState(reportOf(["idle"])).register, "silent");
});

test("a fault outranks the coverage lines", () => {
  const state = bannerState(reportOf(["wedged", "active"], { tooRecent: 3, unchecked: 2 }));
  assert.equal(state.register, "fault");
  assert.equal(state.unjudged, 4, "the coverage count is still reported alongside it");
});
