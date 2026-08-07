import { gunzipSync, inflateSync } from "node:zlib";
import { INGEST_UNAUTHENTICATED_MESSAGE, ingestAuthorized } from "@/lib/auth";
import {
  getTraceOverview,
  insertSpans,
  OtlpFormatError,
  parseOtlpTraces,
} from "@/lib/traces";

export const dynamic = "force-dynamic";

/**
 * OTLP/HTTP trace receiver.
 *
 * This is the only write path into the `evestack` schema. It speaks the JSON
 * encoding of OTLP and nothing else, which is a deliberate limit rather than an
 * oversight: decoding protobuf means a protobuf runtime and generated
 * descriptors, and the entire point of this dashboard is that it runs with no
 * network calls and almost no dependencies. A protobuf exporter is rejected
 * loudly at the door — see POST below for why that matters more than usual.
 *
 * gRPC OTLP (port 4317) is not served here either. Point exporters at this URL
 * over HTTP.
 *
 * AUTH. Its own tier: EVESTACK_INGEST_TOKEN in the `x-evestack-ingest-token`
 * header (or as a Bearer token), falling back to ordinary session auth when
 * that variable is unset. An exporter is a program, so it cannot sign in — but
 * it can send a header, which is what makes a shared secret the right shape
 * here. proxy.ts turns anonymous callers away before they reach this file; the
 * check is repeated here so that the policy for the one route with a
 * non-standard credential is written where the route is, not only in a file
 * two directories up.
 */

// google.rpc.Code, the status vocabulary OTLP borrows for error bodies.
const INVALID_ARGUMENT = 3;
const UNIMPLEMENTED = 12;
const UNAVAILABLE = 14;
const UNAUTHENTICATED = 16;

// eve caps a single span attribute at 32 KB, and a batch is a few dozen spans.
// A payload past this is a misconfiguration, and buffering it would be the
// dashboard's problem rather than the sender's.
const MAX_BODY_BYTES = 32 * 1024 * 1024;

// The same ceiling, applied to what comes *out* of the decompressor. Checking
// only the compressed size is not a limit at all: a 299 KB gzip body that
// inflates 1000x took this process from 16 MB to 892 MB of RSS in a single
// request. zlib enforces this while inflating, so the memory is never allocated.
const MAX_DECOMPRESSED_BYTES = MAX_BODY_BYTES;

const PROTOBUF_TYPES = [
  "application/x-protobuf",
  "application/protobuf",
  "application/x-google-protobuf",
];

function status(code: number, message: string, httpStatus: number, headers?: HeadersInit) {
  return Response.json({ code, message }, { status: httpStatus, headers });
}

export async function POST(request: Request): Promise<Response> {
  if (!ingestAuthorized(request)) {
    return status(UNAUTHENTICATED, INGEST_UNAUTHENTICATED_MESSAGE, 401);
  }

  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();

  // Protobuf is the default encoding for most OTLP exporters, including the
  // OTLPHttpProtoTraceExporter that eve's own `instrumentation/jaeger` registry
  // item uses. Its wire format starts with a field tag byte that JSON.parse
  // rejects, but a hand-rolled parser could easily read a truncated prefix and
  // write half a span. Refusing by content-type keeps a misconfigured exporter
  // from quietly filling the table with corrupt rows.
  if (PROTOBUF_TYPES.some((type) => contentType.includes(type))) {
    return status(
      UNIMPLEMENTED,
      "This endpoint accepts OTLP/HTTP with JSON encoding only; the request " +
        `declared ${contentType}. Use OTLPHttpJsonTraceExporter from @vercel/otel ` +
        "(or set OTEL_EXPORTER_OTLP_PROTOCOL=http/json) instead of the protobuf exporter. " +
        "Nothing was stored.",
      415,
    );
  }

  // Declared size first: `arrayBuffer()` buffers the whole body before anything
  // can look at its length, so a limit checked only afterwards has already cost
  // the memory it was meant to protect.
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return status(
      INVALID_ARGUMENT,
      `payload of ${declaredLength} bytes exceeds the ${MAX_BODY_BYTES} byte limit`,
      413,
    );
  }

  let raw: Buffer;
  try {
    raw = Buffer.from(await request.arrayBuffer());
  } catch (error) {
    return status(INVALID_ARGUMENT, `could not read request body: ${describe(error)}`, 400);
  }
  // A chunked request declares no length, so the check still has to run here.
  if (raw.byteLength > MAX_BODY_BYTES) {
    return status(
      INVALID_ARGUMENT,
      `payload of ${raw.byteLength} bytes exceeds the ${MAX_BODY_BYTES} byte limit`,
      413,
    );
  }

  let text: string;
  try {
    text = decode(raw, (request.headers.get("content-encoding") ?? "").toLowerCase());
  } catch (error) {
    if (isOutputTooLarge(error)) {
      return status(
        INVALID_ARGUMENT,
        `compressed body inflates past the ${MAX_DECOMPRESSED_BYTES} byte limit`,
        413,
      );
    }
    return status(INVALID_ARGUMENT, `could not decompress request body: ${describe(error)}`, 400);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    // A protobuf exporter that omits or mislabels its content-type lands here.
    // Say so, because "Unexpected token" would send the reader hunting in the
    // wrong place entirely.
    return status(
      INVALID_ARGUMENT,
      "body is not valid JSON. If this exporter sends OTLP over protobuf, switch it " +
        "to the JSON encoding — this endpoint does not decode protobuf.",
      400,
    );
  }

  let parsed;
  try {
    parsed = parseOtlpTraces(payload);
  } catch (error) {
    if (error instanceof OtlpFormatError) {
      return status(INVALID_ARGUMENT, `not an OTLP ExportTraceServiceRequest: ${error.message}`, 400);
    }
    throw error;
  }

  try {
    await insertSpans(parsed.spans);
  } catch (error) {
    // 503 is the retryable signal in OTLP. The exporter holds the batch and
    // sends it again, so a Postgres restart costs latency rather than traces.
    return status(UNAVAILABLE, `could not store spans: ${describe(error)}`, 503, {
      "Retry-After": "5",
    });
  }

  // OTLP requires a full response body on success — an empty ExportTraceServiceResponse
  // is `{}`, and `partialSuccess` appears only when something was actually dropped.
  // Reporting rejected spans is what stops an exporter retrying a batch it can
  // never get accepted.
  //
  // "unstorable" rather than "missing", because a rejection is no longer only an
  // absent field. A timestamp too large for the `bigint` column it lands in is
  // rejected here too, and it has to be: it used to throw from inside
  // insertSpans, which from up here is indistinguishable from a dead database,
  // so this route answered 503 + Retry-After and one span with a double-scaled
  // clock made an exporter resend the identical batch forever.
  if (parsed.rejected > 0) {
    return Response.json({
      partialSuccess: {
        rejectedSpans: String(parsed.rejected),
        errorMessage:
          parsed.errors.length > 0
            ? `spans with an unstorable trace id, span id or timestamp: ${parsed.errors.join("; ")}`
            : "spans with an unstorable trace id, span id or timestamp",
      },
    });
  }
  return Response.json({});
}

/**
 * What has landed so far — the quickest way to tell a wired-up exporter from a
 * silent one.
 *
 * getTraceOverview() and not the getTraceStats() this used to call. That one
 * matched `ai.toolCall` and `ai.streamText.doStream` exactly, which are the
 * names eve's LOCAL tracer emits; a deployment that exports — the only kind
 * that can reach this endpoint — sends `execute_tool <name>` and `chat <model>`,
 * so both counts came back 0 from a table full of tool calls and the one
 * question this route exists to answer got the wrong answer. The overview counts
 * both vocabularies, and it carries `unattributedSpans` besides: spans that
 * arrived with ids the schema did not recognise, which is the other way
 * "nothing was ingested" can be wrong.
 *
 * Counts only, never span contents, because spans carry prompt bodies and tool
 * arguments. It used to be unauthenticated, on the stated grounds that "the
 * dashboard binds to 127.0.0.1". It does not: the Dockerfile ends with
 * `next start --hostname 0.0.0.0`, so that sentence was describing an intention
 * rather than a control, and even a count of sessions and tool calls is a
 * business metric. Same tier as POST now.
 */
export async function GET(request: Request): Promise<Response> {
  if (!ingestAuthorized(request)) {
    return status(UNAUTHENTICATED, INGEST_UNAUTHENTICATED_MESSAGE, 401);
  }

  try {
    return Response.json({
      ok: true,
      endpoint: "/api/ingest/v1/traces",
      ...(await getTraceOverview()),
    });
  } catch (error) {
    return Response.json({ ok: false, error: describe(error) }, { status: 503 });
  }
}

function decode(body: Buffer, encoding: string): string {
  const limit = { maxOutputLength: MAX_DECOMPRESSED_BYTES };
  if (encoding.includes("gzip")) return gunzipSync(body, limit).toString("utf8");
  if (encoding.includes("deflate")) return inflateSync(body, limit).toString("utf8");
  return body.toString("utf8");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** zlib's signal that `maxOutputLength` stopped it, rather than a corrupt stream. */
function isOutputTooLarge(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ERR_BUFFER_TOO_LARGE" || code === "ERR_ZLIB_MAX_OUTPUT_LENGTH_EXCEEDED";
}
