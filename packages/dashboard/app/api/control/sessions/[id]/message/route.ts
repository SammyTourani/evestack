import { continueSession, getSessionSnapshot } from "@/lib/agent-client";
import {
  handleRouteError,
  isResponse,
  jsonError,
  jsonOk,
  readJsonObject,
  readMessage,
  readOptionalString,
} from "../../../_http";

export const dynamic = "force-dynamic";

/** Follow up only after a recorded waiting boundary. Legacy tokens are accepted
 * from clients but never sent to Eve's session-ID endpoint. */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const body = await readJsonObject(request);
    if (isResponse(body)) return body;

    const message = readMessage(body.message, true);
    if (isResponse(message)) return message;

    const provided = readOptionalString(body.continuationToken, "continuationToken");
    if (isResponse(provided)) return provided;

    const snapshot = await getSessionSnapshot(id, { signal: request.signal });
    if (snapshot.tailIndex < 0) {
      return jsonError(`No session '${id}' has emitted any events.`, 404, "session_not_found");
    }
    if (snapshot.terminal) {
      return jsonError("This session has already ended; start a new one instead of continuing it.", 409, "session_terminal");
    }
    if (!snapshot.waiting) {
      return jsonError("The session is still running. Wait for its current turn to finish.", 409, "session_busy");
    }

    const result = await continueSession(id, {
      message: message!,
      ...(body.clientContext === undefined ? {} : { clientContext: body.clientContext }),
      signal: request.signal,
    });

    // Guard against an upstream response naming a different live session.
    if (result.sessionId && result.sessionId !== id) {
      return jsonError(
        `The agent did not continue session '${id}' — it started '${result.sessionId}' instead, ` +
          `which means '${id}' is not a session it knows. That run is now live; cancel it if it ` +
          `was unintended.`,
        409,
        "session_mismatch",
        { startedSessionId: result.sessionId },
      );
    }

    return jsonOk({ sessionId: result.sessionId, resolvedContinuationToken: false, addressedBy: "sessionId" });
  } catch (error) {
    return handleRouteError(error, request);
  }
}
