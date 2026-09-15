import { AgentError, type UserMessage } from "@/lib/agent-client";

/**
 * Request/response plumbing shared by the control routes. Not a route file —
 * Next only routes `route.ts`, so this sits alongside them without being
 * reachable over HTTP.
 *
 * `readBoundedBody` has one caller outside this directory — app/api/auth/session,
 * on the unauthenticated sign-in tier. It is imported rather than copied on
 * purpose: two hand-written stream-reading loops with two independent limits is
 * how one of them ends up without a limit. The import costs that route
 * lib/agent-client, which has no imports and no top-level side effects of its
 * own, so nothing is started by reaching for it.
 */

export function jsonError(
  message: string,
  status: number,
  code: string,
  detail?: Record<string, unknown>,
): Response {
  return Response.json(
    { ok: false, error: message, code, ...detail },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export function jsonOk(body: Record<string, unknown>, status = 200): Response {
  return Response.json({ ok: true, ...body }, { status, headers: { "cache-control": "no-store" } });
}

/**
 * The ceiling on a JSON body, and the failure it removes.
 *
 * `request.text()` reads until the sender stops, and every route in this
 * directory called it with no limit at all: one POST with a chunked body and no
 * content-length could stream as much as it liked into this process, and a
 * container with a memory limit answers that by dying rather than by slowing
 * down. The ingest route learned this already — see MAX_BODY_BYTES in
 * app/api/ingest/v1/traces/route.ts — and this is the same lesson applied to
 * the routes that read bodies without an OTLP contract to hang it on.
 *
 * 1 MB, because of what these bodies actually are: `{"paused":true}`, a metric
 * query spec, a fork's turn number, and a chat message. Only the last has no
 * natural size, and a megabyte of prompt is already several times any model's
 * context window. Read off the seven call sites in this package — schedules,
 * metrics/query, sessions, approve, fork, message and cancel — nothing
 * legitimate comes within two orders of magnitude of it.
 *
 * EVESTACK_MAX_JSON_BODY_BYTES raises it for an install that does send more —
 * eve accepts file parts in a message, and a base64 image part would be the one
 * body that could grow. Nonsense values fall back to the default rather than
 * becoming a zero-length limit that refuses every write, the same rule
 * EVESTACK_SESSION_TTL_HOURS follows in lib/auth.ts. The ingest route keeps its
 * own 32 MB ceiling and is not governed by this variable.
 */
const DEFAULT_MAX_JSON_BODY_BYTES = 1024 * 1024;
const MAX_CONFIGURABLE_BODY_BYTES = 64 * 1024 * 1024;

function maxJsonBodyBytes(): number {
  const raw = Number(process.env.EVESTACK_MAX_JSON_BODY_BYTES);
  if (Number.isFinite(raw) && raw > 0 && raw <= MAX_CONFIGURABLE_BODY_BYTES) return Math.floor(raw);
  return DEFAULT_MAX_JSON_BODY_BYTES;
}

/**
 * Reads a request body, refusing anything past `limit` instead of buffering it.
 *
 * Two checks, because either one alone is a limit in name only:
 *
 *   content-length first, so a declared 800 MB costs one header comparison and
 *   no memory. This is the only check the ingest route could make cheaply, and
 *   the reason it makes it before `arrayBuffer()`.
 *
 *   then the stream, chunk by chunk, because a chunked request declares no
 *   length at all — which is exactly what an attacker sends. Reading through
 *   the stream rather than `text()` is what makes the cap real here: the
 *   allocation stops at the first chunk that crosses it, and `reader.cancel()`
 *   tears the connection down rather than politely draining the rest of what
 *   was being pushed at us.
 *
 * Bytes, not text, so a caller can hand them to `formData()` unharmed; UTF-8
 * decoding is the JSON reader's business and nobody else's.
 *
 * `Uint8Array<ArrayBuffer>` rather than a bare `Uint8Array`, which since the
 * typed arrays became generic is a wider type than it looks: it also covers a
 * SharedArrayBuffer-backed view, and `BodyInit` does not accept one. Spelling
 * the buffer out is what lets app/api/auth/session hand the result straight to
 * `new Response(bytes, …).formData()` without a cast. Both returns below are
 * freshly allocated here, so the narrower type is the honest one.
 */
export async function readBoundedBody(
  request: Request,
  limit: number,
  hint?: string,
): Promise<Uint8Array<ArrayBuffer> | Response> {
  const tooLarge = () =>
    jsonError(
      `Request body is larger than the ${limit} byte limit.${hint ? ` ${hint}` : ""}`,
      413,
      "payload_too_large",
    );

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return tooLarge();

  if (request.body === null) return new Uint8Array(0);

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    // Inside the try: `getReader()` throws synchronously on a body that has
    // already been read, which is the same "unreadable" case `text()` used to
    // land in and must not become an unhandled 500.
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return tooLarge();
      }
      chunks.push(value);
    }
  } catch {
    return jsonError("Unreadable request body.", 400, "bad_request");
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

/** Returns the parsed object, or a 400/413 Response to return as-is. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | Response> {
  const body = await readBoundedBody(
    request,
    maxJsonBodyBytes(),
    "Raise EVESTACK_MAX_JSON_BODY_BYTES on the dashboard if this payload is legitimate.",
  );
  if (isResponse(body)) return body;

  // `new TextDecoder()` and not `Buffer.from(body).toString("utf8")`, which is
  // not the same decode: TextDecoder strips a leading UTF-8 BOM and Buffer
  // keeps it. `request.text()`, which this replaces, strips it — so the Buffer
  // spelling would have started answering 400 "Invalid JSON body." to bodies
  // written by an editor that stamps one, since JSON.parse rejects U+FEFF.
  // Measured both ways on the same five bytes.
  const text = new TextDecoder().decode(body);
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
