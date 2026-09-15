import { query } from "./db";
import { refreshFacts } from "./facts";
import {
  getSessionTree,
  listSessions,
  nextSessionCursor,
  type SessionCursor,
} from "./queries";
import { sessionOutcome } from "../app/sessions/rollup";

export async function listTasks(
  limit = 30,
  cursor: SessionCursor | null = null,
  search = "",
) {
  await refreshFacts();
  const sessions = await listSessions(limit, cursor, search);
  const facts = sessions.length
    ? await query<{
        session_id: string;
        outcomes: string[];
        cost_usd: string | null;
        unpriced: number;
        latest: Date | null;
      }>(
        `
    SELECT session_id, array_agg(DISTINCT outcome) AS outcomes, sum(cost_usd) AS cost_usd,
      count(*) FILTER (WHERE NOT priced)::int AS unpriced, max(started_at) AS latest
    FROM evestack.fact_turn WHERE session_id = ANY($1::text[]) GROUP BY session_id`,
        [sessions.map((session) => session.id)],
      )
    : [];
  const byId = new Map(facts.map((fact) => [fact.session_id, fact]));
  return {
    tasks: sessions.map((session) => {
      const fact = byId.get(session.id);
      return {
        ...session,
        outcome: sessionOutcome(fact?.outcomes ?? []),
        costUsd: fact?.cost_usd == null ? null : Number(fact.cost_usd),
        unpricedTurns: Number(fact?.unpriced ?? 0),
        lastActivity: fact?.latest?.toISOString() ?? session.createdAt,
      };
    }),
    nextCursor: nextSessionCursor(sessions, limit),
  };
}

export async function getTask(id: string) {
  // Fetch metadata directly. getSession() intentionally loads the full tree for
  // the diagnostic rollup and would defeat this API's bounded history window.
  const [row] = await query<{
    id: string;
    status: string;
    attributes: Record<string, string>;
    created_at: Date;
    completed_at: Date | null;
  }>(
    "SELECT id,status,attributes,created_at,completed_at FROM workflow.workflow_runs WHERE id=$1 AND attributes->>'$eve.type'='session'",
    [id],
  );
  if (!row) return null;
  const session = {
    id: row.id,
    status: row.status,
    title: row.attributes["$eve.title"] ?? null,
    trigger: row.attributes["$eve.trigger"] ?? null,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
  };
  const runs = await getSessionTree(id, 501);
  return {
    session,
    runs: runs.slice(-500),
    runsTruncated: runs.length > 500,
    runsWindow: "latest",
    runLimit: 500,
    workspaceUrl: `/chat?session=${encodeURIComponent(id)}`,
    evidenceUrl: `/sessions/${encodeURIComponent(id)}`,
  };
}
