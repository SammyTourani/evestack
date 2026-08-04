import { AgentError, type UserMessage } from "@/lib/agent-client";

/**
 * Request/response plumbing shared by the control routes. Not a route file —
 * Next only routes `route.ts`, so this sits alongside them without being
 * reachable over HTTP.
 */

export function jsonError(message: string, status: number, code: string): Response {
  return Response.json({ ok: false, error: message, code }, { status, headers: { "cache-control": "no-store" } });
}

export function jsonOk(body: Record<string, unknown>, status = 200): Response {
  return Response.json({ ok: true, ...body }, { status, headers: { "cache-control": "no-store" } });
}

/** Returns the parsed object, or a 400 Response to return as-is. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | Response> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return jsonError("Unreadable request body.", 400, "bad_request");
  }
  if (text.trim().length === 0) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return jsonError("Invalid JSON body.", 400, "bad_request");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return jsonError("Expected a JSON object.", 400, "bad_request");
  }
  return parsed as Record<string, unknown>;
}

/**
 * eve accepts a string or an array of text/file parts; it validates the parts
 * themselves, so this only enforces what would otherwise cost a round trip.
 */
export function readMessage(value: unknown, required: boolean): UserMessage | undefined | Response {
  if (value === undefined || value === null) {
    return required ? jsonError("Missing 'message' field.", 400, "bad_request") : undefined;
  }
  if (typeof value === "string") {
    if (value.trim().length === 0) {
      return required ? jsonError("Field 'message' must not be empty.", 400, "bad_request") : undefined;
    }
    return value;
  }
  if (Array.isArray(value) && value.length > 0) return value as UserMessage;
  return jsonError("Expected 'message' to be a non-empty string or array of parts.", 400, "bad_request");
}

export function readOptionalString(
  value: unknown,
  field: string,
): string | undefined | Response {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    return jsonError(`Expected '${field}' to be a non-empty string.`, 400, "bad_request");
  }
  return value;
}

export function isResponse(value: unknown): value is Response {
  return value instanceof Response;
}

/**
 * A client that navigates away aborts the request; that is not a failure worth
 * logging or reporting, and there is nobody left to send a body to.
 */
export function handleRouteError(error: unknown, request?: Request): Response {
  if (request?.signal.aborted) return new Response(null, { status: 499 });
  if (error instanceof AgentError) return error.toResponse();
  if (error instanceof DOMException && error.name === "AbortError") {
    return new Response(null, { status: 499 });
  }
  const message = error instanceof Error ? error.message : String(error);
  return jsonError(message, 500, "internal_error");
}
