-- Additive schema. Never mutates workflow tables or existing developer schedules.
CREATE SCHEMA IF NOT EXISTS evestack;
CREATE TABLE IF NOT EXISTS evestack.routines (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  prompt text NOT NULL CHECK (length(prompt) BETWEEN 1 AND 20000),
  cron text NOT NULL,
  time_zone text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  archived boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1,
  next_due timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS evestack.routine_runs (
  id uuid PRIMARY KEY,
  routine_id uuid NOT NULL REFERENCES evestack.routines(id),
  revision integer NOT NULL,
  scheduled_at timestamptz NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('clock', 'manual', 'catchup')),
  state text NOT NULL CHECK (state IN ('claimed', 'dispatching', 'running', 'awaiting_approval', 'completed', 'failed', 'unknown', 'skipped', 'resolved')),
  request_key uuid UNIQUE,
  snapshot jsonb NOT NULL,
  session_id text,
  error text,
  skipped_count integer DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS routine_occurrence ON evestack.routine_runs(routine_id, scheduled_at) WHERE trigger <> 'manual';
-- Unknown dispatches stay active until an operator resolves them: never repeat potentially accepted work.
CREATE UNIQUE INDEX IF NOT EXISTS routine_active ON evestack.routine_runs(routine_id) WHERE state IN ('claimed', 'dispatching', 'running', 'awaiting_approval', 'unknown');
CREATE INDEX IF NOT EXISTS routine_due ON evestack.routines(next_due) WHERE enabled AND NOT archived;
CREATE INDEX IF NOT EXISTS routine_history ON evestack.routine_runs(routine_id, created_at DESC);
CREATE TABLE IF NOT EXISTS evestack.routine_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  routine_id uuid NOT NULL REFERENCES evestack.routines(id),
  revision integer NOT NULL,
  action text NOT NULL,
  actor text,
  actor_via text NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS evestack.routine_notifications (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES evestack.routine_runs(id),
  routine_id uuid NOT NULL REFERENCES evestack.routines(id),
  event_key text NOT NULL,
  sink_key text NOT NULL,
  sink_kind text NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','failed','retired')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  holder uuid,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  UNIQUE(run_id,event_key,sink_key)
);
CREATE INDEX IF NOT EXISTS routine_notification_pending ON evestack.routine_notifications(next_attempt) WHERE state IN ('pending','sending');
