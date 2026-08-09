import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { deliveryStatus } from "../lib/alert-delivery.ts";
import { installStubPool, uninstallStubPool, undefinedTable } from "./stub-pool.mjs";

/**
 * `deliveryStatus()` answers one question — "is anyone actually being told?" —
 * and it has to answer it in three different ways.
 *
 * test/alert-delivery.test.mjs pins the pure half of that module (the eight
 * transitions, sink parsing, redaction, signing). This is the half that talks to
 * Postgres, and it was untested, which is why the defect below survived:
 *
 *   `neverRun` was returned from a BARE catch, so a Postgres that was down came
 *   back as `neverRun: true` and /monitors rendered "Nothing has been sent yet"
 *   — the exact words a healthy install with delivery switched off shows. The
 *   flag was also written and never read, so nothing anywhere disagreed. A
 *   monitor panel reporting calm because it could not reach the database is the
 *   one failure the alert loop exists to prevent.
 *
 * The split into `neverRun` / `unreadable` (lib/alert-delivery.ts:1069-1082) is
 * the fix, and every branch of it is asserted here in both directions —
 * getting this backwards is worse than not having the distinction, because the
 * page then states the opposite of the truth with the same confidence.
 *
 * The stub pool (test/stub-pool.mjs) explains how Postgres is stood in for.
 */

const LAST_DELIVERY_SQL = "FROM evestack.alert_deliveries";
const FAILING_SQL = "FROM evestack.alert_state";

/**
 * A configured install, so the delivery branch is the one under test.
 *
 * With no EVESTACK_ALERT_WEBHOOK_URL the panel short-circuits to "Nothing is
 * delivered" and none of the three database states is reachable.
 */
const CONFIGURED = {
  EVESTACK_ALERT_WEBHOOK_URL: "https://hooks.slack.com/services/T000/B000/xoxb-secret-token",
  EVESTACK_ALERT_INTERVAL_SECONDS: "60",
  EVESTACK_ALERT_RENOTIFY_MINUTES: "30",
};

const CONTROLLED = [
  "EVESTACK_ALERT_WEBHOOK_URL",
  "EVESTACK_ALERT_WEBHOOK_FORMAT",
  "EVESTACK_ALERT_WEBHOOK_SECRET",
  "EVESTACK_ALERT_INTERVAL_SECONDS",
  "EVESTACK_ALERT_RENOTIFY_MINUTES",
];
const saved = {};

beforeEach(() => {
  for (const name of CONTROLLED) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  for (const [name, value] of Object.entries(CONFIGURED)) process.env[name] = value;
});

afterEach(() => {
  uninstallStubPool();
  for (const name of CONTROLLED) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

/* ── the three answers ─────────────────────────────────────────────────────── */

test("a table that was never created is a never-run state", async () => {
  // evestack.alert_deliveries is created by the first tick of the loop, so its
  // absence is a legitimate, calm "delivery has not started" — and the only
  // failure that is allowed to read that way.
  installStubPool([[LAST_DELIVERY_SQL, undefinedTable("evestack.alert_deliveries")]]);
  const status = await deliveryStatus();

  assert.equal(status.neverRun, true);
  assert.equal(status.unreadable, null, "a missing table is not an unreadable database");
  assert.equal(status.lastDeliveryAt, null);
  assert.equal(status.lastDeliveryOk, null);
  assert.deepEqual(status.failing, []);
});

test("a database that is down is unreadable, and is NOT reported as never-run", async () => {
  // The regression. Both fields are asserted, because the bug was not a missing
  // `unreadable` — it was `neverRun` being true, which is what the panel then
  // rendered as "Nothing has been sent yet".
  installStubPool([[LAST_DELIVERY_SQL, new Error("ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:5433")]]);
  const status = await deliveryStatus();

  assert.equal(status.neverRun, false, "a database that is down has not proved delivery never ran");
  assert.ok(status.unreadable !== null, "the panel has nothing to warn with");
  assert.match(status.unreadable, /ECONNREFUSED/, "the reason has to survive to the screen");
});

test("the other ways a read fails are unreadable too, not never-run", async () => {
  // 42P01 is the ONLY code that means "never created". A revoked grant or a
  // terminated connection must not borrow the calm branch.
  for (const error of [
    new Error("57P01: terminating connection due to administrator command"),
    new Error("permission denied for schema evestack"),
    new Error("timeout exceeded when trying to connect"),
  ]) {
    installStubPool([[LAST_DELIVERY_SQL, error]]);
    const status = await deliveryStatus();
    assert.equal(status.neverRun, false, `${error.message} was absorbed as never-run`);
    assert.ok(status.unreadable !== null, `${error.message} left the panel with nothing to say`);
    uninstallStubPool();
  }
});

test("a readable, empty log is neither never-run nor unreadable", async () => {
  // The third state, and the one the split exists to keep separate from the
  // other two: the tables are there, the loop has ticked, and it has had no
  // transition worth sending. The panel says "Nothing has been sent yet".
  installStubPool([
    [LAST_DELIVERY_SQL, []],
    [FAILING_SQL, []],
  ]);
  const status = await deliveryStatus();

  assert.equal(status.neverRun, false);
  assert.equal(status.unreadable, null);
  assert.equal(status.lastDeliveryAt, null);
  assert.equal(status.lastDeliveryOk, null);
});

test("the two flags are never both set — they are opposite answers", async () => {
  for (const route of [
    [LAST_DELIVERY_SQL, undefinedTable("evestack.alert_deliveries")],
    [LAST_DELIVERY_SQL, new Error("ECONNREFUSED")],
    [LAST_DELIVERY_SQL, []],
  ]) {
    installStubPool([route]);
    const status = await deliveryStatus();
    assert.ok(
      !(status.neverRun && status.unreadable !== null),
      "a reader cannot act on 'nothing has run' and 'I could not look' at once",
    );
    uninstallStubPool();
  }
});

test("a missing alert_state is the same calm answer as a missing deliveries table", async () => {
  // Two tables, one bootstrap. The first read succeeding and the second failing
  // on 42P01 still means the schema is half-created by a tick that has not
  // finished — not that the database is broken.
  installStubPool([
    [LAST_DELIVERY_SQL, [{ sent_at: new Date("2026-08-08T10:00:00Z"), ok: true }]],
    [FAILING_SQL, undefinedTable("evestack.alert_state")],
  ]);
  const status = await deliveryStatus();

  assert.equal(status.neverRun, true);
  assert.equal(status.unreadable, null);
  assert.equal(status.lastDeliveryAt, null, "a partial read is discarded rather than half-reported");
});

/* ── what a successful read carries ────────────────────────────────────────── */

test("a successful read reports the last delivery and everything still stuck", async () => {
  installStubPool([
    [LAST_DELIVERY_SQL, [{ sent_at: new Date("2026-08-08T10:00:00Z"), ok: false }]],
    [
      FAILING_SQL,
      [
        { id: "wedged", delivery_error: "502 from hooks.slack.com", delivery_attempts: 4 },
        { id: "daily_spend", delivery_error: "timeout", delivery_attempts: 2 },
      ],
    ],
  ]);
  const status = await deliveryStatus();

  assert.equal(status.neverRun, false);
  assert.equal(status.unreadable, null);
  assert.equal(status.lastDeliveryAt, "2026-08-08T10:00:00.000Z");
  assert.equal(status.lastDeliveryOk, false, "a measured false is not the same as no answer");
  assert.deepEqual(status.failing, [
    { id: "wedged", error: "502 from hooks.slack.com", attempts: 4 },
    { id: "daily_spend", error: "timeout", attempts: 2 },
  ]);
});

test("a timestamp Postgres handed back as a string is passed through unchanged", async () => {
  // evestack.alert_deliveries.sent_at is timestamptz, so node-pg gives a Date;
  // but `iso()` accepts a string too and must not re-parse it into the local
  // zone on the way past.
  installStubPool([[LAST_DELIVERY_SQL, [{ sent_at: "2026-08-08T10:00:00.000Z", ok: true }]]]);
  const status = await deliveryStatus();
  assert.equal(status.lastDeliveryAt, "2026-08-08T10:00:00.000Z");
  assert.equal(status.lastDeliveryOk, true);
});

/* ── what the panel is told about itself, whatever the database said ───────── */

test("configuration survives a database failure, so one outage is not two claims", async () => {
  // `configured` comes from the environment and nothing else. Letting a failed
  // read drag it to false would make the panel say "Nothing is delivered" — a
  // statement about the operator's config — because Postgres was down.
  installStubPool([[LAST_DELIVERY_SQL, new Error("ECONNREFUSED")]]);
  const status = await deliveryStatus();

  assert.equal(status.configured, true);
  assert.deepEqual(status.sinks, ["slack"]);
  assert.equal(status.disabledReason, null);
  assert.equal(status.intervalSeconds, 60);
  assert.equal(status.renotifyMinutes, 30);
});

test("the sink is named by kind and never by URL, because the URL is the credential", async () => {
  installStubPool([[LAST_DELIVERY_SQL, []]]);
  const status = await deliveryStatus();

  const rendered = JSON.stringify(status);
  assert.ok(
    !rendered.includes("xoxb-secret-token"),
    "the webhook token reached a value the /monitors page renders",
  );
  assert.ok(!rendered.includes("hooks.slack.com"), "the sink URL is not the panel's to show");
  assert.deepEqual(status.sinks, ["slack"]);
});

test("an unconfigured install says who is being told: nobody", async () => {
  delete process.env.EVESTACK_ALERT_WEBHOOK_URL;
  installStubPool([[LAST_DELIVERY_SQL, []]]);
  const status = await deliveryStatus();

  assert.equal(status.configured, false);
  assert.deepEqual(status.sinks, []);
  assert.match(status.disabledReason, /EVESTACK_ALERT_WEBHOOK_URL/);
});

/* ── the read-only promise ─────────────────────────────────────────────────── */

test("rendering /monitors never creates the delivery schema", async () => {
  // If this bootstrapped, an install with delivery switched off would grow three
  // tables the moment somebody opened the page — the opposite of "off costs
  // nothing" — and the missing-table error is itself the answer to the question
  // the panel is asking.
  const pool = installStubPool([[LAST_DELIVERY_SQL, undefinedTable("evestack.alert_deliveries")]]);
  await deliveryStatus();

  assert.ok(pool.calls.length > 0, "nothing was asked at all, so this proves nothing");
  for (const call of pool.calls) {
    assert.match(
      call.squashed,
      /^SELECT /i,
      `a page render issued a non-SELECT: ${call.squashed.slice(0, 80)}`,
    );
  }
});
