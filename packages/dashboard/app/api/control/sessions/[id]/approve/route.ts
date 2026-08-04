import {
  answerInput,
  getSessionSnapshot,
  type InputRequest,
  type InputResponse,
} from "@/lib/agent-client";
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
 * Human-in-the-loop decisions for a parked turn.
 *
 * eve has no approve/deny endpoint. What it has is one pause-and-resume
 * protocol shared by tool approvals, `ask_question`, and session limits: the
 * turn parks at `session.waiting`, publishes its pending requests in an
 * `input.requested` event, and resumes when the follow-up route receives
 * `inputResponses: [{requestId, optionId?, text?}]`. That is the real
 * mechanism, and this route is a thin, honest projection of it — not a
 * different capability wearing a nicer name.
 *
 * What it adds is the state the caller would otherwise have to reconstruct by
 * parsing the event stream itself: which requests are outstanding, and the
 * current continuation token (it rotates every turn).
 *
 * Tool approvals always offer exactly `approve` / `deny`, so `{decision}` is
 * enough. Questions carry model-authored options, so those need an explicit
 * `optionId` or `text`.
 */

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const snapshot = await getSessionSnapshot(id, { signal: request.signal });
    return jsonOk({
      sessionId: id,
      waiting: snapshot.waiting,
      terminal: snapshot.terminal,
      turnId: snapshot.turnId ?? null,
      pendingRequests: snapshot.pendingRequests,
      tailIndex: snapshot.tailIndex,
    });
  } catch (error) {
    return handleRouteError(error, request);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const body = await readJsonObject(request);
    if (isResponse(body)) return body;

    const decision = body.decision;
    if (decision !== undefined && decision !== "approve" && decision !== "deny") {
      return jsonError("Expected 'decision' to be 'approve' or 'deny'.", 400, "bad_request");
    }

    const requestId = readOptionalString(body.requestId, "requestId");
    if (isResponse(requestId)) return requestId;

    const optionId = readOptionalString(body.optionId, "optionId");
    if (isResponse(optionId)) return optionId;

    const text = readOptionalString(body.text, "text");
    if (isResponse(text)) return text;

    const message = readMessage(body.message, false);
    if (isResponse(message)) return message;

    const providedToken = readOptionalString(body.continuationToken, "continuationToken");
    if (isResponse(providedToken)) return providedToken;

    const snapshot = await getSessionSnapshot(id, { signal: request.signal });
    if (snapshot.tailIndex < 0) {
      // eve serves an empty stream rather than a 404 for an unknown id.
      return jsonError(`No session '${id}' has emitted any events.`, 404, "session_not_found");
    }
    if (snapshot.terminal) {
      return jsonError("This session has already ended; there is nothing to approve.", 409, "session_terminal");
    }

    const continuationToken = providedToken ?? snapshot.continuationToken;
    if (!continuationToken) {
      return jsonError(
        "No continuation token is available yet — the session has not reached a waiting boundary.",
        409,
        "session_busy",
      );
    }

    const targets = selectTargets(snapshot.pendingRequests, requestId);
    if (isResponse(targets)) return targets;

    const inputResponses: InputResponse[] = [];
    for (const target of targets) {
      const answer = answerFor(target, { decision, optionId, text });
      if (isResponse(answer)) return answer;
      inputResponses.push(answer);
    }

    const result = await answerInput(id, {
      continuationToken,
      inputResponses,
      ...(message === undefined ? {} : { message }),
      signal: request.signal,
    });

    return jsonOk({
      sessionId: result.sessionId,
      answered: inputResponses,
      resolvedContinuationToken: providedToken === undefined,
    });
  } catch (error) {
    return handleRouteError(error, request);
  }
}

function selectTargets(pending: InputRequest[], requestId: string | undefined): InputRequest[] | Response {
  if (pending.length === 0) {
    return jsonError(
      "This session is not waiting on a human decision. Watch the stream for `input.requested`.",
      409,
      "no_pending_input",
    );
  }
  if (requestId === undefined) {
    // Answering every outstanding request at once is only unambiguous when
    // there is exactly one; otherwise a single `decision` would silently apply
    // to prompts the caller never saw.
    if (pending.length > 1) {
      return jsonError(
        `This turn is waiting on ${pending.length} requests; name one with 'requestId'. ` +
          `Pending: ${pending.map((entry) => entry.requestId).join(", ")}`,
        409,
        "ambiguous_request",
      );
    }
    return pending;
  }
  const match = pending.find((entry) => entry.requestId === requestId);
  if (!match) {
    return jsonError(
      `No pending request '${requestId}'. Pending: ${pending.map((entry) => entry.requestId).join(", ") || "none"}`,
      409,
      "unknown_request",
    );
  }
  return [match];
}

function answerFor(
  target: InputRequest,
  input: { decision?: "approve" | "deny"; optionId?: string; text?: string },
): InputResponse | Response {
  const chosen = input.optionId ?? (target.kind === "tool-approval" ? input.decision : undefined);

  if (chosen === undefined && input.text === undefined) {
    return jsonError(
      target.kind === "tool-approval"
        ? `Request '${target.requestId}' needs a 'decision' of 'approve' or 'deny'.`
        : `Request '${target.requestId}' is a ${target.kind}; answer it with 'optionId' or 'text'.`,
      400,
      "bad_request",
    );
  }

  // Catching a bad option here beats a round trip that resumes the turn with an
  // answer the model cannot interpret.
  if (chosen !== undefined && target.options && target.options.length > 0) {
    const known = target.options.some((option) => option.id === chosen);
    if (!known) {
      return jsonError(
        `Request '${target.requestId}' does not offer option '${chosen}'. ` +
          `Options: ${target.options.map((option) => option.id).join(", ")}`,
        400,
        "unknown_option",
      );
    }
  }

  if (input.text !== undefined && target.allowFreeform === false) {
    return jsonError(
      `Request '${target.requestId}' does not accept freeform text; pick an option instead.`,
      400,
      "freeform_not_allowed",
    );
  }

  return {
    requestId: target.requestId,
    ...(chosen === undefined ? {} : { optionId: chosen }),
    ...(input.text === undefined ? {} : { text: input.text }),
  };
}
