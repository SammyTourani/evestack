import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cache } from "react";
import { query } from "./db";
import {
  MODEL_CALL_SPANS,
  TOOL_CALL_SPANS,
  matchesSpanFamily,
  sqlSpanFamily,
  type SpanFamily,
} from "./span-families";

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
  /**
   * What this span DECLARED, inherited from its nearest declaring ancestor by
   * buildSpanTree. On an exporting install that is `turn_0` — an ordinal, not a
   * run id, and the same string on every turn of every session. Fine for
   * grouping spans within one trace; never join it to `workflow_runs`.
   */
  turnId: string | null;
  /**
   * The workflow run this span executed inside, materialized by
   * `evestack.resolve_span_ancestry()`. This is the value that joins to
   * `workflow_runs.id`, `fact_turn.run_id` and the session page's turn card.
   * NULL when the walk could not attribute the span at all.
   */
  resolvedTurnId: string | null;
}

/** A span plus the ids and depth it only has by virtue of its ancestors. */
export interface SpanNode extends SpanRow {
  depth: number;
  children: SpanNode[];
}

export interface ModelCall {
  spanId: string;
  /** The turn's workflow run id, which is the key the session page groups by. */
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
  /** The turn's workflow run id, which is the key the session page groups by. */
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

/**
 * The widest nanosecond timestamp this schema can actually hold.
 *
 * `start_unix_nano` and `end_unix_nano` are `bigint` (sql/traces.sql), so 2^63-1
 * is the hard ceiling: a 20-digit value already overflows it and Postgres
 * answers "value ... is out of range for type bigint". Date is the other
 * consumer and it is the looser of the two — its own ceiling is 8.64e15 ms,
 * which is 8.64e21 nanoseconds, three orders of magnitude further out — so this
 * one number bounds both and there is no second constant to keep in step.
 *
 * As a wall clock it is the year 2262. Nothing legitimate is past it; what
 * arrives past it is a clock scaled twice, `Date.now() * 1e12`.
 */
export const MAX_UNIX_NANO = 9223372036854775807n;

/**
 * A nanosecond timestamp on its way in: the digits to store, or the reason
 * there are none.
 *
 * Three outcomes rather than two, because "absent" and "present but unusable"
 * mean opposite things to the caller. An absent end time is a span still
 * running and must be kept. An end time of 10^24 is a broken clock and has to
 * be *reported*, and the cost of not telling those apart was a permanent retry
 * loop: an unbounded value reached isoFromUnixNano, `new Date(…).toISOString()`
 * threw `RangeError: Invalid time value` from inside insertSpans, and route.ts
 * cannot tell that from a dead Postgres — so it answered 503 with Retry-After,
 * the exporter resent the identical batch forever, and the message blamed the
 * database. One span with a double-scaled clock stalled every batch behind it.
 */
interface NanoField {
  /** The value to store, or null when the field was absent or unusable. */
  digits: string | null;
  /** Why there are no digits despite a value arriving. Null when merely absent. */
  problem: string | null;
}

const ABSENT_NANO: NanoField = { digits: null, problem: null };

function unixNano(raw: unknown): NanoField {
  if (raw === null || raw === undefined) return ABSENT_NANO;
  // BigInt() throws on NaN and Infinity, and everything here is stranger-shaped
  // JSON: a throw would 500 the whole batch instead of rejecting one span.
  if (typeof raw === "number" && !Number.isFinite(raw)) {
    return { digits: null, problem: `not a finite number: ${String(raw)}` };
  }
  const text = typeof raw === "number" ? BigInt(Math.trunc(raw)).toString() : String(raw);
  // OTLP writes an unset timestamp as 0, which is not a span that started in 1970.
  if (text === "" || text === "0") return ABSENT_NANO;
  if (!/^\d+$/.test(text)) {
    return { digits: null, problem: `not a whole number of nanoseconds: ${clip(text)}` };
  }
  if (BigInt(text) > MAX_UNIX_NANO) {
    return {
      digits: null,
      problem:
        `${clip(text)} is past the ${MAX_UNIX_NANO} ns bigint ceiling (about the year 2262)`,
    };
  }
  return { digits: text, problem: null };
}

/** Enough of a bad value to recognise it, without pasting it whole into a response. */
function clip(text: string): string {
  return text.length > 32 ? `${text.slice(0, 32)}…` : text;
}

function parseEvents(raw: unknown): SpanEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const event = entry as Record<string, unknown>;
    return [
      {
        name: String(event.name ?? ""),
        // An unusable event timestamp becomes null, which is already how an
        // unset one is represented. No rejection: `events` is a jsonb column,
        // never a bigint, so there is nothing here to overflow.
        timeUnixNano: unixNano(event.timeUnixNano).digits,
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
        const end = unixNano(span.endTimeUnixNano);
        const startNano = start.digits;

        // An end time that cannot be stored is a rejection, not a null. An
        // ABSENT end is a span still running and stays — but a value that
        // arrived and does not fit lands in the same bigint column the start
        // time does, and nulling it would hide a broken clock behind a span
        // that renders as "open" forever. Rejecting it tells the exporter to
        // stop resending, which is the whole point of the partial-success path.
        if (!traceId || !spanId || !startNano || end.problem) {
          rejected += 1;
          if (errors.length < 5) {
            errors.push(
              `span ${name || "<unnamed>"}: ` +
                (!traceId
                  ? "bad traceId"
                  : !spanId
                    ? "bad spanId"
                    : !startNano
                      ? `bad startTimeUnixNano${start.problem ? ` — ${start.problem}` : ""}`
                      : `bad endTimeUnixNano — ${end.problem}`),
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
          startUnixNano: startNano,
          endUnixNano: end.digits,
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

/**
 * The version an evestack schema file installs, read out of the file's own
 * downgrade guard.
 *
 * NOT restated in TypeScript, and that is the point. The number already exists
 * twice inside each SQL file — once in the guard at the top, once in the
 * migration it protects — because a plpgsql block cannot export a constant and
 * the two run hundreds of lines apart. test/schema-guard.test.mjs pins those
 * two to each other. A third copy over here would be a third thing to forget
 * on the next bump, and the only one no test could catch by reading the file.
 */
export function parseSchemaTarget(sql: string, what: string): number {
  const found = /target\s+constant\s+integer\s*:=\s*(\d+)/.exec(sql);
  if (!found) {
    throw new Error(
      `${what} declares no target constant, so this build cannot say which schema version ` +
        "it installs. The downgrade guard at the top of the file is where it is declared.",
    );
  }
  return Number(found[1]);
}

/** The `spans` schema version this build installs. See parseSchemaTarget. */
export function traceSchemaTarget(): number {
  return parseSchemaTarget(readSchemaSql(), "sql/traces.sql");
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

async function pruneSpans(days: number): Promise<number> {
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
 *
 * The guard here used to be `Number.isFinite(millis)`, which could never fire:
 * `Number()` of a BigInt stays finite however large the BigInt is, so a
 * 22-digit nanosecond value walked straight into `new Date(…).toISOString()`
 * and threw `RangeError: Invalid time value`. parseOtlpTraces now bounds every
 * ingested timestamp at MAX_UNIX_NANO, so this is an assertion about
 * hand-assembled spans rather than a filter on the ingest path — and it names
 * the bound it enforces instead of leaving the caller to read "Invalid time
 * value" and go looking at Postgres.
 */
function isoFromUnixNano(nano: string | null): string | null {
  if (!nano) return null;
  const value = BigInt(nano);
  if (value < 0n || value > MAX_UNIX_NANO) {
    throw new RangeError(
      `${nano} ns is outside the storable range 0..${MAX_UNIX_NANO}. ` +
        "Spans from parseOtlpTraces are bounded already, so this one was built by hand.",
    );
  }
  const micros = value / 1000n;
  const millis = Number(micros / 1000n);
  const remainder = Number(micros % 1000n);
  return `${new Date(millis).toISOString().slice(0, -1)}${String(remainder).padStart(3, "0")}Z`;
}

// --- Reads -------------------------------------------------------------------

const SELECT_SPAN = `
  SELECT trace_id, span_id, parent_span_id, name, kind,
         start_time, end_time, duration_ms, status_code, status_message,
         attributes, resource, events, scope_name,
         session_id, root_session_id, turn_id, resolved_turn_id
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
    resolvedTurnId: (raw.resolved_turn_id as string) ?? null,
  };
}

/**
 * The run a call belongs to, for anything that has to line up with the run tree.
 *
 * `resolvedTurnId` first because it is the only one of the two that names a
 * workflow run: `turnId` is `turn_0` on every exported span, which joins to
 * nothing and made /sessions/[id] report a session with a tool call and a
 * transcript as having neither. The declared value is still the fallback, for
 * the two cases the resolver leaves alone — a span whose parent never arrived,
 * and a trace with no enclosing `workflow.run.id` — where an id that at least
 * groups the session's own spans beats null.
 */
function callTurnId(span: SpanRow): string | null {
  return span.resolvedTurnId ?? span.turnId;
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
 * `limit` is a RENDER BUDGET, not a correctness bound. `attributes` on an
 * `ai.streamText.doStream` span holds a whole message history (eve caps each
 * value at 32 KB), so an unbounded read of a pathological session would pull
 * tens of megabytes of prompt JSON into one server render. The tail is cut, and
 * the cut is now stated rather than swallowed: logged here, and unable to reach
 * a count from anywhere. The model and tool call lists come from listCallSpans
 * now, which has no window at all — which is what finally makes the detail
 * page's own "the cut is on the timeline only" a true sentence. It was not
 * before: a tool call past span 5,000 vanished from a page promising it was
 * still listed below.
 *
 * Wrapped in React's `cache` because /traces/[id] asks for the same session
 * three times in one render — the tree, the model calls and the tool calls — and
 * used to issue this query three times for it. `cache` is per-request and, with
 * no request in scope (the ingest route, a test), calls straight through.
 */
export const listSpansBySession = cache(
  async (sessionId: string, limit = 5000): Promise<SpanRow[]> => {
    await ensureTraceSchema();
    // limit + 1 to tell a full window from a truncated one, which is cheaper than
    // a second COUNT(*) over every span in the session's traces.
    const rows = await query<Record<string, unknown>>(
      `${SELECT_SPAN}
     WHERE trace_id IN (
       SELECT DISTINCT trace_id FROM evestack.spans
       WHERE session_id = $1 OR root_session_id = $1
     )
     ORDER BY start_unix_nano, span_id
     LIMIT $2`,
      [sessionId, limit + 1],
    );
    if (rows.length > limit) {
      console.warn(
        `[evestack] session ${sessionId} has more than ${limit} spans; the span tree shows ` +
          "the earliest of them. Model and tool call lists are read in full, separately.",
      );
    }
    return rows.slice(0, limit).map(toSpanRow);
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
/**
 * How many spans the session really has.
 *
 * listSpansBySession caps its window, and the detail page used to report
 * `rows.length` from that capped window as the session's span count — so a
 * 12,000-span session read "5,000 spans", and its "N further spans are not
 * drawn" note subtracted the render cap from the query cap and under-reported by
 * the difference. Both numbers looked authoritative and neither was.
 *
 * A COUNT(*) rather than a flag, because the page needs the total to SHOW, not
 * just to know it was truncated. Same predicate as listSpansBySession so the two
 * can never disagree about which spans belong to the session.
 */
export async function countSpansBySession(sessionId: string): Promise<number> {
  await ensureTraceSchema();
  const rows = await query<{ total: string }>(
    `SELECT COUNT(*)::text AS total FROM evestack.spans
      WHERE trace_id IN (
        SELECT DISTINCT trace_id FROM evestack.spans
        WHERE session_id = $1 OR root_session_id = $1
      )`,
    [sessionId],
  );
  // COUNT() is bigint, which pg hands back as a string.
  return Number(rows[0]?.total ?? 0);
}

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

/**
 * The two span families, re-exported. The table lives in ./span-families, which
 * imports nothing, so the trace pages' pure formatter can share it — see that
 * file's header. Re-exported here because every existing caller and test
 * reaches for these names on this module.
 */
export { MODEL_CALL_SPANS, TOOL_CALL_SPANS, matchesSpanFamily, sqlSpanFamily } from "./span-families";
export type { SpanFamily } from "./span-families";

const MODEL_CALL_PREDICATE = sqlSpanFamily(MODEL_CALL_SPANS);
const TOOL_CALL_PREDICATE = sqlSpanFamily(TOOL_CALL_SPANS);

export interface CallIndex {
  /** The call spans themselves, complete — the list a page renders and counts. */
  calls: SpanNode[];
  /** Every span in the chain, for walking up to an ancestor's attributes. */
  byId: ReadonlyMap<string, SpanNode>;
}

/**
 * The call spans out of a set of rows, with the ids they only have by virtue of
 * their ancestors filled in.
 *
 * Split out of loadCallIndex, and exported, because this is where the invariant
 * lives and it needs no database to check: `calls.length` is exactly the number
 * of rows matching the family, which is the number `COUNT(*) FILTER` returns
 * over those same rows. The detail page prints `toolCalls.length` above the list
 * it renders from `toolCalls`, so the count and the list are the same array by
 * construction — there is no second traversal to fall out of step.
 */
export function selectCallSpans(family: SpanFamily, rows: readonly SpanRow[]): CallIndex {
  const byId = new Map(flatten(buildSpanTree(rows)).map((node) => [node.spanId, node]));
  // Selected from the rows rather than from the tree: buildSpanTree drops any
  // span caught in a cyclic parent chain, because a cycle has no root, and a
  // call the SQL counted still has to appear in the list. The bare-row fallback
  // gives up only the inherited ids, which are the ones a cycle made unknowable.
  const calls = rows
    .filter((row) => matchesSpanFamily(family, row.name))
    .map((row) => byId.get(row.spanId) ?? { ...row, depth: 0, children: [] });
  return { calls, byId };
}

/**
 * Every span in the session belonging to one call family, plus the ancestors
 * those spans inherit their ids from — and nothing else.
 *
 * This exists because listSpansBySession is a DISPLAY window. It takes the
 * first `limit` spans in start order so the waterfall stays renderable, and
 * aggregating over that window truncated the TAIL: a 12,000-span session listed
 * the tool calls found in its first 5,000 spans, while /traces counted all of
 * them with COUNT(*) FILTER over the same traces. The two pages disagreed, the
 * detail page was the wrong one, and nothing on it said a cut had happened.
 *
 * Selecting the calls themselves is bounded by how many calls the session made
 * rather than by how many spans it produced, so the list is complete and its
 * length is the same number the index shows — no second COUNT(*) to keep in
 * step, and no count that can drift from the list printed beneath it.
 *
 * The recursive half walks parents because an `ai.toolCall` carries none of
 * eve's ids: its step index, tool name and call id live on the `agent.action`
 * and `agent.step` spans above it (see ancestorAttribute). UNION rather than
 * UNION ALL, which both collapses ancestors shared by sibling calls and
 * terminates if a parent chain is ever cyclic — nothing upstream promises it is
 * not, and this runs while rendering a page.
 */
async function listCallSpans(sessionId: string, family: SpanFamily): Promise<SpanRow[]> {
  await ensureTraceSchema();
  const rows = await query<Record<string, unknown>>(
    `WITH RECURSIVE owned AS (
       SELECT DISTINCT trace_id FROM evestack.spans
       WHERE session_id = $1 OR root_session_id = $1
     ),
     chain AS (
       SELECT c.trace_id, c.span_id, c.parent_span_id
       FROM evestack.spans c
       JOIN owned ON owned.trace_id = c.trace_id
       WHERE ${sqlSpanFamily(family)}
       UNION
       SELECT p.trace_id, p.span_id, p.parent_span_id
       FROM chain
       JOIN evestack.spans p
         ON p.trace_id = chain.trace_id AND p.span_id = chain.parent_span_id
     )
     ${SELECT_SPAN}
     WHERE (trace_id, span_id) IN (SELECT trace_id, span_id FROM chain)
     ORDER BY start_unix_nano, span_id`,
    [sessionId],
  );
  return rows.map(toSpanRow);
}

async function loadCallIndex(sessionId: string, family: SpanFamily): Promise<CallIndex> {
  return selectCallSpans(family, await listCallSpans(sessionId, family));
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
  const { calls, byId } = await loadCallIndex(sessionId, MODEL_CALL_SPANS);
  return calls
    .map((span) => {
      const a = span.attributes;
      return {
        spanId: span.spanId,
        turnId: callTurnId(span),
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
  const { calls, byId } = await loadCallIndex(sessionId, TOOL_CALL_SPANS);

  return calls
    .map((node) => {
      const a = node.attributes;
      return {
        spanId: node.spanId,
        turnId: callTurnId(node),
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
 * Table-wide counts: the trace index reads them, and so does the ingest
 * endpoint's GET.
 *
 * Counts `execute_tool <name>` / `chat <model>` as well as the local tracer's
 * `ai.toolCall` / `ai.streamText.doStream`: a deployment that exports — the only
 * kind that can reach this dashboard at all — sends the first pair, so matching
 * only the second reads 0 on a table full of tool calls. See the note in
 * docs/observability.mdx on the two vocabularies.
 *
 * There used to be a near-identical getTraceStats() below this one, and the
 * ingest endpoint called that. It matched the two span names exactly, which is
 * the local tracer's vocabulary and not the exported one, so it reported zero
 * model and tool calls to the single caller whose whole question was whether
 * anything had arrived. One function now, over the families above, because two
 * spellings of the same query is how the wrong spelling keeps a caller.
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
