-- evestack approval audit: who answered which human-in-the-loop request, when.
--
-- Lives beside the spans table in the `evestack` schema, for the same reason:
-- `workflow` belongs to world-postgres and evestack only ever reads it.
--
-- This is the record eve does not keep. eve's durable event log shows that a
-- request was answered and with which option, because that is what it needs to
-- resume the turn — it has no notion of WHO answered, since the protocol carries
-- no identity. A control plane that can approve a shell command and cannot say
-- who approved it is not one you should put in front of a production agent, so
-- the answer is recorded here at the moment the decision is made.
--
-- Retention is deliberately unbounded. This is the row you want a year later,
-- when someone asks why the agent deleted the thing it deleted.
--
-- Every statement is guarded, so this file is safe to run on every boot.

CREATE SCHEMA IF NOT EXISTS evestack;

CREATE TABLE IF NOT EXISTS evestack.approvals (
  id            bigserial   PRIMARY KEY,
  decided_at    timestamptz NOT NULL DEFAULT now(),

  session_id    text        NOT NULL,
  turn_id       text,
  request_id    text        NOT NULL,
  -- "tool-approval", "question", "session-limit" — eve's own request kinds.
  request_kind  text,
  -- Null for anything that is not a tool approval.
  tool_name     text,

  -- The option id actually sent to eve ("approve" / "deny" / a model-authored
  -- option id), plus the freeform text when the request allowed one.
  option_id     text,
  answer_text   text,

  -- Identity of the human, as far as the deployment can prove it. NULL means
  -- nothing in front of the dashboard identified the caller — which is itself
  -- worth recording rather than papering over with a default like "admin".
  approver      text,
  -- Where the identity came from: "session" (a cookie this deployment signed),
  -- "basic" (credentials it verified), "forwarded-user" / "forwarded-email" /
  -- "header" (a proxy said so, and only recorded at all when
  -- EVESTACK_TRUSTED_PROXY declares that proxy trusted), or "unidentified".
  --
  -- Keeps a proxy-supplied name from being mistaken for a proven one. Rows
  -- written before EVESTACK_TRUSTED_PROXY existed carry forwarded-* values that
  -- nothing verified: any caller could set those headers. Treat a forwarded-*
  -- row older than that change as unidentified.
  approver_via  text        NOT NULL DEFAULT 'unidentified',

  remote_addr   text,
  user_agent    text
);

CREATE INDEX IF NOT EXISTS approvals_session_idx ON evestack.approvals (session_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS approvals_recent_idx  ON evestack.approvals (decided_at DESC);
