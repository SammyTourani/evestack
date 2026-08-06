import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ApproverIdentity } from "./approvals";
import { describeDbError, query } from "./db";

/**
 * Read and curate the agent's long-term memory.
 *
 * The table belongs to the agent template (`templates/default/lib/memory.ts`
 * creates it on first use), and the dashboard only ever reads and prunes it —
 * it never writes memories, because deciding what is worth remembering is the
 * agent's job.
 *
 * Why this page exists at all: an agent with persistent memory is an agent that
 * can be quietly wrong forever. A single bad row — a stale fact, a name it
 * misheard, something a user asked it to forget — keeps surfacing in recall and
 * shaping answers, and nothing in eve or in any hosted memory product lets you
 * simply look at the list. Mem0, Zep and Letta are all hosted-or-heavy, and none
 * of them offers "see and edit what your agent believes" on your own hardware.
 * The rows are already in your Postgres. Reading them is not a feature so much
 * as an obligation.
 *
 * Deliberately NOT semantic search. Searching by embedding would need the
 * dashboard to hold a model key and pay per keystroke to answer "what does it
 * know about X". A trigram/ILIKE match over content and tags answers the
 * question a human actually asks — "what did it save about invoices?" — for
 * nothing, and `recall` remains the semantic path.
 */

export interface MemoryRow {
  readonly id: string;
  readonly content: string;
  readonly tags: string[];
  readonly sessionId: string | null;
  readonly createdAt: string;
}

export interface MemoryPage {
  readonly rows: MemoryRow[];
  readonly total: number;
  /** False when the agent has never run its memory bootstrap. */
  readonly tableExists: boolean;
}

async function memoriesTableExists(): Promise<boolean> {
  const rows = await query<{ exists: boolean }>(
    `SELECT to_regclass('evestack.memories') IS NOT NULL AS exists`,
  );
  return rows[0]?.exists === true;
}

export async function listMemories(options: {
  search?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<MemoryPage> {
  // The table is created lazily by the agent's first `remember`, so a fresh
  // install has none. Querying it anyway would surface a Postgres error where
  // the honest answer is "nothing saved yet".
  if (!(await memoriesTableExists())) {
    return { rows: [], total: 0, tableExists: false };
  }

  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 100)), 500);
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));
  const search = options.search?.trim();

  // `array_to_string` so a tag match works with the same ILIKE as content —
  // cheaper than a second predicate and it lets one box search both.
  const where = search ? `WHERE content ILIKE $1 OR array_to_string(tags, ' ') ILIKE $1` : "";
  const params: unknown[] = search ? [`%${search}%`] : [];

  const counted = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM evestack.memories ${where}`,
    params,
  );

  const rows = await query<Record<string, unknown>>(
    `SELECT id, content, tags, session_id, created_at
     FROM evestack.memories ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );

  return {
    rows: rows.map((raw) => ({
      id: String(raw.id),
      content: String(raw.content ?? ""),
      tags: Array.isArray(raw.tags) ? (raw.tags as string[]) : [],
      sessionId: (raw.session_id as string) ?? null,
      createdAt: new Date(raw.created_at as string | Date).toISOString(),
    })),
    total: Number(counted[0]?.count ?? 0),
    tableExists: true,
  };
}

/**
 * Delete a memory.
 *
 * The dashboard offers no edit, only delete, and that is a considered limit
 * rather than a missing feature: every row carries an embedding computed from
 * its content, and rewriting the text without recomputing the vector would
 * leave a memory that reads one way and retrieves another — the worst possible
 * state for something the agent trusts. Deleting is unambiguous, and the agent
 * can be told the corrected fact, which re-embeds it properly.
 *
 * Note that the agent's own `forget` tool is gated behind `approval: always()`.
 * This path is a human acting directly on their own database, which is a
 * different act from the agent asking to delete something — but it is still
 * recorded, because an unexplained gap in memory is its own kind of bug.
 */
export async function deleteMemory(
  id: string,
  identity: ApproverIdentity,
): Promise<MemoryRow | null> {
  if (!(await memoriesTableExists())) return null;
  const rows = await query<Record<string, unknown>>(
    `DELETE FROM evestack.memories WHERE id = $1
     RETURNING id, content, tags, session_id, created_at`,
    [id],
  );
  const raw = rows[0];
  if (!raw) return null;

  const row: MemoryRow = {
    id: String(raw.id),
    content: String(raw.content ?? ""),
    tags: Array.isArray(raw.tags) ? (raw.tags as string[]) : [],
    sessionId: (raw.session_id as string) ?? null,
    createdAt: new Date(raw.created_at as string | Date).toISOString(),
  };

  // Audited after the delete, and never allowed to fail the delete: the row is
  // already gone, and throwing here would report failure for something that
  // succeeded. A missing audit row is visible in the log; a lie is not.
  try {
    await ensureMemoryAuditSchema();
    await query(
      `INSERT INTO evestack.memory_deletions
         (memory_id, content, tags, session_id, created_at, actor, actor_via)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        row.id,
        row.content,
        row.tags,
        row.sessionId,
        row.createdAt,
        identity.approver,
        identity.via,
      ],
    );
  } catch (error) {
    // Swallowed on purpose — see above — but not silently. The comment above
    // promised "a missing audit row is visible in the log" while this block was
    // an empty catch containing only a comment, so nothing was ever written
    // anywhere. Deleting a memory is irreversible; losing the record of who did
    // it, without a trace, is the one outcome this whole path exists to prevent.
    console.warn(
      `[evestack] memory ${row.id} was deleted but its audit row could not be written: ` +
        `${describeDbError(error)}`,
    );
  }

  return row;
}

export interface MemoryDeletionRow {
  readonly id: string;
  readonly deletedAt: string;
  readonly memoryId: string;
  readonly content: string;
  readonly tags: string[];
  readonly actor: string | null;
  readonly actorVia: string;
}

/**
 * Kept deliberately, despite having no caller.
 *
 * Every other zero-consumer export in this dashboard was deleted; this one is
 * the only way to read an audit trail for an irreversible action, and removing
 * it would leave `evestack.memory_deletions` write-only and reachable solely
 * through `psql`. The honest fix is a screen that calls this, not a smaller
 * surface — so it stays until that exists.
 */
export async function listMemoryDeletions(limit = 100): Promise<MemoryDeletionRow[]> {
  await ensureMemoryAuditSchema();
  const rows = await query<Record<string, unknown>>(
    `SELECT id, deleted_at, memory_id, content, tags, actor, actor_via
     FROM evestack.memory_deletions ORDER BY deleted_at DESC, id DESC LIMIT $1`,
    [limit],
  );
  return rows.map((raw) => ({
    id: String(raw.id),
    deletedAt: new Date(raw.deleted_at as string | Date).toISOString(),
    memoryId: String(raw.memory_id),
    content: String(raw.content ?? ""),
    tags: Array.isArray(raw.tags) ? (raw.tags as string[]) : [],
    actor: (raw.actor as string) ?? null,
    actorVia: String(raw.actor_via ?? "unidentified"),
  }));
}

let auditSchemaReady: Promise<void> | null = null;

function ensureMemoryAuditSchema(): Promise<void> {
  if (!auditSchemaReady) {
    auditSchemaReady = query(readAuditSql())
      .then(() => undefined)
      .catch((error: unknown) => {
        auditSchemaReady = null;
        throw error;
      });
  }
  return auditSchemaReady;
}

function readAuditSql(): string {
  let dir = process.cwd();
  for (let up = 0; up < 5; up += 1) {
    try {
      return readFileSync(join(dir, "sql", "memory-audit.sql"), "utf8");
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error(
    `Could not find sql/memory-audit.sql above ${process.cwd()}. ` +
      "Run the dashboard from packages/dashboard, or apply the file by hand.",
  );
}
