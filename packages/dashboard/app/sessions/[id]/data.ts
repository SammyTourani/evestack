import type { Outcome } from "@/components/ui/badge";
import { query } from "@/lib/db";
import { refreshFacts } from "@/lib/facts";
import type { TurnRow } from "@/lib/queries";

/**
 * What the session page reads, and the two pure shapes it draws.
 *
 * The numbers come out of `evestack.fact_turn` and `evestack.fact_tool_call`
 * rather than being re-derived from `workflow_runs` here. That is not a
 * preference: `outcome`, `ttft_ms`, `retry_count`, `tools_called` and the
 * five-way cost split only exist because W2 materialized them, and a second
 * derivation on this page is how the session detail and the monitors page end
 * up disagreeing about whether a turn failed.
 *
 * The run TREE still comes from `getSessionTree()`. `fact_turn` carries
 * `session_id` but not `$eve.parent`, so it cannot say which turn a subagent
 * hangs off. One source for the shape, one for the numbers, joined by run id.
 */

/* -------------------------------------------------------------------------- */
/* fact_turn                                                                  */
/* -------------------------------------------------------------------------- */

export type SpanCoverage = "none" | "partial" | "full";

/** One `evestack.fact_turn` row, in the units the page renders. */
export interface TurnFact {
  readonly runId: string;
  readonly model: string | null;
  readonly provider: string | null;
  readonly environment: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly durationMs: number | null;
  readonly ttftMs: number | null;
  readonly timePerOutputChunkMs: number | null;
  readonly outputTokensPerSecond: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  /** `null` when the turn never reached a model — neither priced nor unpriced. */
  readonly priced: boolean | null;
  readonly costInputUsd: number | null;
  readonly costOutputUsd: number | null;
  readonly costCacheReadUsd: number | null;
  readonly costCacheWriteUsd: number | null;
  readonly costUsd: number | null;
  readonly stepCount: number | null;
  /** Attempts past the first, summed over the turn's steps. */
  readonly retryCount: number | null;
  /** Size of the tool registry the model was handed. Capacity, not activity. */
  readonly toolsOffered: number | null;
  /** Counted from spans, so `null` — not 0 — when none landed. */
  readonly toolsCalled: number | null;
  readonly finishReason: string | null;
  readonly errorCode: string | null;
  readonly error: string | null;
  readonly outcome: Outcome;
  readonly spanCoverage: SpanCoverage;
}

/**
 * `numeric` and `bigint` both arrive from node-pg as strings, because neither
 * fits a JS number in general. Every one of them on a fact row does — token
 * counts and sub-cent costs — so they are converted once here rather than at
 * each of the twenty call sites that would otherwise do arithmetic on `"4411"`.
 *
 * Absent stays absent. `cost_usd` is NULL on an unpriced turn on purpose, and
 * turning that into 0 here would undo the one thing the column exists for.
 */
const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const iso = (value: unknown): string | null =>
  value ? new Date(value as string).toISOString() : null;

/**
 * Every fact row under one session, turns and subagents alike.
 *
 * `refreshFacts()` first, and awaited. It is the only exported entry point that
 * applies `sql/facts.sql`, so without it this SELECT is a 42P01 on any database
 * that has never served a metrics query — which is every fresh install. It is
 * also what keeps a turn that finished five seconds ago from being missing from
 * its own session page. The cost is one incremental upsert from the watermark
 * (~70ms on the seeded month, where the bulk load gave every span the same
 * `received_at` and so re-examines all 370 spanned turns; a live install
 * advances that watermark and examines the handful that moved).
 */
export async function listTurnFacts(sessionId: string): Promise<Map<string, TurnFact>> {
  await refreshFacts();
  const rows = await query<Record<string, unknown>>(
    `SELECT run_id, model, provider, environment,
            started_at, completed_at, duration_ms,
            ttft_ms, time_per_output_chunk_ms, output_tokens_per_second,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
            priced, cost_input_usd, cost_output_usd, cost_cache_read_usd,
            cost_cache_write_usd, cost_usd,
            step_count, retry_count, tools_offered, tools_called,
            finish_reason, error_code, error, outcome, span_coverage
       FROM evestack.fact_turn
      WHERE session_id = $1`,
    [sessionId],
  );

  return new Map(
    rows.map((row) => [
      String(row.run_id),
      {
        runId: String(row.run_id),
        model: text(row.model),
        provider: text(row.provider),
        environment: text(row.environment),
        startedAt: iso(row.started_at),
        completedAt: iso(row.completed_at),
        durationMs: num(row.duration_ms),
        ttftMs: num(row.ttft_ms),
        timePerOutputChunkMs: num(row.time_per_output_chunk_ms),
        outputTokensPerSecond: num(row.output_tokens_per_second),
        inputTokens: num(row.input_tokens),
        outputTokens: num(row.output_tokens),
        cacheReadTokens: num(row.cache_read_tokens),
        cacheWriteTokens: num(row.cache_write_tokens),
        priced: row.priced === null || row.priced === undefined ? null : Boolean(row.priced),
        costInputUsd: num(row.cost_input_usd),
        costOutputUsd: num(row.cost_output_usd),
        costCacheReadUsd: num(row.cost_cache_read_usd),
        costCacheWriteUsd: num(row.cost_cache_write_usd),
        costUsd: num(row.cost_usd),
        stepCount: num(row.step_count),
        retryCount: num(row.retry_count),
        toolsOffered: num(row.tools_offered),
        toolsCalled: num(row.tools_called),
        finishReason: text(row.finish_reason),
        errorCode: text(row.error_code),
        error: text(row.error),
        // Both columns carry a CHECK constraint listing exactly these values,
        // and `test/ui-primitives.test.mjs` re-reads that constraint out of
        // sql/facts.sql to prove `OUTCOMES` still matches it. A runtime
        // fallback here would be a branch the database cannot reach.
        outcome: String(row.outcome) as Outcome,
        spanCoverage: String(row.span_coverage) as SpanCoverage,
      },
    ]),
  );
}

/* -------------------------------------------------------------------------- */
/* workflow_steps                                                             */
/* -------------------------------------------------------------------------- */

export interface StepRow {
  readonly runId: string;
  readonly stepId: string;
  /** `turnStep`, not `step//eve@0.30.8//turnStep`. */
  readonly name: string;
  readonly status: string;
  /** 1-based. Anything above 1 is the engine having retried this step. */
  readonly attempt: number;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly durationMs: number | null;
  readonly error: string | null;
}

/**
 * `step//eve@0.30.8//turnStep` → `turnStep`.
 *
 * The version is in the middle of the id, so a step name changes string every
 * time eve is upgraded. Keeping the tail means the waterfall does not rename
 * every row on a patch bump, and the full id stays in the row's `title`.
 */
export function stepLabel(name: string): string {
  const cut = name.lastIndexOf("//");
  return cut === -1 ? name : name.slice(cut + 2) || name;
}

/**
 * The engine's own record of what ran, including every retry.
 *
 * `workflow.workflow_steps` has never been read by this dashboard, and it is
 * the half of the waterfall that survives having no traces at all: ~80% of
 * turns on a realistic month export no spans, and those turns still have steps.
 *
 * Two shapes of retry exist and both have to work. world-postgres bumps
 * `attempt` on the existing row; a fixture writes one row per attempt. Rows are
 * returned as they are, so a page grouping by `step_name` sees one row with
 * `attempt = 5` in the first shape and five rows in the second — which is why
 * `fact_turn.retry_count` (max(attempt) per name, summed) is the number quoted
 * anywhere a count is stated, and this list is only ever drawn as bars.
 */
export async function listSteps(runIds: readonly string[]): Promise<Map<string, StepRow[]>> {
  const byRun = new Map<string, StepRow[]>();
  if (runIds.length === 0) return byRun;

  const rows = await query<Record<string, unknown>>(
    `SELECT run_id, step_id, step_name, status, attempt,
            started_at, completed_at,
            EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000 AS duration_ms,
            error
       FROM workflow.workflow_steps
      WHERE run_id = ANY($1::text[])
      ORDER BY COALESCE(started_at, created_at) ASC, attempt ASC`,
    [runIds],
  );

  for (const row of rows) {
    const runId = String(row.run_id);
    const list = byRun.get(runId) ?? [];
    list.push({
      runId,
      stepId: String(row.step_id),
      name: stepLabel(String(row.step_name)),
      status: String(row.status),
      attempt: num(row.attempt) ?? 1,
      startedAt: iso(row.started_at),
      completedAt: iso(row.completed_at),
      durationMs: num(row.duration_ms),
      error: text(row.error),
    });
    byRun.set(runId, list);
  }
  return byRun;
}

/* -------------------------------------------------------------------------- */
/* fact_tool_call                                                             */
/* -------------------------------------------------------------------------- */

export interface ToolCallRow {
  readonly runId: string;
  readonly spanId: string;
  readonly name: string;
  readonly startedAt: string;
  readonly durationMs: number | null;
  readonly ok: boolean;
  readonly errorMessage: string | null;
  /** Byte length of the recorded arguments, or null when none were recorded. */
  readonly argumentsBytes: number | null;
  readonly resultBytes: number | null;
}

/**
 * Tool invocations, keyed on `run_id` rather than `session_id`.
 *
 * Both columns are on the row, and they are not equivalent: the ancestor walk
 * can resolve a tool span to its turn on a trace that never declared a session
 * id, and `session_id` is NULL on exactly those rows. Keying on the run ids the
 * tree already knows loses none of them, and `fact_tool_call_run_idx` is the
 * index that exists.
 */
export async function listToolCallFacts(
  runIds: readonly string[],
): Promise<Map<string, ToolCallRow[]>> {
  const byRun = new Map<string, ToolCallRow[]>();
  if (runIds.length === 0) return byRun;

  const rows = await query<Record<string, unknown>>(
    `SELECT run_id, span_id, tool_name, started_at, duration_ms, ok,
            error_message, arguments_bytes, result_bytes
       FROM evestack.fact_tool_call
      WHERE run_id = ANY($1::text[])
      ORDER BY started_at ASC`,
    [runIds],
  );

  for (const row of rows) {
    const runId = String(row.run_id);
    const list = byRun.get(runId) ?? [];
    list.push({
      runId,
      spanId: String(row.span_id),
      name: String(row.tool_name),
      startedAt: new Date(row.started_at as string).toISOString(),
      durationMs: num(row.duration_ms),
      ok: Boolean(row.ok),
      errorMessage: text(row.error_message),
      argumentsBytes: num(row.arguments_bytes),
      resultBytes: num(row.result_bytes),
    });
    byRun.set(runId, list);
  }
  return byRun;
}

/* -------------------------------------------------------------------------- */
/* the timeline                                                               */
/* -------------------------------------------------------------------------- */

export interface TimelineNode {
  readonly run: TurnRow;
  /** Null only in the millisecond between a run appearing and being materialized. */
  readonly fact: TurnFact | null;
  /** 1-based position among the session's top-level turns; null for subagents. */
  readonly seq: number | null;
  readonly children: TimelineNode[];
}

/**
 * The run rows as a forest, in start order, with their facts attached.
 *
 * The session row is in `rows` (the query matches `id = $1`) but it is the
 * tree, not a node in it, so it is dropped. A run whose parent is missing from
 * the result set — a subagent whose caller was pruned — hangs off the root
 * rather than disappearing.
 *
 * Attaching a node whose ancestry loops back to itself would make the render
 * below non-terminating, so the walk up is bounded by a seen-set.
 */
export function buildTimeline(
  rows: readonly TurnRow[],
  sessionId: string,
  facts: ReadonlyMap<string, TurnFact>,
): TimelineNode[] {
  const nodes = new Map<string, TimelineNode>();
  for (const run of rows) {
    if (run.id !== sessionId) {
      nodes.set(run.id, { run, fact: facts.get(run.id) ?? null, seq: null, children: [] });
    }
  }

  const parentOf = (node: TimelineNode): TimelineNode | undefined => {
    const direct = node.run.parent ? nodes.get(node.run.parent) : undefined;
    const seen = new Set<string>([node.run.id]);
    for (
      let cursor = direct;
      cursor;
      cursor = cursor.run.parent ? nodes.get(cursor.run.parent) : undefined
    ) {
      if (seen.has(cursor.run.id)) return undefined;
      seen.add(cursor.run.id);
    }
    return direct;
  };

  const roots: TimelineNode[] = [];
  for (const node of nodes.values()) {
    const parent = parentOf(node);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  // Numbered after nesting, not before: "#4" has to mean the fourth thing in
  // the timeline, and a subagent that came back as a root because its caller
  // was pruned is a turn of the session as far as the reader is concerned.
  return roots.map((node, index) => ({ ...node, seq: index + 1 }));
}

/** Depth-first, the order the timeline draws. */
export function flattenTimeline(nodes: readonly TimelineNode[]): TimelineNode[] {
  return nodes.flatMap((node) => [node, ...flattenTimeline(node.children)]);
}

/* -------------------------------------------------------------------------- */
/* the waterfall                                                              */
/* -------------------------------------------------------------------------- */

export type WaterfallKind = "step" | "model" | "tool";

export interface WaterfallRow {
  readonly key: string;
  readonly kind: WaterfallKind;
  readonly label: string;
  /** Full identifier for the row's `title`, when the label is a short form. */
  readonly title: string | null;
  /** 1-based attempt on a step row; null on a span row, which cannot retry. */
  readonly attempt: number | null;
  readonly durationMs: number | null;
  readonly failed: boolean;
  /** Error text or status, when there is something to say beyond the bar. */
  readonly detail: string | null;
  /** Percent of the turn window, or null when the row has no start time. */
  readonly offsetPct: number | null;
  readonly widthPct: number | null;
  /** The tool span this row came from, so its payloads can be found again. */
  readonly spanId: string | null;
}

/** A bar this thin is still a bar. Below it a 5ms tool call renders invisible. */
const MIN_WIDTH_PCT = 0.6;

interface Placeable {
  readonly startedAt: string | null;
  readonly durationMs: number | null;
}

/**
 * Steps, model calls and tool calls on one time axis.
 *
 * The axis is the turn's own window, widened to contain anything that fell
 * outside it. That happens for real: a tool span whose parent turn row was
 * written before the span landed, or a step still running on a turn with no
 * `completed_at`. Clamping those to the turn's bounds would draw a bar that
 * lies about when the call happened, so the window grows instead.
 *
 * A row with no start time keeps its duration text and gets no bar. `null`
 * geometry rather than a zero-width bar at the origin: "we do not know when
 * this ran" is not "this ran instantly at the start".
 */
export function buildWaterfall(
  turn: Placeable,
  steps: readonly StepRow[],
  toolCalls: readonly ToolCallRow[],
  modelCalls: readonly ModelCallInput[],
): WaterfallRow[] {
  const placed: { row: WaterfallRow; start: number | null; end: number | null }[] = [
    ...steps.map((step) => ({
      row: {
        key: `step:${step.stepId}`,
        kind: "step" as const,
        label: step.name,
        title: null,
        attempt: step.attempt,
        durationMs: step.durationMs,
        failed: step.status === "failed",
        // The engine marks every step of a failed run `failed`, so the status
        // alone says little; the error text is what separates the step that
        // actually broke from the ones unwound with it.
        detail: step.error ?? (step.status === "running" ? "still running" : null),
        offsetPct: null,
        widthPct: null,
        spanId: null,
      },
      ...bounds(step),
    })),
    ...modelCalls.map((call) => ({
      row: {
        key: `model:${call.spanId}`,
        kind: "model" as const,
        label: call.model ?? "model call",
        title: null,
        attempt: null,
        durationMs: call.durationMs,
        failed: false,
        detail: null,
        offsetPct: null,
        widthPct: null,
        spanId: call.spanId,
      },
      ...bounds({ startedAt: call.startTime, durationMs: call.durationMs }),
    })),
    ...toolCalls.map((call) => ({
      row: {
        key: `tool:${call.spanId}`,
        kind: "tool" as const,
        label: call.name,
        title: null,
        attempt: null,
        durationMs: call.durationMs,
        failed: !call.ok,
        detail: call.errorMessage,
        offsetPct: null,
        widthPct: null,
        spanId: call.spanId,
      },
      ...bounds(call),
    })),
  ];

  // Sorted before placement so the returned order is the drawn order. Rows
  // nobody can place go last rather than at an arbitrary time.
  placed.sort((a, b) => {
    if (a.start === null && b.start === null) return 0;
    if (a.start === null) return 1;
    if (b.start === null) return -1;
    return a.start - b.start;
  });

  const { start: turnStart, end: turnEnd } = bounds(turn);
  const starts = placed.map((entry) => entry.start).filter((v): v is number => v !== null);
  const ends = placed.map((entry) => entry.end).filter((v): v is number => v !== null);
  if (turnStart !== null) starts.push(turnStart);
  if (turnEnd !== null) ends.push(turnEnd);
  if (starts.length === 0 || ends.length === 0) return placed.map((entry) => entry.row);

  const windowStart = Math.min(...starts);
  const span = Math.max(...ends) - windowStart;
  if (span <= 0) return placed.map((entry) => entry.row);

  return placed.map(({ row, start }) => {
    if (start === null) return row;
    const offsetPct = clamp(((start - windowStart) / span) * 100);
    const width = (Math.max(0, row.durationMs ?? 0) / span) * 100;
    return {
      ...row,
      offsetPct,
      widthPct: Math.min(100 - offsetPct, Math.max(MIN_WIDTH_PCT, width)),
    };
  });
}

/** What `listModelCalls()` gives that the waterfall needs. */
export interface ModelCallInput {
  readonly spanId: string;
  readonly model: string | null;
  readonly startTime: string;
  readonly durationMs: number | null;
}

function bounds(row: Placeable): { start: number | null; end: number | null } {
  const start = row.startedAt ? new Date(row.startedAt).getTime() : NaN;
  if (!Number.isFinite(start)) return { start: null, end: null };
  return { start, end: start + Math.max(0, row.durationMs ?? 0) };
}

const clamp = (pct: number): number => Math.min(100, Math.max(0, pct));
