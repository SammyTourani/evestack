-- What a human deleted from the agent's long-term memory, and when.
--
-- The `evestack.memories` table itself belongs to the agent template, which
-- creates it on first `remember`. This file only adds the audit trail for
-- deletions made from the dashboard.
--
-- It exists for the same reason the approvals log does: a memory that vanishes
-- changes what the agent believes, and "why does it no longer know that?" needs
-- an answer that is not a shrug. The deleted content is kept verbatim, because
-- an audit row saying only "memory 41 was deleted" cannot answer the question
-- anyone will actually ask.
--
-- The agent's own `forget` tool is a different path and is gated behind
-- `approval: always()`; those land in evestack.approvals.
--
-- Every statement is guarded, so this file is safe to run on every boot.

CREATE SCHEMA IF NOT EXISTS evestack;

CREATE TABLE IF NOT EXISTS evestack.memory_deletions (
  id           bigserial   PRIMARY KEY,
  deleted_at   timestamptz NOT NULL DEFAULT now(),

  memory_id    text        NOT NULL,
  content      text        NOT NULL,
  tags         text[]      NOT NULL DEFAULT '{}',
  -- The session that originally saved the memory, when the row recorded one.
  session_id   text,
  created_at   timestamptz,

  -- Same identity vocabulary as evestack.approvals ("session", "basic",
  -- "forwarded-user", "forwarded-email", "header", "unidentified"): never let a
  -- proxy-supplied name be mistaken for a proven one. The forwarded-* values
  -- are only recorded when EVESTACK_TRUSTED_PROXY declares a proxy trusted.
  actor        text,
  actor_via    text        NOT NULL DEFAULT 'unidentified'
);

CREATE INDEX IF NOT EXISTS memory_deletions_recent_idx ON evestack.memory_deletions (deleted_at DESC);
