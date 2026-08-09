-- evestack alert delivery: what we have already told someone about.
--
-- `lib/alerts.ts` evaluates nine monitors on demand and hands them to a React
-- component. That makes them a dashboard, not an alert: they exist only while a
-- human has /monitors open, which is the one moment you do not need to be told.
-- These three tables are the memory that turns the first into the second.
--
-- Same schema rules as sql/traces.sql: everything evestack writes lives in the
-- `evestack` schema, never in `workflow`, which belongs to world-postgres and
-- owns its own migrations. Every statement is guarded so this file is safe to
-- run on every boot; adding a column later needs its own ALTER, because
-- CREATE TABLE IF NOT EXISTS silently does nothing once the table is there.

CREATE SCHEMA IF NOT EXISTS evestack;

-- One row per monitor id.
--
-- TWO STATES PER ROW, AND THE DISTINCTION IS THE WHOLE DESIGN.
--
--   `state`          what the last evaluation SAW. Always written.
--   `notified_state` what we last SUCCESSFULLY DELIVERED. Written only after a
--                    sink accepted the message.
--
-- Collapsing them into one column is the obvious simplification and it is
-- wrong, in a way that only shows up on the day it matters. The decision to
-- send compares the live state against `notified_state`, so a webhook that is
-- down does not consume the transition: the send is retried on the next tick,
-- for as long as it keeps failing. If the two were one column, a single 500
-- from a receiver would mark the transition as handled and the page that
-- started failing at 02:00 would never be mentioned again.
--
-- The cost of that choice is that a receiver which accepts the POST and then
-- drops it on the floor is indistinguishable from one that delivered it. That
-- is the correct place to give up: at-least-once with a visible failure count
-- beats at-most-once with a silent one.
CREATE TABLE IF NOT EXISTS evestack.alert_state (
  id              text        PRIMARY KEY,

  -- ok | firing | unknown. Not an enum: lib/alerts.ts owns this vocabulary and
  -- a CREATE TYPE here would need a migration every time it gains a state,
  -- which is exactly the coupling the `evestack` schema exists to avoid.
  state           text        NOT NULL,
  severity        text        NOT NULL,
  title           text        NOT NULL,
  detail          text        NOT NULL,

  -- When the monitor ENTERED `state` — not when it was last seen in it. A
  -- notification that says "failing for 40 minutes" needs the first observation,
  -- and only rewriting this when the state actually changes is what preserves it.
  since           timestamptz NOT NULL DEFAULT now(),
  observed_at     timestamptz NOT NULL DEFAULT now(),

  -- NULL means never delivered, which is not the same as `ok` and must not be
  -- read as one: on a fresh install every monitor is NULL, and treating that as
  -- `ok` would make the first evaluation of a broken install look like nine
  -- resolutions.
  notified_state  text,
  notified_at     timestamptz,

  -- Set on a failed send, cleared on a successful one. The panel reads these:
  -- a delivery path that has been failing for a day must be visible on the page,
  -- because an alerting system nobody can see is the failure it exists to catch.
  delivery_error    text,
  delivery_attempts integer   NOT NULL DEFAULT 0,

  -- PER SINK, because "delivered" is not one fact when there is more than one
  -- place to deliver to.
  --
  -- This started as a single `notified_state` and the all-or-nothing rule that
  -- went with it: a transition counted as delivered only once EVERY sink had
  -- accepted it. That reasoning was sound in isolation — with two sinks
  -- configured, marking it done because one worked means the other never
  -- receives that alert — and it produced a worse failure than the one it
  -- prevented. One permanently-broken sink meant the transition was never
  -- consumed, so every HEALTHY sink received the identical alert again on every
  -- tick, forever. A channel paged every sixty seconds about one incident is
  -- muted within the hour, which is the exact outcome this whole module is
  -- written to avoid, arrived at by way of being careful.
  --
  -- So the state is kept per sink: `{"<key>": "firing"}`. A sink that is down
  -- misses nothing — its own entry does not advance, so it is retried — and a
  -- sink that is healthy is told once. `notified_state` above is retained as the
  -- state EVERY sink has acknowledged, which is what the panel reads.
  --
  -- The key is a hash of the URL rather than the URL: this column is rendered.
  notified_sinks    jsonb     NOT NULL DEFAULT '{}'::jsonb
);

-- CREATE TABLE IF NOT EXISTS does nothing once the table is there, so a column
-- added after the first release needs its own statement. See the header.
ALTER TABLE evestack.alert_state
  ADD COLUMN IF NOT EXISTS notified_sinks jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Every POST we made, whether or not it worked.
--
-- Kept because "did my webhook ever fire?" is the first question anyone asks of
-- an alerting integration, and the honest answer needs a record rather than a
-- guess. Pruned by retention, not by count — see pruneDeliveries().
CREATE TABLE IF NOT EXISTS evestack.alert_deliveries (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sent_at      timestamptz NOT NULL DEFAULT now(),

  -- slack | discord | webhook — the payload shape, not the vendor.
  sink         text        NOT NULL,
  -- The URL with everything after the host removed. Slack and Discord both put
  -- the shared secret in the PATH, so storing the full URL would put a working
  -- credential in a table the dashboard renders.
  target       text        NOT NULL,

  -- What was in the message: [{id, kind, from, to, severity}]. Enough to answer
  -- "was I told about this one" without storing the prose twice.
  transitions  jsonb       NOT NULL,

  ok           boolean     NOT NULL,
  http_status  integer,
  error        text,
  duration_ms  integer     NOT NULL
);

CREATE INDEX IF NOT EXISTS alert_deliveries_sent_at_idx
  ON evestack.alert_deliveries (sent_at DESC);

-- Exactly one sender at a time.
--
-- The delivery loop runs inside the dashboard process, and a deployment is free
-- to run two of them behind a proxy. Without this, both would evaluate, both
-- would see the same transition, and both would POST it — so the first thing an
-- operator learns about their new alerting is that it double-sends.
--
-- One row, enforced by the CHECK: `id` can only ever be true, so a second
-- INSERT collides with the primary key rather than creating a second lease.
-- The claim itself is a conditional UPDATE ... RETURNING, which is atomic in
-- Postgres — see claimLease() for why that is enough and an advisory lock is
-- not needed.
CREATE TABLE IF NOT EXISTS evestack.alert_lease (
  id         boolean     PRIMARY KEY DEFAULT true CHECK (id),
  holder     text        NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now()
);
