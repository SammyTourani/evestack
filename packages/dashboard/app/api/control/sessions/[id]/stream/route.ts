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

    const upstream = await openEventStream(id, {
      startIndex,
      includeTailIndex: true,
      signal: request.signal,
    });

    if (!upstream.body) {
      return jsonError("The agent returned an empty event stream.", 502, "invalid_response");
    }

    const tailIndex = parseTailIndex(upstream);
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
    return Number(param);
  }
  if (lastEventId !== null && /^\d+$/.test(lastEventId)) return Number(lastEventId) + 1;
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
