import { gunzipSync, inflateSync } from "node:zlib";
import {
  getTraceStats,
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
 */

// google.rpc.Code, the status vocabulary OTLP borrows for error bodies.
const INVALID_ARGUMENT = 3;
const UNIMPLEMENTED = 12;
const UNAVAILABLE = 14;

// eve caps a single span attribute at 32 KB, and a batch is a few dozen spans.
// A payload past this is a misconfiguration, and buffering it would be the
// dashboard's problem rather than the sender's.
const MAX_BODY_BYTES = 32 * 1024 * 1024;

const PROTOBUF_TYPES = [
  "application/x-protobuf",
  "application/protobuf",
  "application/x-google-protobuf",
];

function status(code: number, message: string, httpStatus: number, headers?: HeadersInit) {
  return Response.json({ code, message }, { status: httpStatus, headers });
}

export async function POST(request: Request): Promise<Response> {
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

  let raw: Buffer;
  try {
    raw = Buffer.from(await request.arrayBuffer());
  } catch (error) {
    return status(INVALID_ARGUMENT, `could not read request body: ${describe(error)}`, 400);
  }
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
  if (parsed.rejected > 0) {
    return Response.json({
      partialSuccess: {
        rejectedSpans: String(parsed.rejected),
        errorMessage:
          parsed.errors.length > 0
            ? `spans missing a usable trace id, span id, or start time: ${parsed.errors.join("; ")}`
            : "spans missing a usable trace id, span id, or start time",
      },
    });
  }
  return Response.json({});
}

/**
 * What has landed so far — the quickest way to tell a wired-up exporter from a
 * silent one.
 *
 * Counts only, never span contents, because spans carry prompt bodies and tool
 * arguments. Both this and POST are unauthenticated by design: an OTLP exporter
 * has nowhere to put a credential, which is exactly why the dashboard binds to
 * 127.0.0.1 and must not be exposed without auth in front of it.
 */
export async function GET(): Promise<Response> {
  try {
    return Response.json({ ok: true, endpoint: "/api/ingest/v1/traces", ...(await getTraceStats()) });
  } catch (error) {
    return Response.json({ ok: false, error: describe(error) }, { status: 503 });
  }
}

function decode(body: Buffer, encoding: string): string {
  if (encoding.includes("gzip")) return gunzipSync(body).toString("utf8");
  if (encoding.includes("deflate")) return inflateSync(body).toString("utf8");
  return body.toString("utf8");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
