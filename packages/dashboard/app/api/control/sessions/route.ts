import { createSession } from "@/lib/agent-client";
import { handleRouteError, isResponse, jsonError, jsonOk, readJsonObject, readMessage } from "../_http";

export const dynamic = "force-dynamic";

/**
 * POST /api/control/sessions — start a session.
 *
 * This is the line between us and a read-only run viewer: the dashboard does
 * not just watch the agent, it starts it. 202 mirrors the agent's own status,
 * because the turn is accepted here and finishes on the stream, not in this
 * response.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readJsonObject(request);
    if (isResponse(body)) return body;

    const message = readMessage(body.message, true);
    if (isResponse(message)) return message;

    const mode = body.mode;
    if (mode !== undefined && mode !== "conversation" && mode !== "task") {
      return jsonError("Expected 'mode' to be 'conversation' or 'task'.", 400, "bad_request");
    }

    const result = await createSession({
      message: message!,
      ...(mode === undefined ? {} : { mode }),
      ...(body.clientContext === undefined ? {} : { clientContext: body.clientContext }),
      signal: request.signal,
    });

    return jsonOk(
      {
        sessionId: result.sessionId,
        continuationToken: result.continuationToken,
        streamUrl: `/api/control/sessions/${encodeURIComponent(result.sessionId)}/stream`,
      },
      202,
    );
  } catch (error) {
    return handleRouteError(error, request);
  }
}
