import assert from "node:assert/strict";
import { test } from "node:test";

import {
  planNotifications,
  redactUrl,
  renderBody,
  renderText,
  resolveSinks,
  signBody,
  summarise,
} from "../lib/alert-delivery.ts";

/**
 * The rule table is the product.
 *
 * Whether this feature is useful or muted comes down to eight cases in
 * planNotifications, two of which are counter-intuitive, and none of which can
 * be exercised in a browser without Postgres, a webhook receiver and a broken
 * agent all at once. That is exactly the shape of logic that never gets tested
 * and quietly rots, so it was written pure and every case is pinned here.
 */

const alert = (id, state, severity = "warn") => ({
  id,
  title: id,
  severity,
  state,
  detail: `${id} is ${state}`,
});

/** A `Remembered` for one id: what we last SAW and what we last SENT. */
const memory = (notifiedState, extra = {}) =>
  new Map([["a", { state: notifiedState ?? "ok", notifiedState, notifiedAt: null, since: null, ...extra }]]);

const plan = (live, remembered, opts = {}) =>
  planNotifications(live, remembered, { now: Date.parse("2026-08-08T12:00:00Z"), renotifyMs: null, ...opts });

/* ── the eight transitions ─────────────────────────────────────────────────── */

test("a monitor never delivered before, already firing, is sent", () => {
  // The one first-run message worth sending: a fresh install that is ALREADY
  // broken should say so rather than waiting for the state to change again.
  const out = plan([alert("a", "firing")], new Map());
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "fired");
  assert.equal(out[0].from, null);
});

test("a monitor never delivered before, healthy, is silent", () => {
  // Nine "everything is fine" messages on first boot is how a channel gets
  // muted before it has ever carried real news.
  assert.deepEqual(plan([alert("a", "ok")], new Map()), []);
});

test("a monitor never delivered before, unevaluable, is silent", () => {
  assert.deepEqual(plan([alert("a", "unknown")], new Map()), []);
});

test("ok to firing is the ordinary alert", () => {
  const out = plan([alert("a", "firing")], memory("ok"));
  assert.equal(out[0].kind, "fired");
  assert.equal(out[0].from, "ok");
});

test("unknown to firing is sent — it became evaluable and it was bad", () => {
  const out = plan([alert("a", "firing")], memory("unknown"));
  assert.equal(out[0].kind, "fired");
});

test("firing to ok sends the all-clear", () => {
  const out = plan([alert("a", "ok")], memory("firing"));
  assert.equal(out[0].kind, "resolved");
});

test("firing to unknown is NOT reported as resolved", () => {
  // The single most dangerous thing this module could do. The monitor stopped
  // being answerable while it was firing: the problem is un-observed, not over,
  // and an operator told "resolved" here would stand down on a live incident.
  const out = plan([alert("a", "unknown")], memory("firing"));
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "stale");
  assert.notEqual(out[0].kind, "resolved");
});

test("ok to unknown is sent only for the checks that would wake someone", () => {
  // For a `page` monitor, losing the ability to evaluate IS the incident.
  const paging = plan([alert("a", "unknown", "page")], memory("ok"));
  assert.equal(paging.length, 1);
  assert.equal(paging[0].kind, "stale");

  // Below `page` it is silent: an unmounted Docker socket is a configuration
  // choice, and notifying about it would fire on every install that never
  // enabled sandbox visibility.
  assert.deepEqual(plan([alert("a", "unknown", "warn")], memory("ok")), []);
  assert.deepEqual(plan([alert("a", "unknown", "info")], memory("ok")), []);
});

test("unknown to ok is silent", () => {
  assert.deepEqual(plan([alert("a", "ok")], memory("unknown")), []);
});

/* ── re-notification ───────────────────────────────────────────────────────── */

test("a monitor that stays firing is mentioned once by default", () => {
  const remembered = memory("firing", { notifiedAt: "2026-08-01T00:00:00Z" });
  assert.deepEqual(plan([alert("a", "firing")], remembered), []);
});

test("with an interval set, a still-firing monitor repeats once it has elapsed", () => {
  const remembered = memory("firing", { notifiedAt: "2026-08-08T11:00:00Z" });
  const out = plan([alert("a", "firing")], remembered, { renotifyMs: 30 * 60_000 });
  assert.equal(out[0].kind, "renotify");
});

test("re-notification waits for the full interval", () => {
  const remembered = memory("firing", { notifiedAt: "2026-08-08T11:50:00Z" });
  assert.deepEqual(plan([alert("a", "firing")], remembered, { renotifyMs: 30 * 60_000 }), []);
});

test("resolved and unknown are never repeated on a timer", () => {
  // Repeating "it is still fine" or "still not checked" every 30 minutes is
  // noise by construction, whatever the interval says.
  for (const state of ["ok", "unknown"]) {
    const remembered = memory(state, { notifiedAt: "2026-08-01T00:00:00Z" });
    assert.deepEqual(
      plan([alert("a", state)], remembered, { renotifyMs: 60_000 }),
      [],
      `${state} should not repeat`,
    );
  }
});

test("an unparseable stored timestamp goes quiet rather than notifying every tick", () => {
  // `now - NaN >= interval` is false, which is the safe direction: a corrupt
  // row costs one missed repeat, not a message every 60 seconds forever.
  const remembered = memory("firing", { notifiedAt: "not a date" });
  assert.deepEqual(plan([alert("a", "firing")], remembered, { renotifyMs: 60_000 }), []);
});

test("a firing monitor that has never been delivered does not wait for the interval", () => {
  // notifiedAt is null, so the renotify branch cannot apply — but `from` is
  // null and `to` is firing, which is a real transition and must still send.
  const out = plan([alert("a", "firing")], new Map(), { renotifyMs: 60_000 });
  assert.equal(out[0].kind, "fired");
});

/* ── how long it has been wrong ────────────────────────────────────────────── */

test("the notification carries how long the monitor has been in this state", () => {
  const remembered = new Map([
    ["a", { state: "firing", notifiedState: "ok", notifiedAt: null, since: "2026-08-08T11:30:00Z" }],
  ]);
  const [t] = plan([alert("a", "firing")], remembered);
  assert.equal(t.forMs, 30 * 60_000);
});

test("an unknown `since` is null, not zero", () => {
  // Zero would render as "(0s)", which claims the problem just started.
  const [t] = plan([alert("a", "firing")], memory("ok"));
  assert.equal(t.forMs, null);
});

/* ── sink resolution ───────────────────────────────────────────────────────── */

test("with no URL configured there are no sinks and a sentence saying why", () => {
  const config = resolveSinks({});
  assert.deepEqual(config.sinks, []);
  assert.match(config.disabledReason, /EVESTACK_ALERT_WEBHOOK_URL/);
});

test("the payload shape is detected from the host", () => {
  const cases = [
    ["https://hooks.slack.com/services/T0/B0/xxx", "slack"],
    ["https://discord.com/api/webhooks/1/abc", "discord"],
    ["https://discordapp.com/api/webhooks/1/abc", "discord"],
    ["https://alerts.example.com/hook", "webhook"],
    // A discord.com URL that is not a webhook endpoint is not a Discord webhook.
    ["https://discord.com/channels/1/2", "webhook"],
  ];
  for (const [url, kind] of cases) {
    assert.equal(resolveSinks({ EVESTACK_ALERT_WEBHOOK_URL: url }).sinks[0].kind, kind, url);
  }
});

test("the detected format can be overridden for a proxied endpoint", () => {
  const config = resolveSinks({
    EVESTACK_ALERT_WEBHOOK_URL: "https://proxy.internal/slack",
    EVESTACK_ALERT_WEBHOOK_FORMAT: "slack",
  });
  assert.equal(config.sinks[0].kind, "slack");
});

test("several URLs can be configured at once", () => {
  const config = resolveSinks({
    EVESTACK_ALERT_WEBHOOK_URL: "https://hooks.slack.com/services/a, https://ops.example.com/h",
  });
  assert.deepEqual(
    config.sinks.map((s) => s.kind),
    ["slack", "webhook"],
  );
});

test("a non-http URL is refused rather than attempted", () => {
  // `file:` and `gopher:` reach fetch() and fail in ways that read as a broken
  // network. Refusing at configuration time says the real thing.
  const config = resolveSinks({ EVESTACK_ALERT_WEBHOOK_URL: "file:///etc/passwd" });
  assert.deepEqual(config.sinks, []);
  assert.match(config.disabledReason, /no usable http\(s\) URL/);
});

test("the poll interval has a floor", () => {
  // Below this the loop evaluates faster than the checks it runs — the sandbox
  // probe alone costs about two seconds for its CPU sample.
  const config = resolveSinks({
    EVESTACK_ALERT_WEBHOOK_URL: "https://e.com/h",
    EVESTACK_ALERT_INTERVAL_SECONDS: "1",
  });
  assert.equal(config.intervalMs, 15_000);
});

test("a nonsense interval falls back to the default rather than to zero", () => {
  const config = resolveSinks({
    EVESTACK_ALERT_WEBHOOK_URL: "https://e.com/h",
    EVESTACK_ALERT_INTERVAL_SECONDS: "banana",
  });
  assert.equal(config.intervalMs, 60_000);
});

test("re-notification is off unless a positive number of minutes is set", () => {
  const base = { EVESTACK_ALERT_WEBHOOK_URL: "https://e.com/h" };
  assert.equal(resolveSinks(base).renotifyMs, null);
  assert.equal(resolveSinks({ ...base, EVESTACK_ALERT_RENOTIFY_MINUTES: "0" }).renotifyMs, null);
  assert.equal(resolveSinks({ ...base, EVESTACK_ALERT_RENOTIFY_MINUTES: "-5" }).renotifyMs, null);
  assert.equal(resolveSinks({ ...base, EVESTACK_ALERT_RENOTIFY_MINUTES: "30" }).renotifyMs, 1_800_000);
});

/* ── what actually gets sent ───────────────────────────────────────────────── */

const transition = (kind, id = "wedged") => ({
  alert: { ...alert(id, kind === "resolved" ? "ok" : "firing", "page"), href: "/sessions" },
  kind,
  from: kind === "resolved" ? "firing" : "ok",
  to: kind === "resolved" ? "ok" : "firing",
  forMs: 90_000,
});

test("Slack gets `text` and Discord gets `content` — neither accepts the other", () => {
  const t = [transition("fired")];
  assert.ok(typeof JSON.parse(renderBody(t, "slack", null, "now")).text === "string");
  assert.ok(typeof JSON.parse(renderBody(t, "discord", null, "now")).content === "string");
  assert.equal(JSON.parse(renderBody(t, "slack", null, "now")).content, undefined);
  assert.equal(JSON.parse(renderBody(t, "discord", null, "now")).text, undefined);
});

test("the generic body carries every field a receiver would route on", () => {
  const body = JSON.parse(renderBody([transition("fired")], "webhook", "https://d.example", "T"));
  assert.equal(body.source, "evestack");
  assert.equal(body.sentAt, "T");
  const [one] = body.alerts;
  for (const field of ["id", "title", "severity", "kind", "from", "to", "detail", "href"]) {
    assert.ok(field in one, `generic payload is missing ${field}`);
  }
  assert.equal(one.kind, "fired");
});

test("the detail sentence survives into the message", () => {
  // The detail is the part that says what the number actually WAS. A summary
  // line without it tells the reader only that something changed.
  const text = renderText([transition("fired")], "slack", null);
  assert.match(text, /wedged is firing/);
});

test("a Discord payload is truncated under the 2000-character hard limit", () => {
  // Discord rejects an over-long body outright, which to an operator looks
  // exactly like a broken webhook rather than a chatty incident.
  const many = Array.from({ length: 60 }, (_, i) => transition("fired", `monitor-number-${i}`));
  const content = JSON.parse(renderBody(many, "discord", null, "T")).content;
  assert.ok(content.length < 2000, `discord body was ${content.length} characters`);
  assert.match(content, /truncated/);
});

test("the generic sink is never truncated", () => {
  // A machine consumer has no such limit, and silently dropping alerts from a
  // payload meant for another monitoring system is the worst of both.
  const many = Array.from({ length: 60 }, (_, i) => transition("fired", `m${i}`));
  assert.equal(JSON.parse(renderBody(many, "webhook", null, "T")).alerts.length, 60);
});

test("the summary counts each kind", () => {
  const text = summarise([transition("fired"), transition("resolved"), transition("fired", "b")]);
  assert.match(text, /2 firing/);
  assert.match(text, /1 resolved/);
});

test("a dashboard URL turns the alert into a link, and its absence omits one", () => {
  const withUrl = renderText([transition("fired")], "slack", "https://evestack.example.com/");
  assert.match(withUrl, /https:\/\/evestack\.example\.com\/sessions/);
  // No trailing double slash from the configured URL's own slash.
  assert.doesNotMatch(withUrl, /com\/\/sessions/);
  assert.doesNotMatch(renderText([transition("fired")], "slack", null), /https:/);
});

/* ── signing and redaction ─────────────────────────────────────────────────── */

test("the signature covers the timestamp as well as the body", () => {
  // Signing the body alone authenticates the content and nothing else, so a
  // captured POST replays forever. Binding the timestamp lets a receiver reject
  // anything older than its own tolerance.
  const body = '{"a":1}';
  assert.notEqual(signBody("s", "1", body), signBody("s", "2", body));
  assert.notEqual(signBody("s", "1", body), signBody("t", "1", body));
  assert.equal(signBody("s", "1", body), signBody("s", "1", body));
  assert.match(signBody("s", "1", body), /^sha256=[0-9a-f]{64}$/);
});

test("a stored target never contains the credential", () => {
  // Slack and Discord both put a working secret in the PATH, so storing the
  // full URL would put a live credential in a table the dashboard renders.
  const slack = "https://hooks.slack.com/services/T00/B00/XXXXsecretXXXX";
  assert.equal(redactUrl(slack), "https://hooks.slack.com/…");
  assert.doesNotMatch(redactUrl(slack), /secret/);
  assert.equal(redactUrl("not a url"), "(unparseable)");
});

/* ── anti-vacuity ──────────────────────────────────────────────────────────── */

test("the rule table was actually exercised, not just imported", () => {
  // Every kind this module can emit must have been produced by a case above. A
  // suite that silently stopped covering `stale` would still pass every
  // assertion it had left, which is the failure this guards.
  const produced = new Set();
  produced.add(plan([alert("a", "firing")], new Map())[0]?.kind);
  produced.add(plan([alert("a", "ok")], memory("firing"))[0]?.kind);
  produced.add(plan([alert("a", "unknown")], memory("firing"))[0]?.kind);
  produced.add(
    plan([alert("a", "firing")], memory("firing", { notifiedAt: "2026-08-08T11:00:00Z" }), {
      renotifyMs: 60_000,
    })[0]?.kind,
  );
  assert.deepEqual([...produced].sort(), ["fired", "renotify", "resolved", "stale"]);
});
