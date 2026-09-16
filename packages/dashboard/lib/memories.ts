import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { ApproverIdentity } from "./approvals";
import { getPool, query } from "./db";

/**
 * Operator access to the template's memory table. Text search reads no model
 * keys and makes no embedding requests. Reviews and proposals live in separate
 * tables; changing a memory's text requires regenerating its vector.
 * The dashboard can inspect all owners. Agent-side recall and deletion retain
 * the template's separate principal rules.
 */

export interface MemoryRow {
  readonly id: string;
  readonly content: string;
  readonly tags: string[];
  readonly sessionId: string | null;
  readonly createdAt: string;
  readonly principalId: string | null;
  readonly version: string;
  readonly hash: string;
}

export interface MemoryPage {
  readonly rows: MemoryRow[];
  readonly total: number;
  /** False when the agent has never run its memory bootstrap. */
  readonly tableExists: boolean;
}

async function memoryShape(client?: PoolClient) {
  const sql = `SELECT to_regclass('evestack.memories') IS NOT NULL AS exists,
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('evestack.memories') AND attname='principal_id' AND NOT attisdropped) AS has_owner`;
  const rows = client
    ? (await client.query(sql)).rows
    : await query<{ exists: boolean; has_owner: boolean }>(sql);
  return rows[0] as { exists: boolean; has_owner: boolean };
}

export function memoryRow(raw: Record<string, unknown>): MemoryRow {
  const row = {
    id: String(raw.id),
    content: String(raw.content ?? ""),
    tags: Array.isArray(raw.tags) ? (raw.tags as string[]) : [],
    sessionId: typeof raw.session_id === "string" ? raw.session_id : null,
    createdAt: new Date(raw.created_at as string | Date).toISOString(),
    principalId: typeof raw.principal_id === "string" ? raw.principal_id : null,
    version: String(raw.memory_version ?? "unknown"),
  };
  return {
    ...row,
    hash: createHash("sha256").update(JSON.stringify(row)).digest("hex"),
  };
}

export class MemoryConflictError extends Error {
  constructor() {
    super(
      "This memory changed since you opened it. Refresh and review the current record before changing it.",
    );
  }
}

export async function memoryTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='3s'",
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function lockedMemory(
  client: PoolClient,
  id: string,
): Promise<MemoryRow | null> {
  const shape = await memoryShape(client);
  if (!shape.exists) return null;
  const raw = (
    await client.query(
      `SELECT id,content,tags,session_id,created_at,xmin::text AS memory_version,
    ${shape.has_owner ? "principal_id" : "NULL::text AS principal_id"}
    FROM evestack.memories WHERE id=$1 FOR UPDATE`,
      [id],
    )
  ).rows[0];
  return raw ? memoryRow(raw) : null;
}

export async function getMemory(id: string): Promise<MemoryRow | null> {
  const shape = await memoryShape();
  if (!shape.exists) return null;
  const rows = await query<Record<string, unknown>>(
    `SELECT id,content,tags,session_id,created_at,xmin::text AS memory_version,
    ${shape.has_owner ? "principal_id" : "NULL::text AS principal_id"}
    FROM evestack.memories WHERE id=$1`,
    [id],
  );
  return rows[0] ? memoryRow(rows[0]) : null;
}

export async function listMemories(
  options: {
    search?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<MemoryPage> {
  // The table is created lazily by the agent's first `remember`, so a fresh
  // install has none. Querying it anyway would surface a Postgres error where
  // the honest answer is "nothing saved yet".
  const shape = await memoryShape();
  if (!shape.exists) {
    return { rows: [], total: 0, tableExists: false };
  }

  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 100)), 500);
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));
  const search = options.search?.trim();

  // `array_to_string` so a tag match works with the same ILIKE as content —
  // cheaper than a second predicate and it lets one box search both.
  const where = search
    ? `WHERE content ILIKE $1 OR array_to_string(tags, ' ') ILIKE $1`
    : "";
  const params: unknown[] = search ? [`%${search}%`] : [];

  const counted = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM evestack.memories ${where}`,
    params,
  );

  const rows = await query<Record<string, unknown>>(
    `SELECT id, content, tags, session_id, created_at, xmin::text AS memory_version,
       ${shape.has_owner ? "principal_id" : "NULL::text AS principal_id"}
     FROM evestack.memories ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );

  return {
    rows: rows.map(memoryRow),
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
  expectedHash?: string,
): Promise<MemoryRow | null> {
  if (!(await memoryShape()).exists) return null;
  await ensureMemoryAuditSchema();
  return memoryTransaction(async (client) => {
    const row = await lockedMemory(client, id);
    if (!row) return null;
    if (expectedHash !== undefined && row.hash !== expectedHash)
      throw new MemoryConflictError();
    await client.query("DELETE FROM evestack.memories WHERE id=$1", [id]);
    await client.query(
      `INSERT INTO evestack.memory_deletions
         (memory_id, content, tags, session_id, created_at, actor, actor_via, principal_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        row.id,
        row.content,
        row.tags,
        row.sessionId,
        row.createdAt,
        identity.approver,
        identity.via,
        row.principalId,
      ],
    );
    return row;
  });
}

export interface MemoryDeletionRow {
  readonly id: string;
  readonly deletedAt: string;
  readonly memoryId: string;
  readonly content: string;
  readonly tags: string[];
  readonly actor: string | null;
  readonly actorVia: string;
  readonly principalId: string | null;
}

/**
 * Read the deletion trail back.
 *
 * THIS NOW HAS A CALLER, and that is the whole point of it. The comment here
 * used to open "Kept deliberately, despite having no caller" and argue that
 * deleting the function would leave `evestack.memory_deletions` write-only and
 * reachable solely through `psql` — true, but it described the state the code
 * was already in: `deleteMemory` above wrote an audit row on every permanent
 * delete and nothing in the product ever read one. An audit trail with no
 * reader is not a weaker compliance surface than one with a reader; it is not a
 * compliance surface, because "why does the agent no longer know that?" still
 * gets a shrug from everyone without a database shell. The screen the old
 * comment was waiting for is `app/memory/page.tsx:87`, the "Recently deleted"
 * section under the memory list.
 *
 * `ensureMemoryAuditSchema` runs first so a reader on a deployment that has
 * never deleted anything gets an empty list rather than `relation
 * "evestack.memory_deletions" does not exist`. It is DDL, and it is why the
 * caller reads this in its own try/catch: a role without CREATE fails HERE and
 * must not take the memory list down with it, nor be rendered as "nothing was
 * deleted".
 */
export async function listMemoryDeletions(
  limit = 100,
): Promise<MemoryDeletionRow[]> {
  await ensureMemoryAuditSchema();
  const rows = await query<Record<string, unknown>>(
    `SELECT id, deleted_at, memory_id, content, tags, actor, actor_via, principal_id
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
    principalId: typeof raw.principal_id === "string" ? raw.principal_id : null,
  }));
}

let auditSchemaReady: Promise<void> | null = null;

export function ensureMemoryAuditSchema(): Promise<void> {
  if (!auditSchemaReady) {
    auditSchemaReady = memoryTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(7141506)");
      await client.query(readAuditSql());
    })
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
