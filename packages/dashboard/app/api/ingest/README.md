# Trace ingest

Receive OpenTelemetry spans from an eve agent over OTLP/HTTP and store them in
Postgres, so the dashboard can show what the agent was told and what its tools
returned.

```
POST http://localhost:4000/api/ingest/v1/traces
```

## Why this exists

`workflow.workflow_runs` — the table the rest of the dashboard reads — records
that a turn ran, which model it used, and how many tokens it burned. It records
nothing about content. The system prompt, the message history, the arguments the
model passed to `bash`, and what came back all live on OpenTelemetry spans and
nowhere else.

This endpoint is the second tier: spans go into the `evestack` schema, keyed so
they join back to the same `wrun_...` session ids that key `workflow_runs`.

The `evestack` schema is ours alone. `workflow` belongs to world-postgres and is
read-only from here; dropping `evestack` costs telemetry and never a durable
session.

## Point an agent at it

The template already ships this — `templates/default/agent/instrumentation.ts` —
and it activates as soon as the endpoint URL is set:

```bash
# templates/default/.env.local
EVESTACK_DASHBOARD_URL=http://localhost:4000/api/ingest/v1/traces
```

The full path matters. `@vercel/otel` uses the `url` option verbatim and appends
nothing, so a bare origin or the conventional collector address
(`http://localhost:4318/v1/traces`) will not reach this route.

Restart `eve dev` after setting it. With the variable unset, the template
registers no exporter at all and no traces are shipped.

## Writing the exporter yourself

If you are wiring a different agent, this is the whole of it:

```ts
// agent/instrumentation.ts
import { OTLPHttpJsonTraceExporter, registerOTel } from "@vercel/otel";
import { defineInstrumentation } from "eve/instrumentation";

export default defineInstrumentation({
  setup: ({ agentName }) =>
    registerOTel({
      serviceName: agentName,
      traceExporter: new OTLPHttpJsonTraceExporter({
        url: process.env.EVESTACK_DASHBOARD_URL,
      }),
    }),
  // The prompts and tool payloads are the entire reason to ship traces here.
  // Set both to false for sensitive or regulated data — you keep timing and
  // token counts and lose the bodies.
  recordInputs: true,
  recordOutputs: true,
});
```

**Use `OTLPHttpJsonTraceExporter`, not `OTLPHttpProtoTraceExporter.`** This is the
one way this differs from eve's own `instrumentation/jaeger` registry item, which
is otherwise the same three lines: Jaeger takes protobuf, so that item reaches for
`OTLPHttpProtoTraceExporter`. Swapping the exporter and leaving everything else
alone is exactly the mistake to expect here, so this endpoint rejects protobuf by
content type with `415` and a message naming the fix, rather than half-decoding a
span into the table. Nothing is stored on that path.

A non-eve OpenTelemetry SDK works too, via the standard environment variables:

```bash
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4000/api/ingest/v1/traces
OTEL_EXPORTER_OTLP_PROTOCOL=http/json   # the default is http/protobuf — this endpoint will refuse it
```

## What it accepts

| | |
| --- | --- |
| Encoding | OTLP/HTTP, JSON only (`application/json`) |
| Compression | none, `gzip`, or `deflate` via `content-encoding` |
| Max body | 32 MB compressed **and** 32 MB decompressed — zlib enforces the second while inflating, so a gzip bomb is refused rather than buffered |
| gRPC (`:4317`) | not served |

OTLP attribute values arrive type-tagged — `{"intValue": 1}` rather than `1`.
They are unwrapped on the way in, so `attributes` reads as plain JSON:

```sql
SELECT attributes ->> 'gen_ai.tool.name' FROM evestack.spans WHERE name = 'ai.toolCall';
```

int64 fields are accepted both as JSON numbers (what eve sends) and as strings
(what the OTLP JSON spec prescribes). A value past 2^53 keeps its string form
rather than being silently rounded.

## Responses

| Status | Body | Meaning |
| --- | --- | --- |
| `200` | `{}` | every span stored |
| `200` | `{"partialSuccess":{"rejectedSpans":"2","errorMessage":"…"}}` | some spans were unreadable; the rest are stored, and the exporter should not retry |
| `400` | `{"code":3,"message":"…"}` | not JSON, or not an `ExportTraceServiceRequest` |
| `413` | `{"code":3,"message":"…"}` | body over the size limit, before or after decompression |
| `415` | `{"code":12,"message":"…"}` | protobuf encoding |
| `503` | `{"code":14,"message":"…"}` + `Retry-After: 5` | Postgres unreachable — retryable, so the exporter holds the batch |

Error bodies are `google.rpc.Status`, which is what OTLP asks for. Delivery is
at-least-once and spans upsert on `(trace_id, span_id)`, so a retried batch
refreshes rows instead of duplicating them.

## Check it is working

```bash
curl -s http://localhost:4000/api/ingest/v1/traces
# {"ok":true,"endpoint":"/api/ingest/v1/traces","spans":16,"traces":1,"sessions":1,
#  "toolCalls":1,"modelCalls":3,"lastReceivedAt":"..."}
```

`spans: 0` after a conversation means the exporter never fired: check
`EVESTACK_DASHBOARD_URL`, and check that `eve dev` was restarted after setting it.

## Replaying eve's local spool

When no `instrumentation.ts` exists, eve writes the same OTLP/JSON to
`.eve/traces/v1/<traceId>/segments/*.otlp.json`. Those files post here unchanged,
which is the easiest way to load real data:

```bash
for f in templates/default/.eve/traces/v1/*/segments/*.otlp.json; do
  curl -sS -X POST http://localhost:4000/api/ingest/v1/traces \
    -H 'content-type: application/json' --data-binary @"$f" -o /dev/null -w "%{http_code} "
done
```

Re-running it is safe — the same spans upsert.

Worth knowing: authoring `agent/instrumentation.ts` **disables** that spool, and
with it `eve traces`. eve hands telemetry to authored instrumentation and does
not run its own writer alongside. This dashboard is the replacement — it keeps
history past the spool's bounds (7 days / 512 MB / 20 traces) and survives
`eve dev` exiting.

## Where the data goes

`evestack.spans`, created on demand from
[`sql/traces.sql`](../../../sql/traces.sql) on the first request. Read it through
[`lib/traces.ts`](../../../lib/traces.ts) rather than by hand:

- `listSpansBySession(id)` — every span of a session
- `getSpanTree(id)` — the same spans nested, with session and turn ids filled in from ancestors
- `listModelCalls(id)` — system prompt, message history, response text, per model call
- `listToolCalls(id)` — tool name, arguments, result, per invocation
- `getTraceStats()` — what the `GET` above returns

The inheritance is not a convenience. Only eve's own spans (`agent.session`,
`agent.turn`, `agent.step`, `agent.action`) carry `agent.session.id`; the AI SDK
spans nested under them (`ai.streamText`, `ai.streamText.doStream`, `ai.toolCall`)
carry none — and those hold the prompts and the tool payloads. Filtering by
`session_id` returns precisely the spans with nothing to say. Read a session by
resolving it to trace ids first, then taking whole traces, which is what the
helpers above do.
