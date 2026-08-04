import { query } from "./db";
import { costUsd } from "./pricing";

/**
 * The data contract, verified against a live database on 2026-08-04.
 *
 * One user message produces three rows in workflow.workflow_runs:
 *   $eve.type = "session"  → name workflow//eve//workflowEntry, stays "running"
 *                            while the session is open
 *   $eve.type = "turn"     → name workflow//eve//turnWorkflow, carries model and
 *                            token counts, completes per turn
 *   (no $eve.type)         → name workflow//eve//sessionTimeoutWorkflow, internal
 *                            bookkeeping
 *
 * That third kind is why every query filters on `$eve.type`. Without it the
 * session list fills with timeout workflows that mean nothing to a user.
 *
 * Subagents appear as $eve.type = "subagent" with $eve.parent pointing at their
 * caller, so the same parent/root columns build the whole tree.
 */

export interface SessionRow {
  id: string;
  status: string;
  title: string | null;
  trigger: string | null;
  createdAt: string;
  completedAt: string | null;
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  models: string[];
  costUsd: number;
}

export interface TurnRow {
  id: string;
  type: string;
  parent: string | null;
  root: string | null;
  status: string;
  model: string | null;
  subagent: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  toolCount: number;
  errorCode: string | null;
  costUsd: number;
  /**
   * True when a turn reached a terminal state without ever recording a model
   * call.
   *
   * This exists because eve's stream and its workflow store disagree. A turn
   * killed by a provider rate limit emits `turn.failed` on the stream, but the
   * workflow row still reads `status = 'completed'` — the workflow handled the
   * error, so as far as it is concerned nothing failed. Trusting `status` alone
   * would paint a green "completed" badge on a turn that produced nothing,
   * which is worse than showing no badge at all.
   *
   * eve writes `$eve.model` and the token tags only once a model call reports
   * usage, so their absence on a finished turn is the surviving evidence that
   * the call never landed.
   */
  noModelCall: boolean;
}

const NUM = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Session list with per-session token and cost rollups.
 *
 * Tokens live on turn rows, not session rows, so the aggregate joins children
 * back to their parent. Cost is computed here rather than read from a span:
 * eve only emits `gen_ai.usage.cost` for AI-Gateway-served calls, and a
 * self-hosted agent calls its provider directly, so nothing upstream knows the
 * price.
 */
export async function listSessions(limit = 100, offset = 0): Promise<SessionRow[]> {
  const rows = await query<Record<string, unknown>>(
    `
    SELECT
      s.id,
      s.status,
      s.attributes->>'$eve.title'   AS title,
      s.attributes->>'$eve.trigger' AS trigger,
      s.created_at, s.completed_at,
      COALESCE(t.turn_count, 0)      AS turn_count,
      COALESCE(t.input_tokens, 0)    AS input_tokens,
      COALESCE(t.output_tokens, 0)   AS output_tokens,
      COALESCE(t.cache_read, 0)      AS cache_read_tokens,
      COALESCE(t.models, ARRAY[]::text[]) AS models,
      COALESCE(t.cost_parts, ARRAY[]::text[]) AS cost_parts
    FROM workflow.workflow_runs s
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) FILTER (WHERE c.attributes->>'$eve.type' = 'turn') AS turn_count,
        SUM((c.attributes->>'$eve.input_tokens')::bigint)           AS input_tokens,
        SUM((c.attributes->>'$eve.output_tokens')::bigint)          AS output_tokens,
        SUM((c.attributes->>'$eve.cache_read_tokens')::bigint)      AS cache_read,
        ARRAY_AGG(DISTINCT c.attributes->>'$eve.model')
          FILTER (WHERE c.attributes->>'$eve.model' IS NOT NULL)    AS models,
        ARRAY_AGG(
          (c.attributes->>'$eve.model') || '|' ||
          COALESCE(c.attributes->>'$eve.input_tokens','0') || '|' ||
          COALESCE(c.attributes->>'$eve.output_tokens','0') || '|' ||
          COALESCE(c.attributes->>'$eve.cache_read_tokens','0')
        ) FILTER (WHERE c.attributes->>'$eve.model' IS NOT NULL)    AS cost_parts
      FROM workflow.workflow_runs c
      WHERE c.attributes->>'$eve.root' = s.id
         OR c.attributes->>'$eve.parent' = s.id
    ) t ON TRUE
    WHERE s.attributes->>'$eve.type' = 'session'
    ORDER BY s.created_at DESC
    LIMIT $1 OFFSET $2
    `,
    [limit, offset],
  );

  return rows.map((r) => ({
    id: String(r.id),
    status: String(r.status),
    title: (r.title as string) ?? null,
    trigger: (r.trigger as string) ?? null,
    createdAt: new Date(r.created_at as string).toISOString(),
    completedAt: r.completed_at ? new Date(r.completed_at as string).toISOString() : null,
    turnCount: NUM(r.turn_count),
    inputTokens: NUM(r.input_tokens),
    outputTokens: NUM(r.output_tokens),
    cacheReadTokens: NUM(r.cache_read_tokens),
    models: (r.models as string[]) ?? [],
    costUsd: sumCostParts((r.cost_parts as string[]) ?? []),
  }));
}

/** Every turn and subagent under a session, ordered for tree rendering. */
export async function getSessionTree(sessionId: string): Promise<TurnRow[]> {
  const rows = await query<Record<string, unknown>>(
    `
    SELECT id, status, error_code, created_at, started_at, completed_at,
           attributes
    FROM workflow.workflow_runs
    WHERE (attributes->>'$eve.root' = $1
        OR attributes->>'$eve.parent' = $1
        OR id = $1)
      AND attributes->>'$eve.type' IS NOT NULL
    ORDER BY created_at ASC
    `,
    [sessionId],
  );

  return rows.map((r) => {
    const a = (r.attributes ?? {}) as Record<string, string>;
    const started = r.started_at ? new Date(r.started_at as string).getTime() : null;
    const done = r.completed_at ? new Date(r.completed_at as string).getTime() : null;
    const input = NUM(a["$eve.input_tokens"]);
    const output = NUM(a["$eve.output_tokens"]);
    const cacheRead = NUM(a["$eve.cache_read_tokens"]);
    return {
      id: String(r.id),
      type: a["$eve.type"] ?? "unknown",
      parent: a["$eve.parent"] ?? null,
      root: a["$eve.root"] ?? null,
      status: String(r.status),
      model: a["$eve.model"] ?? null,
      subagent: a["$eve.subagent"] ?? null,
      createdAt: new Date(r.created_at as string).toISOString(),
      startedAt: r.started_at ? new Date(r.started_at as string).toISOString() : null,
      completedAt: r.completed_at ? new Date(r.completed_at as string).toISOString() : null,
      durationMs: started !== null && done !== null ? done - started : null,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: NUM(a["$eve.cache_write_tokens"]),
      toolCount: NUM(a["$eve.tool_count"]),
      errorCode: (r.error_code as string) ?? null,
      costUsd: costUsd(a["$eve.model"] ?? null, input, output, cacheRead),
      noModelCall:
        (a["$eve.type"] === "turn") &&
        !a["$eve.model"] &&
        r.completed_at !== null,
    };
  });
}

export async function getSession(sessionId: string): Promise<SessionRow | null> {
  const [row] = await query<Record<string, unknown>>(
    `SELECT id, status, attributes, created_at, completed_at
     FROM workflow.workflow_runs WHERE id = $1`,
    [sessionId],
  );
  if (!row) return null;
  const tree = await getSessionTree(sessionId);
  const turns = tree.filter((t) => t.type === "turn");
  const a = (row.attributes ?? {}) as Record<string, string>;
  return {
    id: String(row.id),
    status: String(row.status),
    title: a["$eve.title"] ?? null,
    trigger: a["$eve.trigger"] ?? null,
    createdAt: new Date(row.created_at as string).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at as string).toISOString() : null,
    turnCount: turns.length,
    inputTokens: turns.reduce((s, t) => s + t.inputTokens, 0),
    outputTokens: turns.reduce((s, t) => s + t.outputTokens, 0),
    cacheReadTokens: turns.reduce((s, t) => s + t.cacheReadTokens, 0),
    models: [...new Set(turns.map((t) => t.model).filter((m): m is string => !!m))],
    costUsd: turns.reduce((s, t) => s + t.costUsd, 0),
  };
}

/** Totals across every session, for the header stat row. */
export async function getTotals(): Promise<{
  sessions: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}> {
  const [row] = await query<Record<string, unknown>>(
    `
    SELECT
      COUNT(*) FILTER (WHERE attributes->>'$eve.type' = 'session') AS sessions,
      COUNT(*) FILTER (WHERE attributes->>'$eve.type' = 'turn')    AS turns,
      COALESCE(SUM((attributes->>'$eve.input_tokens')::bigint), 0)  AS input_tokens,
      COALESCE(SUM((attributes->>'$eve.output_tokens')::bigint), 0) AS output_tokens,
      COALESCE(ARRAY_AGG(
        (attributes->>'$eve.model') || '|' ||
        COALESCE(attributes->>'$eve.input_tokens','0') || '|' ||
        COALESCE(attributes->>'$eve.output_tokens','0') || '|' ||
        COALESCE(attributes->>'$eve.cache_read_tokens','0')
      ) FILTER (WHERE attributes->>'$eve.model' IS NOT NULL), ARRAY[]::text[]) AS cost_parts
    FROM workflow.workflow_runs
    `,
  );
  return {
    sessions: NUM(row?.sessions),
    turns: NUM(row?.turns),
    inputTokens: NUM(row?.input_tokens),
    outputTokens: NUM(row?.output_tokens),
    costUsd: sumCostParts((row?.cost_parts as string[]) ?? []),
  };
}

function sumCostParts(parts: string[]): number {
  let total = 0;
  for (const part of parts) {
    const [model, input, output, cacheRead] = part.split("|");
    total += costUsd(model ?? null, NUM(input), NUM(output), NUM(cacheRead));
  }
  return total;
}
