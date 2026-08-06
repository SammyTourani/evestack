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
-- SCOPE, and a gap worth knowing about. The agent's own `forget` tool is a
-- different path, gated behind `approval: always()`, and it writes NOTHING
-- here. What it leaves is a row in evestack.approvals, and that row is thinner
-- than it sounds: the table records session, request, tool_name, the option the
-- human picked and who they were, but NOT the tool's arguments. So an
-- agent-initiated deletion is recoverable as "somebody approved a `forget` at
-- 14:02" and no further -- not which memory, not what it said. The row it
-- described is gone by then, so nothing else can answer either.
--
-- That is a smaller guarantee than the paragraph above asks for, and it is
-- written down rather than fixed because closing it means the agent template
-- writing into a table the dashboard owns. Verified 2026-08: deleting from the
-- dashboard does record here, verbatim content and actor included; deleting
-- through the tool does not.
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
