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

## Auth

**This endpoint is not open.** Every other route in the dashboard is behind a
session cookie (see `proxy.ts`); this one is behind a shared secret instead,
because an exporter is a program and cannot sign in.

```bash
# .env.local, on the dashboard
EVESTACK_INGEST_TOKEN=$(openssl rand -hex 32)
```

Send it in the `x-evestack-ingest-token` header, or as `Authorization: Bearer`.
Both work; the dedicated header is preferred because it does not collide with
the Basic credentials the same deployment uses everywhere else.

With `EVESTACK_INGEST_TOKEN` **unset**, this route falls back to ordinary session
auth: a signed-in browser or `curl -u` still works, and an anonymous exporter
gets `401` with a message naming the variable. It does not fall back to open.

So there is no configuration in which an exporter works without this token. Set
it, on both sides, or ship no traces:

| dashboard | agent | result |
| --- | --- | --- |
| set | same value | spans stored |
| set | different value | `401`, every span |
| set | unset | `401`, every span |
| unset | set | `401`, every span |
| unset | unset | `401`, every span |

### A 401 here looks like success to the exporter

This is why the mismatch is worth spelling out. `@vercel/otel`'s exporter is a
`fetch` with a `.then` that reports success and a `.catch` that reports failure —
and an HTTP 401 **resolves** a fetch. A refused batch therefore comes back as
`ExportResultCode.SUCCESS`, the spans are dropped, and nothing is retried. The
status is passed to `diag.debug`, and `@vercel/otel` installs a diag logger only
when `OTEL_LOG_LEVEL` is set. Nothing in the agent's output changes.

`templates/default/agent/instrumentation.ts` therefore issues one `GET` against
this endpoint at startup, with the same credential, and prints a loud line when
it is refused. If you write your own exporter, do the same — otherwise a wrong
token and an idle agent are the same observation.

This is a change of policy, and the reasoning is worth recording. The route used
to be unauthenticated on the grounds that "an OTLP exporter has nowhere to put a
credential, which is exactly why the dashboard binds to 127.0.0.1". Both halves
were wrong:

- Every OTLP exporter takes custom headers. `OTLPHttpJsonTraceExporter` has a
  `headers` option; any other SDK reads `OTEL_EXPORTER_OTLP_HEADERS`. There is a
  place to put a credential.
- The dashboard does not bind to loopback. `packages/dashboard/Dockerfile` ends
  with `next start --hostname 0.0.0.0`, which it must, or nothing outside the
  container could reach it. Anyone who can route to port 4000 could POST spans.

Loopback-only was considered as the alternative and rejected: nothing inside a
Next route handler can see the peer address, and `Host` and `X-Forwarded-For`
are both set by the client, so a loopback check written here would be a comment
rather than a control. If you want that guarantee, take it at the layer that can
enforce it — publish the port as `127.0.0.1:4000:4000` in compose rather than
`4000:4000`.

Anonymous ingest is worth naming precisely, since it is what this replaces. A
span carries the system prompt, the message history, and the arguments the model
passed to `bash`. An open POST also lets anyone write rows into
`evestack.spans`, which is how a dashboard ends up displaying a fabricated
conversation as if the agent had held it.

### Point the agent at it

```ts
// agent/instrumentation.ts
const token = process.env.EVESTACK_INGEST_TOKEN?.trim();

traceExporter: new OTLPHttpJsonTraceExporter({
  url: process.env.EVESTACK_DASHBOARD_URL,
  // Omitted entirely when unset, rather than sent empty: this is byte for byte
  // the request the exporter made before ingest grew a credential.
  ...(token ? { headers: { "x-evestack-ingest-token": token } } : {}),
}),
```

The agent and the dashboard need the same value, byte for byte.

How it gets to both depends on how you started them. A project scaffolded by
`create-evestack` has one `.env.local`: the agent runs on the host and reads it
directly, and the generated `docker-compose.yml` gives the dashboard container
the same file via `env_file:`, so the token is generated once and cannot drift.
Run the dashboard some other way — `pnpm dev` inside a clone of this repo, or a
compose file of your own — and it has its own `.env.local`, so the value has to
be copied across by hand.

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

const token = process.env.EVESTACK_INGEST_TOKEN?.trim();

export default defineInstrumentation({
  setup: ({ agentName }) =>
    registerOTel({
      serviceName: agentName,
      traceExporter: new OTLPHttpJsonTraceExporter({
        url: process.env.EVESTACK_DASHBOARD_URL,
        ...(token ? { headers: { "x-evestack-ingest-token": token } } : {}),
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
OTEL_EXPORTER_OTLP_HEADERS=x-evestack-ingest-token=<the token>
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
| `401` | `{"code":16,"message":"…"}` | no ingest token and no session — see [Auth](#auth). Not retryable until the exporter is given the token |
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
curl -s -H "x-evestack-ingest-token: $EVESTACK_INGEST_TOKEN" \
  http://localhost:4000/api/ingest/v1/traces
# {"ok":true,"endpoint":"/api/ingest/v1/traces","spans":16,"traces":1,"sessions":1,
#  "toolCalls":1,"modelCalls":3,"lastReceivedAt":"..."}
```

`curl -u "$EVESTACK_AUTH_USER:$EVESTACK_AUTH_PASSWORD"` works too, and is the
only way in when no ingest token is configured.

`spans: 0` after a conversation means nothing reached this route. Check the
agent's own startup output first — the template's instrumentation probes this
endpoint at boot and prints `[evestack:traces] the dashboard REJECTED this
exporter's credential (401)` when the tokens disagree, which is the single
fastest way to tell a credential problem from an exporter that never fired. Then
check `EVESTACK_DASHBOARD_URL` is the full path, and that `eve dev` was restarted
after changing either variable.

## Replaying eve's local spool

When no `instrumentation.ts` exists, eve writes the same OTLP/JSON to
`.eve/traces/v1/<traceId>/segments/*.otlp.json`. Those files post here unchanged,
which is the easiest way to load real data:

```bash
for f in templates/default/.eve/traces/v1/*/segments/*.otlp.json; do
  curl -sS -X POST http://localhost:4000/api/ingest/v1/traces \
    -H 'content-type: application/json' \
    -H "x-evestack-ingest-token: $EVESTACK_INGEST_TOKEN" \
    --data-binary @"$f" -o /dev/null -w "%{http_code} "
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
