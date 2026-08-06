import { cancelTurn, readRecentEvents } from "@/lib/agent-client";
import {
  handleRouteError,
  isResponse,
  jsonError,
  jsonOk,
  readJsonObject,
  readOptionalString,
} from "../../../_http";

export const dynamic = "force-dynamic";

/**
 * POST /api/control/sessions/[id]/cancel — stop the in-flight turn.
 *
 * Cancellation is cooperative, and weaker than the word suggests. Measured end
 * to end against eve 0.30.8, cancelling a streaming turn 1.3s after its first
 * token: the 202 came back in 36ms, and the model then produced 1270 more
 * deltas over the next 18.8 seconds and finished normally. The stream read
 *
 *     turn.completed -> session.waiting -> turn.cancelled -> session.waiting
 *
 * in that order. So the request is a note left on the session's command inbox,
 * which the turn only reads at its next park: it can stop the step AFTER the
 * one in flight, never the one in flight. A single-step turn is therefore not
 * interrupted at all, `turn.cancelled` arrives AFTER the turn has already
 * reported itself completed, and a second `session.waiting` follows it. A UI
 * that treats the first `session.waiting` as the end of the story will miss
 * the cancellation entirely; one that waits for silence will wait a long time.
 *
 * Nothing of this reaches Postgres. The cancelled turn's row in
 * `workflow.workflow_runs` reads `status = 'completed'` with no error and no
 * marker, indistinguishable from a turn nobody touched.
 *
 * `accepted` means the session took the command, NOT that a turn was stopped.
 * Cancelling a parked session returns `accepted` and emits no event at all;
 * so does a cancel naming a turn id that is not running, which eve then
 * discards (verified: a bogus `turnId` produced no `turn.cancelled` and the
 * live turn ran to completion — the scoping above is real).
 *
 * `no_active_turn` does NOT mean "the turn had already settled". eve returns it
 * when it cannot reach the session at all, which for a typo'd id used to come
 * back as a 202 success; see the guard below.
 *
 * The session survives either way, so this is a stop button, not a kill.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const body = await readJsonObject(request);
    if (isResponse(body)) return body;

    // Scoping to the observed turn keeps a late click from killing the turn
    // that started after it.
    const turnId = readOptionalString(body.turnId, "turnId");
    if (isResponse(turnId)) return turnId;

    const result = await cancelTurn(id, {
      ...(turnId === undefined ? {} : { turnId }),
      signal: request.signal,
    });

    if (result.status === "no_active_turn") {
      // This is where a typo'd id lands, so it cannot be reported as a success.
      // eve answers `no_active_turn` when it cannot hand the command to a
      // session at all — no such command hook, run not found, run expired —
      // and a session that is merely parked with nothing running answers
      // `accepted` instead. Measured: an id eve has never seen returns 202
      // `{ok: true, status: "no_active_turn"}`, which told the operator their
      // stop button had worked on a session that does not exist, while
      // ../message, ../approve and ../stream all 404 the very same id.
      //
      // A tail index of -1 is eve's only unknown-session signal, the same test
      // those three routes use. A real session that has expired keeps its
      // events, so it still gets the outcome verbatim rather than a 404.
      const { tailIndex } = await readRecentEvents(id, { lookback: 1, signal: request.signal });
      if (tailIndex < 0) {
        return jsonError(
          `No session '${id}' has emitted any events, so there was nothing to cancel. ` +
            `Check the id.`,
          404,
          "session_not_found",
        );
      }
    }

    return jsonOk({ sessionId: result.sessionId, status: result.status }, 202);
  } catch (error) {
    return handleRouteError(error, request);
  }
}
