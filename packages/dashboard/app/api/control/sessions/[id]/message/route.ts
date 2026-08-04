import { continueSession, getSessionSnapshot, AgentError } from "@/lib/agent-client";
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

/**
 * POST /api/control/sessions/[id]/message — follow-up turn.
 *
 * `continuationToken` is optional here even though eve requires it. Tokens
 * rotate on every turn boundary and are published on `session.waiting`, so a
 * dashboard that had to carry one would break the moment the operator reloaded
 * the page. When the caller omits it we read the current one back off the
 * durable stream.
 */
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

    let continuationToken = provided;
    if (continuationToken === undefined) {
      const snapshot = await getSessionSnapshot(id, { signal: request.signal });
      if (snapshot.tailIndex < 0) {
        // eve serves an empty stream rather than a 404 for an id it has never
        // seen, so "no events at all" is the only unknown-session signal there
        // is. It also covers the sliver of time before the first event lands.
        return jsonError(
          `No session '${id}' has emitted any events. Check the id, or wait for the ` +
            `session to start if you just created it.`,
          404,
          "session_not_found",
        );
      }
      if (snapshot.terminal) {
        return jsonError(
          "This session has already ended; start a new one instead of continuing it.",
          409,
          "session_terminal",
        );
      }
      if (!snapshot.continuationToken) {
        return jsonError(
          "No continuation token is available yet — the session has not reached a waiting " +
            "boundary. Wait for `session.waiting` on the stream, or pass 'continuationToken'.",
          409,
          "session_busy",
        );
      }
      continuationToken = snapshot.continuationToken;
    }

    const result = await continueSession(id, {
      continuationToken,
      message: message!,
      ...(body.clientContext === undefined ? {} : { clientContext: body.clientContext }),
      signal: request.signal,
    });

    return jsonOk({ sessionId: result.sessionId, resolvedContinuationToken: provided === undefined });
  } catch (error) {
    // A stale token is the one failure a caller can actually act on, so say so.
    if (error instanceof AgentError && error.upstreamStatus === 404) {
      return jsonError(
        "The agent rejected the continuation token. It may belong to an earlier turn; " +
          "omit it and let the dashboard resolve the current one.",
        409,
        "stale_continuation_token",
      );
    }
    return handleRouteError(error, request);
  }
}
