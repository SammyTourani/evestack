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

/**
 * The token and cost rollup over some set of runs.
 *
 * It is one named type used twice on purpose. listSessions() and getSession()
 * used to expose identically-named `costUsd`, `inputTokens`, `outputTokens`,
 * `cacheReadTokens` and `models` fields computed over DIFFERENT rows —
 * listSessions summed every child of the session (turns AND subagents, since its
 * LATERAL carried no `$eve.type` filter even though `turn_count` on the same
 * line did), while getSession summed only `type = 'turn'`. Two readings of the
 * same field name is not a rounding difference: a session that spawns subagents
 * costs more on the list than on its own page.
 *
 * The evidence that this was known and worked around rather than noticed and
 * fixed: app/sessions/[id]/page.tsx:205-207 adds the subagent runs back onto
 * getSession()'s figure "to keep the two pages agreeing", which every other
 * caller has to remember to do — /api/health/detail did not, and served the
 * inclusive numbers while app/traces/[id] and app/evals/[id] read the exclusive
 * ones out of the same-named fields.
 *
 * So the names are turn-scoped everywhere now, matching `turnCount`, and the
 * inclusive figure keeps its own name where it cannot be mistaken for the other.
 */
export interface SessionRollup {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  models: string[];
  costUsd: number;
}

export interface SessionRow extends SessionRollup {
  id: string;
  status: string;
  title: string | null;
  trigger: string | null;
  createdAt: string;
  completedAt: string | null;
  /** Turns only — as are the inherited token, model and cost fields. */
  turnCount: number;
  /**
   * The same rollup over every run BENEATH the session: turns plus subagents.
   *
   * This is what listSessions() used to return under the bare names, so a caller
   * that wants total spend for a session — app/page.tsx's Cost column,
   * /api/health/detail, the patch-up in app/sessions/[id]/page.tsx — asks for it
   * here and gets the same number it used to, without any of them having to
   * reconstruct it from the run tree.
   */
  includingSubagents: SessionRollup;
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
      COALESCE(t.cost_parts, ARRAY[]::text[]) AS cost_parts,
      COALESCE(t.all_input_tokens, 0)  AS all_input_tokens,
      COALESCE(t.all_output_tokens, 0) AS all_output_tokens,
      COALESCE(t.all_cache_read, 0)    AS all_cache_read_tokens,
      COALESCE(t.all_models, ARRAY[]::text[]) AS all_models,
      COALESCE(t.all_cost_parts, ARRAY[]::text[]) AS all_cost_parts
    FROM workflow.workflow_runs s
    LEFT JOIN LATERAL (
      -- Both grains in one pass over the children. The attributes are unpacked
      -- once in the inner SELECT so that is_turn is written down a single time
      -- rather than repeated as a predicate on every aggregate — the divergence
      -- SessionRollup describes started as exactly that kind of missing repeat.
      -- (No backticks anywhere in this SQL: it is a template literal, and one
      -- inside it ends the string with a parse error nowhere near the cause.)
      SELECT
        COUNT(*) FILTER (WHERE c.is_turn)                  AS turn_count,
        SUM(c.input_tokens)      FILTER (WHERE c.is_turn)  AS input_tokens,
        SUM(c.output_tokens)     FILTER (WHERE c.is_turn)  AS output_tokens,
        SUM(c.cache_read_tokens) FILTER (WHERE c.is_turn)  AS cache_read,
        ARRAY_AGG(DISTINCT c.model)
          FILTER (WHERE c.is_turn AND c.model IS NOT NULL) AS models,
        ARRAY_AGG(c.cost_part)
          FILTER (WHERE c.is_turn AND c.model IS NOT NULL) AS cost_parts,
        SUM(c.input_tokens)      AS all_input_tokens,
        SUM(c.output_tokens)     AS all_output_tokens,
        SUM(c.cache_read_tokens) AS all_cache_read,
        ARRAY_AGG(DISTINCT c.model) FILTER (WHERE c.model IS NOT NULL) AS all_models,
        ARRAY_AGG(c.cost_part)      FILTER (WHERE c.model IS NOT NULL) AS all_cost_parts
      FROM (
        SELECT
          (attributes->>'$eve.type' = 'turn')                       AS is_turn,
          attributes->>'$eve.model'                                 AS model,
          COALESCE((attributes->>'$eve.input_tokens')::bigint, 0)      AS input_tokens,
          COALESCE((attributes->>'$eve.output_tokens')::bigint, 0)     AS output_tokens,
          COALESCE((attributes->>'$eve.cache_read_tokens')::bigint, 0) AS cache_read_tokens,
          (attributes->>'$eve.model') || '|' ||
            COALESCE(attributes->>'$eve.input_tokens','0') || '|' ||
            COALESCE(attributes->>'$eve.output_tokens','0') || '|' ||
            COALESCE(attributes->>'$eve.cache_read_tokens','0')     AS cost_part
        FROM workflow.workflow_runs
        WHERE attributes->>'$eve.root' = s.id
           OR attributes->>'$eve.parent' = s.id
      ) c
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
    includingSubagents: {
      inputTokens: NUM(r.all_input_tokens),
      outputTokens: NUM(r.all_output_tokens),
      cacheReadTokens: NUM(r.all_cache_read_tokens),
      models: (r.all_models as string[]) ?? [],
      costUsd: sumCostParts((r.all_cost_parts as string[]) ?? []),
    },
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
  // Every run BENEATH the session — turns plus subagents — which is the row set
  // listSessions()'s LATERAL matches. The session's own row is in the tree
  // (getSessionTree also matches `id = $1`) and carries no model or token tags,
  // so dropping it changes no figure; it is dropped to say what is meant.
  const beneath = tree.filter((t) => t.id !== sessionId);
  const a = (row.attributes ?? {}) as Record<string, string>;
  return {
    id: String(row.id),
    status: String(row.status),
    title: a["$eve.title"] ?? null,
    trigger: a["$eve.trigger"] ?? null,
    createdAt: new Date(row.created_at as string).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at as string).toISOString() : null,
    turnCount: turns.length,
    ...rollup(turns),
    includingSubagents: rollup(beneath),
  };
}

function rollup(runs: TurnRow[]): SessionRollup {
  return {
    inputTokens: runs.reduce((s, t) => s + t.inputTokens, 0),
    outputTokens: runs.reduce((s, t) => s + t.outputTokens, 0),
    cacheReadTokens: runs.reduce((s, t) => s + t.cacheReadTokens, 0),
    models: [...new Set(runs.map((t) => t.model).filter((m): m is string => !!m))],
    costUsd: runs.reduce((s, t) => s + t.costUsd, 0),
  };
}

/**
 * Totals across every session, for the header stat row.
 *
 * WHAT THIS QUERY USED TO DO, and why it could not stay. The cost arm was an
 * ARRAY_AGG with no WHERE and no LIMIT that built one "model|in|out|cacheRead"
 * text element PER ROW in workflow.workflow_runs and shipped the lot to Node for
 * `sumCostParts` to loop over. That is a text array the size of the table
 * crossing the wire on every call, and both callers make it permanent rather
 * than occasional: app/page.tsx renders it on the landing page, and
 * /api/health/detail is documented as monitor-pollable, so a 30-second monitor
 * asks for the whole history twice a minute forever.
 *
 * Cost is a function of the model, so per model is the grain the wire needs. The
 * aggregate is grouped in SQL and only one element per DISTINCT model comes
 * back — bounded by the price table rather than by how long the agent has been
 * running. Counts and token sums still span every row, and the arithmetic is
 * still `sumCostParts`; nothing about the returned shape moved.
 */
export async function getTotals(): Promise<{
  sessions: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}> {
  const [row] = await query<Record<string, unknown>>(
    `
    WITH per_model AS (
      SELECT
        attributes->>'$eve.model' AS model,
        COUNT(*) FILTER (WHERE attributes->>'$eve.type' = 'session') AS sessions,
        COUNT(*) FILTER (WHERE attributes->>'$eve.type' = 'turn')    AS turns,
        COALESCE(SUM((attributes->>'$eve.input_tokens')::bigint), 0)      AS input_tokens,
        COALESCE(SUM((attributes->>'$eve.output_tokens')::bigint), 0)     AS output_tokens,
        COALESCE(SUM((attributes->>'$eve.cache_read_tokens')::bigint), 0) AS cache_read_tokens,
        -- Billable input has to be clamped PER ROW to keep this identical to
        -- what costUsd() computed when it saw every row: it bills
        -- max(0, input - cacheRead), because eve reports cached reads inside the
        -- input total. Clamping after summing would let one row whose cache_read
        -- exceeds its own input cancel out another row's real input, and
        -- under-reporting spend is the failure mode lib/pricing.ts is most
        -- careful about — an unpriced run and a free run already look alike.
        COALESCE(SUM(GREATEST(
          COALESCE((attributes->>'$eve.input_tokens')::bigint, 0)
            - COALESCE((attributes->>'$eve.cache_read_tokens')::bigint, 0),
          0)), 0) AS billable_input
      FROM workflow.workflow_runs
      GROUP BY 1
    )
    SELECT
      COALESCE(SUM(sessions), 0)      AS sessions,
      COALESCE(SUM(turns), 0)         AS turns,
      COALESCE(SUM(input_tokens), 0)  AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      -- billable_input + cache_read_tokens, not input_tokens: sumCostParts hands
      -- the second field to costUsd as the input total, which subtracts the
      -- cached reads back out again. Reassembling it this way reproduces the
      -- per-row clamp above instead of re-clamping a sum.
      COALESCE(ARRAY_AGG(
        model || '|' || (billable_input + cache_read_tokens) || '|' ||
        output_tokens || '|' || cache_read_tokens
      ) FILTER (WHERE model IS NOT NULL), ARRAY[]::text[]) AS cost_parts
    FROM per_model
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

/**
 * "model|input|output|cacheRead" elements, priced and added up.
 *
 * The elements are per RUN from listSessions() and per MODEL from getTotals();
 * the arithmetic is the same either way because costUsd() is linear in tokens
 * once the billable-input clamp has been applied, which is why getTotals()
 * applies that clamp in SQL before it groups.
 */
function sumCostParts(parts: string[]): number {
  let total = 0;
  for (const part of parts) {
    const [model, input, output, cacheRead] = part.split("|");
    total += costUsd(model ?? null, NUM(input), NUM(output), NUM(cacheRead));
  }
  return total;
}
