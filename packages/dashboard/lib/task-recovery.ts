import { getPool } from "./db";
import { matchesSpanFamily, sqlSpanFamily, TOOL_CALL_SPANS } from "./span-families";

interface RecoveryTurn {
  id: string;
  status: string;
  error_code: string | null;
  model: string | null;
  created_at: Date;
  completed_at: Date | null;
}
interface RecoverySpan {
  span_id: string;
  name: string;
  status_code: number;
  status_message: string | null;
  end_time: Date | null;
  response_text: string | null;
  response_truncated: boolean;
}

/** Inputs are newest first; a later completed turn does not erase an earlier failure. */
export function recoveryEvidence(turns: RecoveryTurn[], spans: RecoverySpan[], sessionId: string) {
  const turnLink = (id: string) => `/sessions/${encodeURIComponent(sessionId)}?turn=${encodeURIComponent(id)}`;
  const spanLink = (id: string) => `/traces/${encodeURIComponent(sessionId)}#s-${encodeURIComponent(id)}`;
  const failed = turns.find((turn) => turn.error_code || ["failed", "errored", "cancelled"].includes(turn.status) || (turn.completed_at && !turn.model));
  const completed = turns.find((turn) => turn.status === "completed" && !turn.error_code && turn.model);
  const action = spans.find((span) => matchesSpanFamily(TOOL_CALL_SPANS, span.name) && span.status_code === 1 && span.end_time);
  const error = spans.find((span) => span.status_code === 2);
  const response = spans.find((span) => span.response_text);
  return {
    failure: failed ? { id: failed.id, status: failed.status, code: failed.error_code ?? (failed.completed_at && !failed.model ? "no_recorded_model_call" : failed.status), href: turnLink(failed.id) } : null,
    completedTurn: completed ? { id: completed.id, model: completed.model, completedAt: completed.completed_at?.toISOString() ?? null, href: turnLink(completed.id) } : null,
    successfulAction: action ? { name: action.name, completedAt: action.end_time!.toISOString(), href: spanLink(action.span_id) } : null,
    traceError: error ? { name: error.name, message: error.status_message, href: spanLink(error.span_id) } : null,
    response: response ? { text: response.response_text!, truncated: response.response_truncated, href: spanLink(response.span_id) } : null,
  };
}

async function readSnapshot<T>(text: string, values: string[]): Promise<T[]> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '5000ms'");
    const result = await client.query(text, values);
    await client.query("COMMIT");
    return result.rows as T[];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getTaskRecovery(id: string) {
  const sessions = await readSnapshot<{ id: string; status: string }>(
    "SELECT id,status FROM workflow.workflow_runs WHERE id=$1 AND attributes->>'$eve.type'='session'", [id],
  );
  if (!sessions.length) return null;
  // Storage only: no agent request, schema mutation, model call or tool execution.
  const [turnRead, traceRead] = await Promise.allSettled([
    readSnapshot<RecoveryTurn>(`SELECT id,status,left(error_code,500) AS error_code,attributes->>'$eve.model' AS model,created_at,completed_at
      FROM workflow.workflow_runs WHERE (attributes->>'$eve.root'=$1 OR attributes->>'$eve.parent'=$1)
      AND attributes->>'$eve.type'='turn' ORDER BY created_at DESC,id DESC LIMIT 101`, [id]),
    readSnapshot<RecoverySpan>(`SELECT span_id,left(name,300) AS name,status_code,left(status_message,1000) AS status_message,end_time,
      left(attributes->>'ai.response.text',8000) AS response_text,
      length(attributes->>'ai.response.text')>8000 AS response_truncated
      FROM evestack.spans WHERE resolved_session_id=$1
      AND (status_code=2 OR ${sqlSpanFamily(TOOL_CALL_SPANS)} OR attributes->>'ai.response.text' IS NOT NULL)
      ORDER BY start_time DESC,span_id DESC LIMIT 51`, [id]),
  ]);
  const turns = turnRead.status === "fulfilled" ? turnRead.value : [];
  const spans = traceRead.status === "fulfilled" ? traceRead.value : [];
  return {
    session: sessions[0],
    ...recoveryEvidence(turns.slice(0,100), spans.slice(0,50), id),
    coverage: {
      turns: turnRead.status === "fulfilled" ? "available" : "unavailable",
      traces: traceRead.status === "fulfilled" ? "available" : "unavailable",
      turnsRead: Math.min(turns.length,100), tracesRead: Math.min(spans.length,50),
      turnsTruncated: turns.length > 100, tracesTruncated: spans.length > 50,
    },
    checkedAt: new Date().toISOString(),
  };
}
export type TaskRecovery = NonNullable<Awaited<ReturnType<typeof getTaskRecovery>>>;
