import { getSessionSnapshot, type InputRequest } from "./agent-client";
import { query } from "./db";

export interface DecisionQueue {
  items: { sessionId: string; title: string | null; request: InputRequest }[];
  unknown: { sessionId: string; reason: string }[];
  checked: number;
  candidates: number;
  nextOffset: number | null;
  checkedAt: string;
}

/** A bounded live sweep. Runtime status alone cannot distinguish an idle session from a decision. */
export async function listPendingDecisions(offset = 0): Promise<DecisionQueue> {
  const limit = 20;
  const rows = await query<{ id: string; title: string | null; total: number }>(
    `
    SELECT id, attributes->>'$eve.title' AS title, count(*) OVER ()::int AS total
    FROM workflow.workflow_runs
    WHERE attributes->>'$eve.type' = 'session' AND status = 'running'
    ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  const result: DecisionQueue = {
    items: [],
    unknown: [],
    checked: 0,
    candidates: rows[0]?.total ?? 0,
    nextOffset: null,
    checkedAt: new Date().toISOString(),
  };
  // Limit concurrent stream probes so opening this page cannot saturate the agent.
  for (let start = 0; start < rows.length; start += 5) {
    await Promise.all(
      rows.slice(start, start + 5).map(async (row) => {
        try {
          const state = await getSessionSnapshot(row.id, { timeoutMs: 1500 });
          result.checked++;
          for (const request of state.pendingRequests)
            result.items.push({ sessionId: row.id, title: row.title, request });
        } catch (error) {
          result.unknown.push({
            sessionId: row.id,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );
  }
  result.items.sort(
    (a, b) =>
      a.sessionId.localeCompare(b.sessionId) ||
      a.request.requestId.localeCompare(b.request.requestId),
  );
  result.nextOffset =
    offset + rows.length < result.candidates ? offset + rows.length : null;
  return result;
}
