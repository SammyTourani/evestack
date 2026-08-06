import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cache } from "react";
import { query } from "./db";

/**
 * Tier two: OpenTelemetry spans.
 *
 * `workflow.workflow_runs` answers what ran, how long it took, and what it
 * cost. It cannot answer what the agent was actually told or what a tool
 * returned — eve never writes prompt bodies or tool arguments to a run row.
 * Those exist only on spans, which is why this module exists at all.
 *
 * The shape that governs every query here, verified against real spans in
 * templates/default/.eve/traces/v1:
 *
 *   agent.session            agent.session.id, agent.root.session.id
 *     agent.turn             + agent.turn.id, agent.turn.sequence
 *       agent.step           + agent.step.index, agent.model.id, agent.usage.*
 *         ai.streamText      -- no eve ids
 *           ai.streamText.doStream   ai.prompt.system, ai.prompt.messages,
 *                                    ai.response.text, ai.response.tool_calls
 *       agent.action         + agent.action.name, agent.action.call_id
 *         ai.toolCall        gen_ai.tool.name, .call.arguments, .call.result
 *       agent.turn.terminal
 *
 * Note where the ids stop. Every span eve creates carries `agent.session.id`;
 * every span the AI SDK creates carries none — and the AI SDK's spans are the
 * ones holding the prompts and the tool payloads. Filtering by session id
 * therefore returns exactly the spans with the least to say. Every read below
 * resolves the session to its trace ids first and then takes whole traces,
 * reattaching session and turn ids by walking parents.
 */

export interface SpanEvent {
  name: string;
  timeUnixNano: string | null;
  attributes: Record<string, unknown>;
}

/** A span parsed out of an OTLP payload, ready to insert. */
export interface IngestedSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: number;
  startUnixNano: string;
  endUnixNano: string | null;
  statusCode: number;
  statusMessage: string | null;
  attributes: Record<string, unknown>;
  resource: Record<string, unknown>;
  events: SpanEvent[];
  scopeName: string | null;
  scopeVersion: string | null;
}

/** A span read back out of Postgres. */
export interface SpanRow {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: number;
  startTime: string;
  endTime: string | null;
  durationMs: number | null;
  statusCode: number;
  statusMessage: string | null;
  attributes: Record<string, unknown>;
  resource: Record<string, unknown>;
  events: SpanEvent[];
  scopeName: string | null;
  sessionId: string | null;
  rootSessionId: string | null;
  turnId: string | null;
}

/** A span plus the ids and depth it only has by virtue of its ancestors. */
export interface SpanNode extends SpanRow {
  depth: number;
  children: SpanNode[];
}

export interface ModelCall {
  spanId: string;
  turnId: string | null;
  stepIndex: number | null;
  model: string | null;
  provider: string | null;
  systemPrompt: string | null;
  /** JSON text as the AI SDK recorded it — a message array, not a plain string. */
  promptMessages: string | null;
  responseText: string | null;
  responseToolCalls: string | null;
  finishReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  startTime: string;
  durationMs: number | null;
}

export interface ToolCall {
  spanId: string;
  turnId: string | null;
  stepIndex: number | null;
  name: string | null;
  callId: string | null;
  /** JSON text, exactly as the model emitted it. Left unparsed so a malformed
   *  argument object stays inspectable instead of throwing on read. */
  argumentsJson: string | null;
  resultJson: string | null;
  startTime: string;
  durationMs: number | null;
  statusCode: number;
}

export class OtlpFormatError extends Error {}

// --- OTLP parsing ------------------------------------------------------------

/**
 * OTLP wraps every attribute in a type tag: `{"intValue": 1}`, not `1`. Storing
 * the wrapper would push the unwrapping cost onto every query and every reader,
 * so it happens once, here, on the way in.
 */
function unwrapAnyValue(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;

  if ("stringValue" in value) return String(value.stringValue ?? "");
  if ("boolValue" in value) return Boolean(value.boolValue);
  if ("intValue" in value) return unwrapInt(value.intValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  // Per the OTLP JSON mapping a bytes field arrives base64-encoded. Decoding it
  // to text would guess at an encoding nobody promised, so it stays as-is.
  if ("bytesValue" in value) return String(value.bytesValue ?? "");
  if ("arrayValue" in value) {
    const values = (value.arrayValue as { values?: unknown[] } | null)?.values;
    return Array.isArray(values) ? values.map(unwrapAnyValue) : [];
  }
  if ("kvlistValue" in value) {
    const values = (value.kvlistValue as { values?: unknown[] } | null)?.values;
    return unwrapAttributes(values);
  }
  // An AnyValue with no field set is OTLP's way of saying "unset".
  return null;
}

/**
 * int64 is a string in the OTLP JSON spec but a number in the exporter eve
 * ships. Both appear in the wild, so both are accepted — and a value past
 * 2^53 keeps its string form rather than being silently rounded.
 */
function unwrapInt(raw: unknown): number | string {
  if (typeof raw === "number") return raw;
  const text = String(raw ?? "0");
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : text;
}

function unwrapAttributes(raw: unknown): Record<string, unknown> {
  if (!Array.isArray(raw)) return {};
  const out: Record<string, unknown> = {};
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const { key, value } = entry as { key?: unknown; value?: unknown };
    if (typeof key !== "string" || key.length === 0) continue;
    out[key] = unwrapAnyValue(value);
  }
  return out;
}

/**
 * OTLP/JSON specifies hex for trace and span ids, and that is what eve sends.
 * A generic protobuf-to-JSON encoder would emit base64 for the same bytes
 * field, and storing that verbatim would break every join against a hex id
 * from another tool — so a non-hex id is decoded rather than trusted.
 */
function normalizeId(raw: unknown, byteLength: number): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw.length === byteLength * 2 && /^[0-9a-f]+$/i.test(raw)) {
    return raw.toLowerCase();
  }
  try {
    const bytes = Buffer.from(raw, "base64");
    if (bytes.length === byteLength) return bytes.toString("hex");
  } catch {
    // fall through
  }
  return null;
}

function unixNano(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const text = typeof raw === "number" ? BigInt(Math.trunc(raw)).toString() : String(raw);
  return /^\d+$/.test(text) && text !== "0" ? text : null;
}

function parseEvents(raw: unknown): SpanEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const event = entry as Record<string, unknown>;
    return [
      {
        name: String(event.name ?? ""),
        timeUnixNano: unixNano(event.timeUnixNano),
        attributes: unwrapAttributes(event.attributes),
      },
    ];
  });
}

export interface ParsedOtlp {
  spans: IngestedSpan[];
  /** Spans present in the payload that could not be read. Reported back to the
   *  exporter as OTLP partial success so it stops retrying them. */
  rejected: number;
  /** Spans read fine and discarded on purpose — see `droppedSpanNames`. Not a
   *  rejection: the exporter did nothing wrong and must not retry them. */
  dropped: number;
  errors: string[];
}

// --- Ingest policy -----------------------------------------------------------

/**
 * Span names thrown away at the door.
 *
 * Measured on a live install: 30,560 of 32,991 spans — 92.6% — were
 * `workflow.stream.read.complete`, one per stream read the workflow engine
 * performs. Each is its own single-span trace, carries no agent identity, and
 * stamps `workflow.run.id` with the all-zero placeholder that joins to nothing,
 * so no page can render one and no aggregate can group by one. 38 MB for 42
 * runs, in the same Postgres that holds durable session state, extrapolates to
 * roughly 9 GB at ten thousand sessions.
 *
 * So the default is to drop it, because the alternative default — keep
 * everything — is the one that silently fills a disk for someone who never
 * reads this. Both directions are configurable:
 *
 *   EVESTACK_TRACE_DROP_SPANS unset  → the list below
 *   EVESTACK_TRACE_DROP_SPANS="a,b"  → exactly those names, nothing else
 *   EVESTACK_TRACE_DROP_SPANS=""     → keep every span; nothing is dropped
 *
 * Exact names, not prefixes: `workflow.*` would also swallow
 * `workflow.run.start`, and a glob syntax nobody asked for is a second thing to
 * get wrong.
 */
const DEFAULT_DROP_SPAN_NAMES = ["workflow.stream.read.complete"];

export function droppedSpanNames(): ReadonlySet<string> {
  const raw = process.env.EVESTACK_TRACE_DROP_SPANS;
  if (raw === undefined) return new Set(DEFAULT_DROP_SPAN_NAMES);
  return new Set(
    raw
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
  );
}

/** Days of spans kept. `null` means retention is off. */
const DEFAULT_RETENTION_DAYS = 30;

/**
 * How long a span survives.
 *
 * EVESTACK_TRACE_RETENTION_DAYS=0 turns pruning off, which is a legitimate
 * choice (an external pipeline owning the table, a compliance hold) and an
 * explicit one. A value that is not a positive number is a typo, not a policy:
 * it says so and falls back to the default rather than quietly meaning "keep
 * forever".
 */
export function retentionDays(): number | null {
  const raw = process.env.EVESTACK_TRACE_RETENTION_DAYS?.trim();
  if (raw === undefined || raw === "") return DEFAULT_RETENTION_DAYS;
  const days = Number(raw);
  if (days === 0) return null;
  if (Number.isFinite(days) && days > 0) return days;
  console.warn(
    `[evestack] EVESTACK_TRACE_RETENTION_DAYS=${raw} is not a positive number of days; ` +
      `keeping the ${DEFAULT_RETENTION_DAYS}-day default.`,
  );
  return DEFAULT_RETENTION_DAYS;
}

/** The two knobs above, as the ingest endpoint reports them. */
export interface IngestPolicy {
  dropSpanNames: string[];
  retentionDays: number | null;
}

export function ingestPolicy(): IngestPolicy {
  return { dropSpanNames: [...droppedSpanNames()].sort(), retentionDays: retentionDays() };
}

/**
 * Turn an OTLP/HTTP JSON ExportTraceServiceRequest into insertable rows.
 *
 * A malformed envelope throws — the exporter needs a 400 so it drops the batch.
 * A single unreadable span does not: it is counted and the rest are kept, which
 * is what OTLP's partial-success response exists to express.
 *
 * `drop` is taken once per payload rather than per span so that one request is
 * decided by one policy, and is injectable so a test can state the policy it is
 * testing instead of reaching for the environment.
 */
export function parseOtlpTraces(
  payload: unknown,
  drop: ReadonlySet<string> = droppedSpanNames(),
): ParsedOtlp {
  if (!payload || typeof payload !== "object") {
    throw new OtlpFormatError("body must be a JSON object");
  }
  const resourceSpans = (payload as { resourceSpans?: unknown }).resourceSpans;
  if (!Array.isArray(resourceSpans)) {
    throw new OtlpFormatError("missing `resourceSpans` array");
  }

  const spans: IngestedSpan[] = [];
  const errors: string[] = [];
  let rejected = 0;
  let dropped = 0;

  for (const resourceSpan of resourceSpans) {
    if (!resourceSpan || typeof resourceSpan !== "object") continue;
    const { resource, scopeSpans } = resourceSpan as {
      resource?: { attributes?: unknown };
      scopeSpans?: unknown;
    };
    const resourceAttributes = unwrapAttributes(resource?.attributes);
    if (!Array.isArray(scopeSpans)) continue;

    for (const scopeSpan of scopeSpans) {
      if (!scopeSpan || typeof scopeSpan !== "object") continue;
      const scope = (scopeSpan as { scope?: { name?: unknown; version?: unknown } }).scope;
      const rawSpans = (scopeSpan as { spans?: unknown }).spans;
      if (!Array.isArray(rawSpans)) continue;

      for (const raw of rawSpans) {
        if (!raw || typeof raw !== "object") {
          rejected += 1;
          continue;
        }
        const span = raw as Record<string, unknown>;
        const name = String(span.name ?? "");

        // Before the ids are even looked at: a dropped span is not being
        // judged, it is not wanted.
        if (drop.has(name)) {
          dropped += 1;
          continue;
        }

        const traceId = normalizeId(span.traceId, 16);
        const spanId = normalizeId(span.spanId, 8);
        const start = unixNano(span.startTimeUnixNano);

        if (!traceId || !spanId || !start) {
          rejected += 1;
          if (errors.length < 5) {
            errors.push(
              `span ${name || "<unnamed>"}: ` +
                `${!traceId ? "bad traceId" : !spanId ? "bad spanId" : "bad startTimeUnixNano"}`,
            );
          }
          continue;
        }

        const status = (span.status ?? {}) as { code?: unknown; message?: unknown };
        spans.push({
          traceId,
          spanId,
          parentSpanId: normalizeId(span.parentSpanId, 8),
          name,
          kind: Number(span.kind ?? 0) || 0,
          startUnixNano: start,
          endUnixNano: unixNano(span.endTimeUnixNano),
          statusCode: Number(status.code ?? 0) || 0,
          statusMessage: status.message ? String(status.message) : null,
          attributes: unwrapAttributes(span.attributes),
          resource: resourceAttributes,
          events: parseEvents(span.events),
          scopeName: scope?.name ? String(scope.name) : null,
          scopeVersion: scope?.version ? String(scope.version) : null,
        });
      }
    }
  }

  return { spans, rejected, dropped, errors };
}

// --- Schema ------------------------------------------------------------------

let schemaReady: Promise<void> | null = null;

/**
 * Apply sql/traces.sql, once per process.
 *
 * The DDL is read from disk rather than duplicated here so there is one
 * definition of the table: the file an operator can also pipe straight into
 * psql. Every read path calls this too, so a dashboard pointed at a database
 * that has never received a span renders an empty state instead of a 42P01.
 */
export function ensureTraceSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = query(readSchemaSql())
      .then(() => undefined)
      // A failed bootstrap must not be cached, or a database that was merely
      // unreachable at boot stays "broken" for the life of the process.
      .catch((error: unknown) => {
        schemaReady = null;
        throw error;
      });
  }
  return schemaReady;
}

function readSchemaSql(): string {
  let dir = process.cwd();
  for (let up = 0; up < 5; up += 1) {
    try {
      return readFileSync(join(dir, "sql", "traces.sql"), "utf8");
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error(
    `Could not find sql/traces.sql above ${process.cwd()}. ` +
      "Run the dashboard from packages/dashboard, or apply the file by hand.",
  );
}

// --- Ingest ------------------------------------------------------------------

const COLUMNS_PER_ROW = 16;
// Postgres caps a statement at 65535 bound parameters. 500 rows is far under
// that and keeps a single oversized prompt batch from building a giant string.
const INSERT_CHUNK = 500;

/**
 * Upsert spans. Re-posting a batch is a no-op beyond refreshing the row, which
 * matters because OTLP delivery is at-least-once and an exporter that times out
 * after we commit will send the identical batch again.
 */
export async function insertSpans(spans: readonly IngestedSpan[]): Promise<number> {
  if (spans.length === 0) return 0;
  await ensureTraceSchema();

  let written = 0;
  for (let offset = 0; offset < spans.length; offset += INSERT_CHUNK) {
    const chunk = spans.slice(offset, offset + INSERT_CHUNK);
    const params: unknown[] = [];
    const tuples = chunk.map((span, index) => {
      const base = index * COLUMNS_PER_ROW;
      params.push(
        span.traceId,
        span.spanId,
        span.parentSpanId,
        span.name,
        span.kind,
        span.startUnixNano,
        span.endUnixNano,
        isoFromUnixNano(span.startUnixNano),
        isoFromUnixNano(span.endUnixNano),
        span.statusCode,
        span.statusMessage,
        JSON.stringify(span.attributes),
        JSON.stringify(span.resource),
        JSON.stringify(span.events),
        span.scopeName,
        span.scopeVersion,
      );
      const slots = Array.from({ length: COLUMNS_PER_ROW }, (_, i) => `$${base + i + 1}`);
      return `(${slots.join(",")})`;
    });

    await query(
      `
      INSERT INTO evestack.spans (
        trace_id, span_id, parent_span_id, name, kind,
        start_unix_nano, end_unix_nano, start_time, end_time,
        status_code, status_message,
        attributes, resource, events, scope_name, scope_version
      )
      VALUES ${tuples.join(",")}
      ON CONFLICT (trace_id, span_id) DO UPDATE SET
        parent_span_id = EXCLUDED.parent_span_id,
        name           = EXCLUDED.name,
        kind           = EXCLUDED.kind,
        end_unix_nano  = EXCLUDED.end_unix_nano,
        end_time       = EXCLUDED.end_time,
        status_code    = EXCLUDED.status_code,
        status_message = EXCLUDED.status_message,
        attributes     = EXCLUDED.attributes,
        resource       = EXCLUDED.resource,
        events         = EXCLUDED.events,
        scope_name     = EXCLUDED.scope_name,
        scope_version  = EXCLUDED.scope_version,
        received_at    = now()
      `,
      params,
    );
    written += chunk.length;
  }

  const days = retentionDays();
  warnExpiredOnArrival(spans, days);
  void maybePrune(days);
  return written;
}

/**
 * Say so when a batch is stored and already doomed.
 *
 * Nothing else can. `maybePrune` below is fire-and-forget, so the 200 goes out
 * before the DELETE runs; OTLP has no "accepted, then discarded" to report, and
 * `partialSuccess` would be a lie — the exporter did nothing wrong and must not
 * retry. Without this line the write path is silent about writing nothing.
 *
 * Two senders land here and neither can tell from the outside. One is replaying
 * a backlog older than the window, which is a real thing to do and worth one
 * warning. The other is sending milliseconds in `startTimeUnixNano`, which OTLP
 * defines as nanoseconds: every span it sends dates to 1970, every span is
 * pruned, and it looks exactly like a dashboard that drops everything.
 */
function warnExpiredOnArrival(spans: readonly IngestedSpan[], days: number | null): void {
  if (days === null) return;
  // The window prune_spans will actually apply, not a second opinion about it.
  const cutoffNano = (Date.now() - retentionHours(days) * 3_600_000) * 1e6;
  let expired = 0;
  for (const span of spans) {
    // NaN compares false, so an unparseable start time is not counted here — it
    // was already rejected at the door by parseOtlpTraces.
    if (Number(span.startUnixNano) < cutoffNano) expired += 1;
  }
  if (expired === 0) return;
  console.warn(
    `[evestack] ${expired} of ${spans.length} spans arrived already older than the ` +
      `${days}-day retention window; they were stored and the next prune deletes them. ` +
      "A backlog replay does this. So does an exporter sending milliseconds in " +
      "startTimeUnixNano, where OTLP specifies nanoseconds — that dates every span to 1970.",
  );
}

/**
 * Apply the retention window. Returns rows deleted.
 *
 * The delete itself is `evestack.prune_spans`, so an operator can run exactly
 * the same thing by hand. It deletes one bounded batch per call and this loops,
 * because each call is then its own transaction — a first prune over a long
 * backlog commits as it goes instead of holding locks for the whole of it.
 */
const PRUNE_BATCH = 20_000;

/**
 * The retention window in hours, not days: EVESTACK_TRACE_RETENTION_DAYS=0.5 is
 * a legitimate answer, and rounding it to zero days would turn "keep twelve
 * hours" into "keep everything", which is the opposite of what was asked for.
 *
 * One definition, because `warnExpiredOnArrival` predicts what this deletes. Two
 * roundings would eventually disagree, and a warning about spans that survive is
 * worse than no warning at all.
 */
const retentionHours = (days: number): number => Math.max(1, Math.round(days * 24));

export async function pruneSpans(days: number): Promise<number> {
  await ensureTraceSchema();
  const hours = retentionHours(days);
  let removed = 0;
  for (;;) {
    const [row] = await query<{ removed: string }>(
      "SELECT evestack.prune_spans(make_interval(hours => $1), $2) AS removed",
      [hours, PRUNE_BATCH],
    );
    const batch = Number(row?.removed ?? 0);
    removed += batch;
    if (batch < PRUNE_BATCH) return removed;
  }
}

// Once an hour per process. There is no scheduler in this dashboard and adding
// one for a DELETE would be a second thing to operate; ingest is the only event
// that grows the table, so it is also the only event that needs to shrink it.
// A dashboard nobody exports to therefore never prunes, which is correct.
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let prunedAt = 0;
let pruning = false;

/**
 * Not awaited by insertSpans on purpose: the first prune over a long backlog is
 * seconds of DELETE, and making the exporter wait for it would time out a batch
 * that had already been stored. Failures are logged and retried next hour —
 * retention falling behind must never turn into a 503 on the write path.
 *
 * `days` is passed in rather than read here so that one insert reads the
 * environment once. retentionDays() warns on a malformed value, and reading it
 * twice per batch would print that warning twice per batch.
 */
function maybePrune(days: number | null): Promise<void> {
  const now = Date.now();
  if (days === null || pruning || now - prunedAt < PRUNE_INTERVAL_MS) return Promise.resolve();
  pruning = true;
  prunedAt = now;
  return pruneSpans(days)
    .then(() => undefined)
    .catch((error: unknown) => {
      console.warn(
        `[evestack] span retention (${days}d) failed; will retry in an hour: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    })
    .finally(() => {
      pruning = false;
    });
}

/**
 * Nanoseconds to a timestamp Postgres can parse without losing what it can
 * store. timestamptz holds microseconds, so the last three digits are dropped
 * deliberately — `start_unix_nano` keeps the full precision alongside it.
 */
function isoFromUnixNano(nano: string | null): string | null {
  if (!nano) return null;
  const micros = BigInt(nano) / 1000n;
  const millis = Number(micros / 1000n);
  if (!Number.isFinite(millis)) return null;
  const remainder = Number(micros % 1000n);
  return `${new Date(millis).toISOString().slice(0, -1)}${String(remainder).padStart(3, "0")}Z`;
}

// --- Reads -------------------------------------------------------------------

const SELECT_SPAN = `
  SELECT trace_id, span_id, parent_span_id, name, kind,
         start_time, end_time, duration_ms, status_code, status_message,
         attributes, resource, events, scope_name,
         session_id, root_session_id, turn_id
  FROM evestack.spans
`;

function toSpanRow(raw: Record<string, unknown>): SpanRow {
  return {
    traceId: String(raw.trace_id),
    spanId: String(raw.span_id),
    parentSpanId: (raw.parent_span_id as string) ?? null,
    name: String(raw.name),
    kind: Number(raw.kind ?? 0),
    startTime: new Date(raw.start_time as string).toISOString(),
    endTime: raw.end_time ? new Date(raw.end_time as string).toISOString() : null,
    durationMs: raw.duration_ms === null ? null : Number(raw.duration_ms),
    statusCode: Number(raw.status_code ?? 0),
    statusMessage: (raw.status_message as string) ?? null,
    attributes: (raw.attributes as Record<string, unknown>) ?? {},
    resource: (raw.resource as Record<string, unknown>) ?? {},
    events: (raw.events as SpanEvent[]) ?? [],
    scopeName: (raw.scope_name as string) ?? null,
    sessionId: (raw.session_id as string) ?? null,
    rootSessionId: (raw.root_session_id as string) ?? null,
    turnId: (raw.turn_id as string) ?? null,
  };
}

/**
 * Every span belonging to a session, in start order.
 *
 * The subquery is the whole point: it finds which traces the session owns using
 * the spans that carry its id, then returns those traces entire. Selecting on
 * `session_id` alone would silently drop every ai.* span — the prompts, the
 * responses, the tool arguments. Matching `root_session_id` as well pulls in
 * subagent sessions, which trace separately but belong to the same tree.
 *
 * Still whole traces rather than `resolved_session_id = $1`, even now that the
 * resolved column exists: a span the walk could not attribute (an orphan whose
 * parent was never exported) is still part of the trace a reader opened, and the
 * viewer should show it rather than decide it does not exist.
 *
 * Wrapped in React's `cache` because /traces/[id] asks for the same session
 * three times in one render — the tree, the model calls and the tool calls — and
 * used to issue this query three times for it. `cache` is per-request and, with
 * no request in scope (the ingest route, a test), calls straight through.
 */
export const listSpansBySession = cache(
  async (sessionId: string, limit = 5000): Promise<SpanRow[]> => {
    await ensureTraceSchema();
    const rows = await query<Record<string, unknown>>(
      `${SELECT_SPAN}
     WHERE trace_id IN (
       SELECT DISTINCT trace_id FROM evestack.spans
       WHERE session_id = $1 OR root_session_id = $1
     )
     ORDER BY start_unix_nano, span_id
     LIMIT $2`,
      [sessionId, limit],
    );
    return rows.map(toSpanRow);
  },
);

/**
 * The session's spans as a forest, with session and turn ids filled in from the
 * nearest ancestor that has them.
 *
 * Without that inheritance an `ai.toolCall` cannot be attributed to a turn at
 * all: the AI SDK creates it and stamps none of eve's ids on it. Its parent
 * chain is the only thing that knows where it belongs.
 */
export async function getSpanTree(sessionId: string): Promise<SpanNode[]> {
  return buildSpanTree(await listSpansBySession(sessionId));
}

export function buildSpanTree(spans: readonly SpanRow[]): SpanNode[] {
  const nodes = new Map<string, SpanNode>();
  for (const span of spans) {
    nodes.set(span.spanId, { ...span, depth: 0, children: [] });
  }

  const roots: SpanNode[] = [];
  for (const node of nodes.values()) {
    // A parent outside this result set (a dropped span, or a batch still in
    // flight) makes the child a root rather than an orphan we never render.
    const parent = node.parentSpanId ? nodes.get(node.parentSpanId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const visit = (node: SpanNode, depth: number, inherited: SpanNode | null): void => {
    node.depth = depth;
    node.sessionId ??= inherited?.sessionId ?? null;
    node.rootSessionId ??= inherited?.rootSessionId ?? null;
    node.turnId ??= inherited?.turnId ?? null;
    for (const child of node.children) visit(child, depth + 1, node);
  };
  for (const root of roots) visit(root, 0, null);

  return roots;
}

function flatten(nodes: readonly SpanNode[]): SpanNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

interface SpanIndex {
  nodes: SpanNode[];
  byId: Map<string, SpanNode>;
}

async function loadSpanIndex(sessionId: string): Promise<SpanIndex> {
  const nodes = flatten(await getSpanTree(sessionId));
  return { nodes, byId: new Map(nodes.map((node) => [node.spanId, node])) };
}

/**
 * An attribute from this span or the nearest ancestor that has it.
 *
 * The tree is layered by owner: eve stamps the step index on `agent.step`, the
 * AI SDK creates two more spans beneath it, and the one holding the prompt sits
 * at the bottom knowing nothing about which step it belongs to. Walking up is
 * the only way to answer "which step produced this call".
 */
function ancestorAttribute(
  node: SpanNode,
  byId: ReadonlyMap<string, SpanNode>,
  key: string,
): unknown {
  let current: SpanNode | undefined = node;
  while (current) {
    const value = current.attributes[key];
    if (value !== undefined && value !== null) return value;
    current = current.parentSpanId ? byId.get(current.parentSpanId) : undefined;
  }
  return undefined;
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;
const num = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * The prompts and completions, per model call. This is the data that exists
 * nowhere in SQL — `workflow_runs` records that a turn used 2,335 input tokens
 * but not one word of what they were.
 */
export async function listModelCalls(sessionId: string): Promise<ModelCall[]> {
  const { nodes, byId } = await loadSpanIndex(sessionId);
  return nodes
    // The exporter names its spans "chat <model>" / "execute_tool <tool>", so
    // these are prefix matches, not equality. Matching exactly finds nothing and
    // looks exactly like "no traces were ingested".
    .filter((span) => span.name === "ai.streamText.doStream" || span.name.startsWith("chat "))
    .map((span) => {
      const a = span.attributes;
      return {
        spanId: span.spanId,
        turnId: span.turnId,
        stepIndex:
          num(ancestorAttribute(span, byId, "agent.step.index")) ??
          num(a["ai.settings.context.eve.step.index"]),
        model: str(a["gen_ai.request.model"]) ?? str(ancestorAttribute(span, byId, "agent.model.id")),
        provider: str(a["gen_ai.provider.name"]),
        // Two vocabularies again, for the same reason as the id columns in
        // sql/traces.sql: `ai.prompt.*` comes from eve's local tracer, which
        // never runs once the project authors instrumentation, and `gen_ai.*`
        // comes from the AI SDK exporter, which is what an external collector
        // actually receives. Reading only the first left every exported trace
        // looking like it carried no prompts at all.
        systemPrompt: str(a["ai.prompt.system"]) ?? str(a["gen_ai.system_instructions"]),
        promptMessages: str(a["ai.prompt.messages"]) ?? str(a["gen_ai.input.messages"]),
        responseText: str(a["ai.response.text"]) ?? str(a["gen_ai.output.messages"]),
        responseToolCalls: str(a["ai.response.tool_calls"]),
        finishReason:
          str(a["ai.response.finish_reason"]) ?? str(a["gen_ai.response.finish_reasons"]),
        inputTokens: num(a["agent.usage.input_tokens"]) ?? num(a["gen_ai.usage.input_tokens"]),
        outputTokens: num(a["agent.usage.output_tokens"]) ?? num(a["gen_ai.usage.output_tokens"]),
        cacheReadTokens: num(a["gen_ai.usage.cache_read.input_tokens"]),
        startTime: span.startTime,
        durationMs: span.durationMs,
      };
    });
}

/**
 * Tool invocations with their arguments and results.
 *
 * eve wraps each one in an `agent.action` span that knows the step and the
 * tool name; the AI SDK's `ai.toolCall` child underneath it holds the actual
 * payloads. Neither alone is a complete record, so the parent fills the gaps.
 *
 * `execute_tool` is the same call seen through the exporter rather than the
 * local tracer — it carries the `gen_ai.tool.*` payloads directly, with no
 * `agent.action` parent to inherit from.
 */
export async function listToolCalls(sessionId: string): Promise<ToolCall[]> {
  const { nodes, byId } = await loadSpanIndex(sessionId);

  return nodes
    .filter((node) => node.name === "ai.toolCall" || node.name.startsWith("execute_tool "))
    .map((node) => {
      const a = node.attributes;
      return {
        spanId: node.spanId,
        turnId: node.turnId,
        stepIndex:
          num(ancestorAttribute(node, byId, "agent.step.index")) ??
          num(a["ai.settings.context.eve.step.index"]),
        name: str(a["gen_ai.tool.name"]) ?? str(ancestorAttribute(node, byId, "agent.action.name")),
        callId:
          str(a["gen_ai.tool.call.id"]) ?? str(ancestorAttribute(node, byId, "agent.action.call_id")),
        argumentsJson: str(a["gen_ai.tool.call.arguments"]),
        resultJson: str(a["gen_ai.tool.call.result"]),
        startTime: node.startTime,
        durationMs: node.durationMs,
        statusCode: node.statusCode,
      };
    });
}

/**
 * The two span families a reader came for, named in both vocabularies.
 *
 * These predicates run in Postgres rather than in JS because their callers
 * count across the whole table; pulling every row into Node to measure the
 * length of two arrays is not a query plan. `starts_with` rather than LIKE:
 * `_` is a LIKE wildcard, so `'execute_tool %'` would also match
 * `'executeXtool '`.
 *
 * These have to stay in step with the JS filters in listModelCalls and
 * listToolCalls. A span name recognised in one place and not the other shows up
 * as a page that says "3 tool calls" above a list of two.
 */
const MODEL_CALL_PREDICATE = `(name = 'ai.streamText.doStream' OR starts_with(name, 'chat '))`;
const TOOL_CALL_PREDICATE = `(name = 'ai.toolCall' OR starts_with(name, 'execute_tool '))`;

/** One row per session that has spans, for the trace index. */
export interface TracedSession {
  sessionId: string;
  /** Distinct traces the session's spans belong to. */
  traces: number;
  spans: number;
  modelCalls: number;
  toolCalls: number;
  /** `service.name` off the OTLP resource — which agent exported these. */
  service: string | null;
  firstStart: string;
  lastStart: string;
}

/**
 * Sessions that have spans, newest activity first.
 *
 * One grouped scan over `resolved_session_id`, which is what that column is
 * for. Grouping by the *declared* `session_id` reports zero model calls and zero
 * tool calls on every exported trace, because the `chat …` and `execute_tool …`
 * spans declare no ids — the failure sql/traces.sql documents at length. The
 * previous shape (find the session's traces, then count those traces entire)
 * got the same answer by self-joining the table to itself; it also counted every
 * span that merely shared a trace, which for an engine-noise trace is not a
 * count of anything.
 */
export async function listTracedSessions(limit = 200): Promise<TracedSession[]> {
  await ensureTraceSchema();
  const rows = await query<Record<string, unknown>>(
    `SELECT resolved_session_id                                 AS session_id,
            COUNT(DISTINCT trace_id)                            AS traces,
            COUNT(*)                                            AS spans,
            COUNT(*) FILTER (WHERE ${MODEL_CALL_PREDICATE})     AS model_calls,
            COUNT(*) FILTER (WHERE ${TOOL_CALL_PREDICATE})      AS tool_calls,
            MAX(resource ->> 'service.name')                    AS service,
            MIN(start_time)                                     AS first_start,
            MAX(start_time)                                     AS last_start
     FROM evestack.spans
     WHERE resolved_session_id IS NOT NULL
     GROUP BY resolved_session_id
     ORDER BY MAX(start_unix_nano) DESC
     LIMIT $1`,
    [limit],
  );
  return rows.map((row) => ({
    sessionId: String(row.session_id),
    traces: Number(row.traces ?? 0),
    spans: Number(row.spans ?? 0),
    modelCalls: Number(row.model_calls ?? 0),
    toolCalls: Number(row.tool_calls ?? 0),
    service: (row.service as string) ?? null,
    firstStart: new Date(row.first_start as string).toISOString(),
    lastStart: new Date(row.last_start as string).toISOString(),
  }));
}

export interface TraceOverview {
  spans: number;
  traces: number;
  sessions: number;
  modelCalls: number;
  toolCalls: number;
  /**
   * Spans that belong to no session even after the ancestor walk. Never zero in
   * practice — workflow plumbing and fetch spans carry no agent identity, and
   * they are their own root, so there is nothing above them to inherit from —
   * but *every* span landing here while `sessions` stays 0 is the signature of
   * ids the schema does not recognise, which looks identical to "nothing was
   * ingested" unless the number is shown.
   */
  unattributedSpans: number;
  lastReceivedAt: string | null;
}

/**
 * Table-wide counts for the trace index.
 *
 * Counts `execute_tool <name>` / `chat <model>` as well as the local tracer's
 * `ai.toolCall` / `ai.streamText.doStream`: a deployment that exports — the only
 * kind that can reach this dashboard at all — sends the first pair, so matching
 * only the second reads 0 on a table full of tool calls. See the note in
 * docs/observability.mdx on the two vocabularies.
 *
 * `sessions` and `unattributed_spans` read the resolved column. Over the
 * declared one they would answer a different question — "how many spans said so
 * themselves" — and answer it as 0.1%.
 */
export async function getTraceOverview(): Promise<TraceOverview> {
  await ensureTraceSchema();
  const [row] = await query<Record<string, unknown>>(
    `SELECT COUNT(*)                                            AS spans,
            COUNT(DISTINCT trace_id)                            AS traces,
            COUNT(DISTINCT resolved_session_id)                 AS sessions,
            COUNT(*) FILTER (WHERE ${MODEL_CALL_PREDICATE})     AS model_calls,
            COUNT(*) FILTER (WHERE ${TOOL_CALL_PREDICATE})      AS tool_calls,
            COUNT(*) FILTER (WHERE resolved_session_id IS NULL) AS unattributed_spans,
            MAX(received_at)                                    AS last_received_at
     FROM evestack.spans`,
  );
  return {
    spans: Number(row?.spans ?? 0),
    traces: Number(row?.traces ?? 0),
    sessions: Number(row?.sessions ?? 0),
    modelCalls: Number(row?.model_calls ?? 0),
    toolCalls: Number(row?.tool_calls ?? 0),
    unattributedSpans: Number(row?.unattributed_spans ?? 0),
    lastReceivedAt: row?.last_received_at
      ? new Date(row.last_received_at as string).toISOString()
      : null,
  };
}

// getTraceStats() used to sit here, counting `name = 'ai.toolCall'` and
// `name = 'ai.streamText.doStream'` exactly — the local tracer's names, which by
// construction never reach a deployment that exports. It reported 0 model calls
// and 0 tool calls on a table full of both. getTraceOverview() is the same
// query, correct; there was never a reason to keep two.
