import { cancelTurn } from "@/lib/agent-client";
import { handleRouteError, isResponse, jsonOk, readJsonObject, readOptionalString } from "../../../_http";

export const dynamic = "force-dynamic";

/**
 * POST /api/control/sessions/[id]/cancel — stop the in-flight turn.
 *
 * Cancellation is cooperative: the agent signals the turn, which settles with
 * `turn.cancelled` and then `session.waiting` on the stream. The session itself
 * survives and can still take follow-ups, so this is a stop button, not a kill.
 *
 * `no_active_turn` is a success, not an error — the turn had already settled.
 * Callers get it verbatim rather than as a 4xx, because "nothing to cancel" is
 * exactly the state the button was trying to reach.
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
