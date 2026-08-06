import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  errors: string[];
}

/**
 * Turn an OTLP/HTTP JSON ExportTraceServiceRequest into insertable rows.
 *
 * A malformed envelope throws — the exporter needs a 400 so it drops the batch.
 * A single unreadable span does not: it is counted and the rest are kept, which
 * is what OTLP's partial-success response exists to express.
 */
export function parseOtlpTraces(payload: unknown): ParsedOtlp {
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
        const traceId = normalizeId(span.traceId, 16);
        const spanId = normalizeId(span.spanId, 8);
        const start = unixNano(span.startTimeUnixNano);

        if (!traceId || !spanId || !start) {
          rejected += 1;
          if (errors.length < 5) {
            errors.push(
              `span ${String(span.name ?? "<unnamed>")}: ` +
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
          name: String(span.name ?? ""),
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

  return { spans, rejected, errors };
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
  return written;
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
 */
export async function listSpansBySession(sessionId: string, limit = 5000): Promise<SpanRow[]> {
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
}

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
 * The CTE mirrors listSpansBySession: resolve the session to its trace ids
 * first, then count over those traces entire. Counting only the spans that
 * carry a session id would report zero tool calls for a local-tracer trace,
 * where the `ai.toolCall` span holding the payload carries none of eve's ids —
 * which is the exact failure the id columns in sql/traces.sql document.
 */
export async function listTracedSessions(limit = 200): Promise<TracedSession[]> {
  await ensureTraceSchema();
  const rows = await query<Record<string, unknown>>(
    `WITH owned AS (
       SELECT DISTINCT session_id, trace_id
       FROM evestack.spans
       WHERE session_id IS NOT NULL
     )
     SELECT owned.session_id,
            COUNT(DISTINCT s.trace_id)                          AS traces,
            COUNT(*)                                            AS spans,
            COUNT(*) FILTER (WHERE ${MODEL_CALL_PREDICATE})     AS model_calls,
            COUNT(*) FILTER (WHERE ${TOOL_CALL_PREDICATE})      AS tool_calls,
            MAX(s.resource ->> 'service.name')                  AS service,
            MIN(s.start_time)                                   AS first_start,
            MAX(s.start_time)                                   AS last_start
     FROM owned
     JOIN evestack.spans s ON s.trace_id = owned.trace_id
     GROUP BY owned.session_id
     ORDER BY MAX(s.start_unix_nano) DESC
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
   * Spans with no session id. Never zero in practice — workflow plumbing and
   * fetch spans carry no agent identity — but *every* span landing here while
   * `sessions` stays 0 is the signature of ids the schema does not recognise,
   * which looks identical to "nothing was ingested" unless the number is shown.
   */
  unattributedSpans: number;
  lastReceivedAt: string | null;
}

/**
 * Table-wide counts for the trace index.
 *
 * Deliberately not getTraceStats(): that one counts `name = 'ai.toolCall'` and
 * `name = 'ai.streamText.doStream'` exactly, which are the *local tracer's*
 * names. A deployment that exports — the only kind that can reach this
 * dashboard at all — sends `execute_tool <name>` and `chat <model>` instead, so
 * those two fields read 0 on a table full of tool calls. The predicates above
 * cover both. See the note in docs/observability.mdx on the two vocabularies.
 */
export async function getTraceOverview(): Promise<TraceOverview> {
  await ensureTraceSchema();
  const [row] = await query<Record<string, unknown>>(
    `SELECT COUNT(*)                                          AS spans,
            COUNT(DISTINCT trace_id)                          AS traces,
            COUNT(DISTINCT session_id)                        AS sessions,
            COUNT(*) FILTER (WHERE ${MODEL_CALL_PREDICATE})   AS model_calls,
            COUNT(*) FILTER (WHERE ${TOOL_CALL_PREDICATE})    AS tool_calls,
            COUNT(*) FILTER (WHERE session_id IS NULL)        AS unattributed_spans,
            MAX(received_at)                                  AS last_received_at
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

export interface TraceStats {
  spans: number;
  traces: number;
  sessions: number;
  toolCalls: number;
  modelCalls: number;
  lastReceivedAt: string | null;
}

export async function getTraceStats(): Promise<TraceStats> {
  await ensureTraceSchema();
  const [row] = await query<Record<string, unknown>>(
    `SELECT COUNT(*)                                              AS spans,
            COUNT(DISTINCT trace_id)                              AS traces,
            COUNT(DISTINCT session_id)                            AS sessions,
            COUNT(*) FILTER (WHERE name = 'ai.toolCall')           AS tool_calls,
            COUNT(*) FILTER (WHERE name = 'ai.streamText.doStream') AS model_calls,
            MAX(received_at)                                      AS last_received_at
     FROM evestack.spans`,
  );
  return {
    spans: Number(row?.spans ?? 0),
    traces: Number(row?.traces ?? 0),
    sessions: Number(row?.sessions ?? 0),
    toolCalls: Number(row?.tool_calls ?? 0),
    modelCalls: Number(row?.model_calls ?? 0),
    lastReceivedAt: row?.last_received_at
      ? new Date(row.last_received_at as string).toISOString()
      : null,
  };
}
