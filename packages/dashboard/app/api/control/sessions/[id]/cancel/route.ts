import { cancelTurn } from "@/lib/agent-client";
import { handleRouteError, isResponse, jsonOk, readJsonObject, readOptionalString } from "../../../_http";

export const dynamic = "force-dynamic";

/**
 * POST /api/control/sessions/[id]/cancel — stop the in-flight turn.
 *
 * Cancellation is cooperative. The session survives and can still take
 * follow-ups, so this is a stop button, not a kill.
 *
 * ── two things this comment used to state backwards, both measured ───────────
 *
 * It said the turn settles with `turn.cancelled` and THEN `session.waiting`.
 * Measured on a cancel sent 1.3s into a streaming turn, the order is neither:
 *
 *   t=41.6s  POST /cancel -> 202 in 36ms
 *   t=60.4s  last delta          18.8s AFTER the 202
 *   t=60.44s turn.completed      the turn finished NORMALLY
 *   t=60.49s turn.cancelled      after BOTH
 *
 * `turn.cancelled` arrives after `turn.completed` and after `session.waiting`,
 * so a UI that treats the first `session.waiting` as the end of the turn misses
 * the cancellation entirely. The durable record does not distinguish it either:
 * the cancelled turn's row is byte-for-byte an ordinary `status='completed'`.
 *
 * And it said `no_active_turn` means "the turn had already settled". It also
 * means the session was never reachable at all: `wrun_DOES_NOT_EXIST` answers
 * `202 {ok: true, status: "no_active_turn"}` while `/message`, `/approve` and
 * `/stream` all 404 the same id. So this status cannot tell "already finished"
 * apart from "no such session", and a caller must not report the first.
 *
 * It is still returned verbatim rather than as a 4xx — "nothing to cancel" is
 * the state the button was trying to reach, whichever of the two produced it.
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

    return jsonOk({ sessionId: result.sessionId, status: result.status }, 202);
  } catch (error) {
    return handleRouteError(error, request);
  }
}
