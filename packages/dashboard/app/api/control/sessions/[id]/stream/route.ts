import {
  EVE_STREAM_CONTENT_TYPE,
  openEventStream,
  parseTailIndex,
} from "@/lib/agent-client";
import { handleRouteError, jsonError } from "../../../_http";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const HEARTBEAT_MS = 15_000;

/**
 * GET /api/control/sessions/[id]/stream — the agent's event stream, proxied.
 *
 * eve serves NDJSON, not SSE (`application/x-ndjson`, one JSON event per line —
 * see EVE_MESSAGE_STREAM_CONTENT_TYPE in eve/dist/src/protocol/message.js). A
 * browser cannot consume that with `EventSource`, so the default here is a
 * transcode to `text/event-stream`; `?format=ndjson` passes the agent's bytes
 * through untouched for anything reading with fetch.
 *
 * Resumption is exact rather than approximate. eve indexes the durable stream,
 * so each SSE frame carries its absolute index as `id:`, and a reconnecting
 * `EventSource` sends it back as `Last-Event-ID` — which becomes the next
 * `startIndex`. No replayed events, no dropped ones.
 */
// A freshly created session emits its first event within a few hundred
// milliseconds. Six tries at 250ms gives that ~1.5s of grace while keeping a
// genuinely bad id fast to diagnose.
const FIRST_EVENT_ATTEMPTS = 6;
const FIRST_EVENT_DELAY_MS = 250;

/**
 * The largest startIndex this route will accept, in either direction.
 *
 * Resumption is only exact while each frame's `id:` differs from the last, and
 * those ids come from `index += 1` in toServerSentEvents below. Past 2^53 that
 * increment stops being an increment — `9007199254740993 === 9007199254740992`
 * in a double — so `?startIndex=100000000000000000000`, which the integer regex
 * accepts happily because it is 21 digits and nothing else, produced a stream
 * where every frame carried the SAME id. A reconnecting EventSource then sends
 * that id back as Last-Event-ID and resumes from a position that never advanced,
 * which is the one property this route's header promises.
 *
 * A trillion is far above any real stream — it is an event count for a single
 * session — and far enough below 2^53 that every id derived from it afterwards
 * is still exactly representable, so the bound holds for the life of the stream
 * rather than only at the moment of the request.
 */
const MAX_START_INDEX = 1_000_000_000_000;

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const url = new URL(request.url);

    const format = url.searchParams.get("format") ?? "sse";
    if (format !== "sse" && format !== "ndjson") {
      return jsonError("Expected 'format' to be 'sse' or 'ndjson'.", 400, "bad_request");
    }

    const startIndex = resolveStartIndex(url.searchParams.get("startIndex"), request.headers.get("last-event-id"));
    if (startIndex instanceof Response) return startIndex;

    // eve serves 200 with an empty body for a session it has never seen, so a
    // typo'd id would otherwise hand the operator a stream that connects and
    // then stays silent forever. A tail index of -1 means "no events at all".
    //
    // But -1 is ambiguous: it is also what a session that was created
    // milliseconds ago looks like, before its first event lands. A browser that
    // starts a session and immediately opens the stream hits that window every
    // time. So poll briefly before deciding — a real session announces itself
    // almost at once, while a typo'd id stays empty and still fails fast.
    let upstream = await openEventStream(id, {
      startIndex,
      includeTailIndex: true,
      signal: request.signal,
    });
    if (!upstream.body) {
      return jsonError("The agent returned an empty event stream.", 502, "invalid_response");
    }

    let tailIndex = parseTailIndex(upstream);
    for (let attempt = 0; tailIndex < 0 && attempt < FIRST_EVENT_ATTEMPTS; attempt += 1) {
      await upstream.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, FIRST_EVENT_DELAY_MS));
      if (request.signal.aborted) return new Response(null, { status: 499 });

      upstream = await openEventStream(id, {
        startIndex,
        includeTailIndex: true,
        signal: request.signal,
      });
      if (!upstream.body) {
        return jsonError("The agent returned an empty event stream.", 502, "invalid_response");
      }
      tailIndex = parseTailIndex(upstream);
    }

    if (tailIndex < 0) {
      await upstream.body?.cancel();
      return jsonError(
        `No session '${id}' has emitted any events after ` +
          `${(FIRST_EVENT_ATTEMPTS * FIRST_EVENT_DELAY_MS) / 1000}s. Check the id.`,
        404,
        "session_not_found",
      );
    }

    // A negative startIndex is relative to the tail; SSE ids must be absolute.
    const firstIndex = startIndex < 0 ? Math.max(0, tailIndex + 1 + startIndex) : startIndex;

    const headers = new Headers({
      "cache-control": "no-store, no-transform",
      // Tells nginx and friends not to buffer, which would defeat streaming.
      "x-accel-buffering": "no",
      "x-eve-session-id": id,
      "x-eve-stream-tail-index": String(tailIndex),
      "x-evestack-start-index": String(firstIndex),
    });

    if (format === "ndjson") {
      headers.set("content-type", upstream.headers.get("content-type") ?? EVE_STREAM_CONTENT_TYPE);
      return new Response(upstream.body, { status: 200, headers });
    }

    headers.set("content-type", "text/event-stream; charset=utf-8");
    headers.set("connection", "keep-alive");
    return new Response(toServerSentEvents(upstream.body, firstIndex, request.signal), {
      status: 200,
      headers,
    });
  } catch (error) {
    return handleRouteError(error, request);
  }
}

function resolveStartIndex(param: string | null, lastEventId: string | null): number | Response {
  if (param !== null) {
    if (!/^-?\d+$/.test(param)) {
      return jsonError("Expected 'startIndex' to be an integer.", 400, "bad_request");
    }
    const parsed = Number(param);
    if (Math.abs(parsed) > MAX_START_INDEX) {
      return jsonError(
        `Expected 'startIndex' to be between -${MAX_START_INDEX} and ${MAX_START_INDEX}.`,
        400,
        "bad_request",
      );
    }
    return parsed;
  }
  // A header is not something the operator typed, so an out-of-range one is
  // treated the same way an unparseable one already was — start from the
  // beginning — rather than failing a reconnect an EventSource will only retry.
  if (lastEventId !== null && /^\d+$/.test(lastEventId)) {
    const parsed = Number(lastEventId);
    if (parsed < MAX_START_INDEX) return parsed + 1;
  }
  return 0;
}

/**
 * NDJSON in, SSE out, one frame per line. Line-splitting happens here rather
 * than on whole chunks because a JSON event can straddle a chunk boundary and
 * half an event is not a valid frame.
 */
function toServerSentEvents(
  body: ReadableStream<Uint8Array>,
  firstIndex: number,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = "";
  let index = firstIndex;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const stopHeartbeat = () => {
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      // Long HITL pauses emit nothing for hours; an idle-timeout proxy reads
      // that as a dead connection unless something keeps crossing the wire.
      heartbeat = setInterval(() => {
        if (closed) return;
        controller.enqueue(encoder.encode(": keep-alive\n\n"));
      }, HEARTBEAT_MS);

      signal.addEventListener("abort", () => void reader.cancel().catch(() => {}), { once: true });
    },

    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          buffered = "";
          closed = true;
          stopHeartbeat();
          controller.close();
          return;
        }

        buffered += decoder.decode(value, { stream: true });
        let newline = buffered.indexOf("\n");
        while (newline !== -1) {
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          // eve primes the stream with a bare newline to flush headers.
          if (line.length > 0) {
            controller.enqueue(encoder.encode(`id: ${index}\ndata: ${line}\n\n`));
            index += 1;
          }
          newline = buffered.indexOf("\n");
        }
      } catch (error) {
        closed = true;
        stopHeartbeat();
        if (signal.aborted) {
          controller.close();
          return;
        }
        controller.error(error);
      }
    },

    cancel(reason) {
      closed = true;
      stopHeartbeat();
      return reader.cancel(reason).catch(() => {});
    },
  });
}
