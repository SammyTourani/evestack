import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { query } from "./db";
import { costUsd } from "./pricing";
import { ensureTraceSchema } from "./traces";

/**
 * The data contract, verified against a live database on 2026-08-04.
 *
 * One user message produces three rows in workflow.workflow_runs:
 *   $eve.type = "session"  → name workflow//eve//workflowEntry, stays "running"
 *                            while the session is open
 *   $eve.type = "turn"     → name workflow//eve//turnWorkflow, carries model and
 *                            token counts, completes per turn
 *   (no $eve.type)         → name workflow//eve//sessionTimeoutWorkflow, internal
 *                            bookkeeping
 *
 * That third kind is why every query filters on `$eve.type`. Without it the
 * session list fills with timeout workflows that mean nothing to a user.
 *
 * Subagents appear as $eve.type = "subagent" with $eve.parent pointing at their
 * caller, so the same parent/root columns build the whole tree.
 */

export interface SessionRow {
  id: string;
  status: string;
  title: string | null;
  trigger: string | null;
  createdAt: string;
  completedAt: string | null;
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  models: string[];
  costUsd: number;
  /**
   * This row's keyset position, to hand back to `listSessions`. Opaque; see
   * `SessionCursor`. Carried per row rather than returned once per page so the
   * function can keep returning a plain array — and because a caller that
   * renders an infinite list already holds the last row.
   */
  cursor: string;
}

export interface TurnRow {
  id: string;
  type: string;
  parent: string | null;
  root: string | null;
  status: string;
  model: string | null;
  subagent: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * How many tools were OFFERED to the model on this turn, not how many it
   * called. eve stamps `$eve.tool_count` from the tool registry when it builds
   * the request, so it is a property of the agent's configuration and barely
   * moves between turns — every turn of a live install reads the same number.
   * The session page used to label it `TOOLS` next to duration and cost, where
   * it reads as activity. It is capacity.
   *
   * `null`, not 0, when eve wrote no `$eve.tool_count`: "we were not told" and
   * "no tools were offered" are different facts and must not render the same.
   */
  toolsOffered: number | null;
  /**
   * How many tools the model actually CALLED on this turn, counted from
   * `execute_tool *` spans.
   *
   * `null` when it cannot be derived, which is the common case and not an
   * error: the trace tier is a separate, optional, retention-bounded export. A
   * turn whose trace was never exported, or has aged out, has no evidence
   * either way, and `0` there would be a confident lie about a turn that may
   * have called ten tools. On the seeded database 371 of 1,727 turns have trace
   * coverage — the other 1,356 report null.
   *
   * `0` is only ever returned for a turn whose trace WAS found and contained no
   * `execute_tool` span. That zero is real.
   */
  toolInvocations: number | null;
  errorCode: string | null;
  costUsd: number;
  /**
   * True when a turn reached a terminal state without ever recording a model
   * call.
   *
   * This exists because eve's stream and its workflow store disagree. A turn
   * killed by a provider rate limit emits `turn.failed` on the stream, but the
   * workflow row still reads `status = 'completed'` — the workflow handled the
   * error, so as far as it is concerned nothing failed. Trusting `status` alone
   * would paint a green "completed" badge on a turn that produced nothing,
   * which is worse than showing no badge at all.
   *
   * eve writes `$eve.model` and the token tags only once a model call reports
   * usage, so their absence on a finished turn is the surviving evidence that
   * the call never landed.
   */
  noModelCall: boolean;
}

const NUM = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Like NUM, but keeps "absent" and "unparseable" distinct from zero.
 *
 * NUM exists for tokens and costs, where a missing tag genuinely means none
 * were spent. It is the wrong default for a count that was never reported:
 * there, 0 is a claim, and we do not have the evidence to make it.
 */
const NUM_OR_NULL = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// --- Indexes -----------------------------------------------------------------

let indexesReady: Promise<void> | null = null;
let indexWarned = false;

/**
 * Apply sql/query-indexes.sql, once per process. Same read-from-disk mechanism
 * as `ensureTraceSchema`, for the same reason: one definition of the DDL, in a
 * file an operator can also pipe into psql.
 *
 * It differs from `ensureTraceSchema` in one deliberate way — a failure here is
 * WARNED ABOUT AND SWALLOWED, not rethrown. `sql/traces.sql` creates a table
 * that read paths need to exist; this file only creates indexes, which change
 * no answer. A dashboard whose database role lacks CREATE on the `workflow`
 * schema — a perfectly reasonable way to run a read-only dashboard against
 * someone else's Postgres — must render a slow session list, not a 500. See the
 * header of sql/query-indexes.sql for why touching `workflow` at all is allowed.
 */
export function ensureQueryIndexes(): Promise<void> {
  if (!indexesReady) {
    // readQueryIndexSql throws synchronously; inside the chain so that a
    // missing file cannot escape past the catch below and take a page down.
    //
    // ensureTraceSchema first because the file's last statement indexes
    // evestack.spans, and the whole file is one multi-statement query — so on
    // a database that has never received a span, an unqualified run would
    // fail at that last statement and roll back the workflow_runs indexes
    // with it.
    indexesReady = ensureTraceSchema()
      .then(() => query(readQueryIndexSql()))
      .then(() => undefined)
      .catch((error: unknown) => {
        // Not cached as a success: a database that was merely unreachable at
        // boot would otherwise stay un-indexed for the life of the process.
        // The warning fires once, so a role that permanently lacks CREATE
        // does not print on every request.
        indexesReady = null;
        if (indexWarned) return;
        indexWarned = true;
        console.warn(
          "[evestack] could not apply sql/query-indexes.sql; every page will " +
            "still be correct, just slower: " +
            String(error instanceof Error ? error.message : error),
        );
      });
  }
  return indexesReady;
}

function readQueryIndexSql(): string {
  let dir = process.cwd();
  for (let up = 0; up < 5; up += 1) {
    try {
      return readFileSync(join(dir, "sql", "query-indexes.sql"), "utf8");
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error(
    `Could not find sql/query-indexes.sql above ${process.cwd()}. ` +
      "Run the dashboard from packages/dashboard, or apply the file by hand.",
  );
}

// --- Keyset pagination -------------------------------------------------------

/**
 * An opaque position in the session list: `<created_at>|<id>`.
 *
 * Opaque, and a string rather than a `{ createdAt, id }` object, for two
 * reasons that are both about not lying.
 *
 * FIRST, PRECISION. `SessionRow.createdAt` is an ISO-8601 string built by
 * `Date.prototype.toISOString`, so it holds milliseconds; `workflow_runs.created_at`
 * holds microseconds. Paging on the rounded value is not a rounding error, it
 * is silent data loss. `toISOString` TRUNCATES, and this list walks DESC
 * keeping rows strictly below the cursor, so a cursor built from
 * `…:25.559334` reads `…:25.559` — smaller than the row it came from, and
 * therefore excluding more than it should. Every session sharing that
 * millisecond and sorting below the cursor row is served on no page at all,
 * with nothing raised. So this value is `to_char(created_at, …US)`, the exact
 * stored instant, never round-tripped through a JS Date. Asserted by
 * contract/runtime/probes/06-session-keyset-and-tool-calls.probe.mjs.
 *
 * SECOND, it is a text form Postgres parses unambiguously back to the same
 * `timestamp without time zone`, with no offset anywhere in the round trip.
 * That matters because `created_at` is naive UTC (see lib/db.ts): hand pg a JS
 * `Date` for that column and it serialises with the Node process's local
 * offset, which Postgres then discards, shifting the cursor by the machine's
 * timezone. Keeping it as text the database wrote makes that impossible.
 */
export interface SessionCursor {
  /** Postgres text form of `created_at`, microseconds intact. */
  readonly createdAt: string;
  readonly id: string;
}

/** `YYYY-MM-DDTHH:MM:SS.ffffff`, exactly what the SELECT's `to_char` emits. */
const CURSOR_TIMESTAMP = /^\d{4,}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/;

export function encodeSessionCursor(cursor: SessionCursor): string {
  return `${cursor.createdAt}|${cursor.id}`;
}

/**
 * Throws on anything malformed rather than falling back to the first page.
 *
 * A cursor that silently means "start over" is the worst of the available
 * behaviours: the caller sees rows it has already rendered, appends them, and
 * the list quietly duplicates. An error is visible and fixable.
 */
export function parseSessionCursor(raw: string): SessionCursor {
  // Split on the FIRST separator: the timestamp cannot contain one, a run id
  // in principle could, and the id is the part that must survive intact.
  const cut = raw.indexOf("|");
  const createdAt = cut === -1 ? "" : raw.slice(0, cut);
  const id = cut === -1 ? "" : raw.slice(cut + 1);
  if (!CURSOR_TIMESTAMP.test(createdAt) || id === "") {
    throw new Error(`Not a session cursor: ${JSON.stringify(raw)}`);
  }
  return { createdAt, id };
}

/**
 * The cursor to pass to the next `listSessions`, or null when this was the last
 * page.
 *
 * "Last page" is inferred from a short read, which is the one place this is
 * imprecise: a result set whose length is an exact multiple of `limit` hands
 * back a cursor whose next fetch returns nothing. That costs one extra query
 * and never a wrong row, and the alternative — over-fetching one row on every
 * page to know — costs a row on every page instead. Pay it at the end.
 */
export function nextSessionCursor(rows: readonly SessionRow[], limit: number): string | null {
  if (rows.length === 0 || rows.length < limit) return null;
  return rows[rows.length - 1].cursor;
}

/**
 * Session list with per-session token and cost rollups.
 *
 * Tokens live on turn rows, not session rows, so the aggregate joins children
 * back to their parent. Cost is computed here rather than read from a span:
 * eve only emits `gen_ai.usage.cost` for AI-Gateway-served calls, and a
 * self-hosted agent calls its provider directly, so nothing upstream knows the
 * price.
 *
 * ─ Paging ─
 *
 * Keyset, not OFFSET, and it replaced an `offset` parameter that had no callers
 * passing it. OFFSET is wrong here twice over. It re-walks and discards every
 * skipped row, so page 500 of a 100k-session list does the work of pages 1-500
 * inside the LATERAL rollup; and it is only coherent if the sort is total,
 * which `ORDER BY created_at DESC` alone is not — eve can open two sessions in
 * the same microsecond, and two rows tied on the sort key may come back in
 * either order per query, so an OFFSET boundary landing inside a tie both
 * skips a session and shows another twice. `id` is the primary key, so
 * `(created_at, id)` is total and the tie is gone.
 *
 * The row-comparison predicate is deliberate: `(created_at, id) < (…, …)`
 * becomes a single index condition on `evestack_runs_type_created_idx`, where
 * the equivalent `a < x OR (a = x AND b < y)` does not. Measured on the seeded
 * database, LIMIT 50 with a cursor: index scan, 52 shared buffers, 0.156 ms.
 */
export async function listSessions(
  limit = 100,
  cursor: SessionCursor | null = null,
): Promise<SessionRow[]> {
  await ensureQueryIndexes();
  const rows = await query<Record<string, unknown>>(
    `
    SELECT
      s.id,
      s.status,
      s.attributes->>'$eve.title'   AS title,
      s.attributes->>'$eve.trigger' AS trigger,
      s.created_at, s.completed_at,
      to_char(s.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS cursor_created_at,
      COALESCE(t.turn_count, 0)      AS turn_count,
      COALESCE(t.input_tokens, 0)    AS input_tokens,
      COALESCE(t.output_tokens, 0)   AS output_tokens,
      COALESCE(t.cache_read, 0)      AS cache_read_tokens,
      COALESCE(t.models, ARRAY[]::text[]) AS models,
      COALESCE(t.cost_parts, ARRAY[]::text[]) AS cost_parts
    FROM workflow.workflow_runs s
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) FILTER (WHERE c.attributes->>'$eve.type' = 'turn') AS turn_count,
        SUM((c.attributes->>'$eve.input_tokens')::bigint)           AS input_tokens,
        SUM((c.attributes->>'$eve.output_tokens')::bigint)          AS output_tokens,
        SUM((c.attributes->>'$eve.cache_read_tokens')::bigint)      AS cache_read,
        ARRAY_AGG(DISTINCT c.attributes->>'$eve.model')
          FILTER (WHERE c.attributes->>'$eve.model' IS NOT NULL)    AS models,
        ARRAY_AGG(
          (c.attributes->>'$eve.model') || '|' ||
          COALESCE(c.attributes->>'$eve.input_tokens','0') || '|' ||
          COALESCE(c.attributes->>'$eve.output_tokens','0') || '|' ||
          COALESCE(c.attributes->>'$eve.cache_read_tokens','0')
        ) FILTER (WHERE c.attributes->>'$eve.model' IS NOT NULL)    AS cost_parts
      FROM workflow.workflow_runs c
      WHERE c.attributes->>'$eve.root' = s.id
         OR c.attributes->>'$eve.parent' = s.id
    ) t ON TRUE
    WHERE s.attributes->>'$eve.type' = 'session'
      -- $2 IS NULL is the first page. Both halves of the cursor are bound as
      -- text and cast here, so no JS Date ever touches a naive-UTC column.
      AND ($2::text IS NULL OR (s.created_at, s.id) < ($2::timestamp, $3::text))
    ORDER BY s.created_at DESC, s.id DESC
    LIMIT $1
    `,
    [limit, cursor?.createdAt ?? null, cursor?.id ?? null],
  );

  return rows.map((r) => ({
    id: String(r.id),
    status: String(r.status),
    title: (r.title as string) ?? null,
    trigger: (r.trigger as string) ?? null,
    createdAt: new Date(r.created_at as string).toISOString(),
    completedAt: r.completed_at ? new Date(r.completed_at as string).toISOString() : null,
    turnCount: NUM(r.turn_count),
    inputTokens: NUM(r.input_tokens),
    outputTokens: NUM(r.output_tokens),
    cacheReadTokens: NUM(r.cache_read_tokens),
    models: (r.models as string[]) ?? [],
    costUsd: sumCostParts((r.cost_parts as string[]) ?? []),
    cursor: encodeSessionCursor({
      createdAt: String(r.cursor_created_at),
      id: String(r.id),
    }),
  }));
}

/**
 * Every turn and subagent under a session, ordered for tree rendering.
 *
 * ─ Where `toolInvocations` comes from ─
 *
 * Not from the run row: nothing eve writes to `workflow.workflow_runs` counts
 * tool calls. `$eve.tool_count` is the registry size (see `TurnRow.toolsOffered`),
 * and `workflow.workflow_steps` holds only the fixed engine steps — turnStep,
 * dispatchTurnStep and friends — one set per turn regardless of what the model
 * did. Verified against the seeded database: seven distinct `step_name` values
 * across 1,727 turns, not one of them per-tool.
 *
 * The only record of an actual invocation is an `execute_tool <name>` span, and
 * those spans carry no session or turn id at all. That is not a gap in the
 * fixture, it is what a real exporting install emits: authoring
 * `agent/instrumentation.ts` disables eve's local `agent.*` tracer, after which
 * only the trace root (`ai.eve.turn`) and the `invoke_agent`/`step N` spans
 * carry `ai.settings.context.eve.turn.id`, and the `chat`/`execute_tool`
 * children hang beneath them carrying nothing. So the id is inherited through
 * `trace_id`. That is the same shape W1's attribution work generalises, done
 * here narrowly enough to keep working either way: if W1 lands ids on the child
 * spans directly, `turn_id` merely agrees with the root's and the HAVING below
 * still passes.
 *
 * `HAVING COUNT(DISTINCT turn_id) = 1` is the honesty clause. A trace spanning
 * two turns cannot say which one called the tool, so it contributes to neither
 * rather than being split or double-counted, and those turns report `null` —
 * the same as no trace at all.
 */
export async function getSessionTree(sessionId: string): Promise<TurnRow[]> {
  // `evestack.spans` is created lazily by the trace ingest path, so a dashboard
  // that has never received a span would otherwise 42P01 on the join below.
  // Called here as well as inside ensureQueryIndexes because that one swallows
  // its failures and this query genuinely cannot run without the table.
  await ensureTraceSchema();
  await ensureQueryIndexes();
  const rows = await query<Record<string, unknown>>(
    `
    WITH runs AS (
      SELECT id, status, error_code, created_at, started_at, completed_at,
             attributes
      FROM workflow.workflow_runs
      WHERE (attributes->>'$eve.root' = $1
          OR attributes->>'$eve.parent' = $1
          OR id = $1)
        AND attributes->>'$eve.type' IS NOT NULL
    ),
    -- Traces that resolve to exactly one of this session's runs.
    trace_turn AS (
      SELECT s.trace_id, MIN(s.turn_id) AS turn_id
      FROM evestack.spans s
      WHERE s.turn_id IN (SELECT id FROM runs)
      GROUP BY s.trace_id
      HAVING COUNT(DISTINCT s.turn_id) = 1
    ),
    tool_calls AS (
      SELECT tt.turn_id,
             -- Backslash-escaped: an unescaped \`_\` is a LIKE wildcard, so
             -- 'execute_tool %' would also match a future 'executeXtool ' span.
             COUNT(*) FILTER (WHERE s.name LIKE 'execute\\_tool %') AS invocations
      FROM trace_turn tt
      JOIN evestack.spans s ON s.trace_id = tt.trace_id
      GROUP BY tt.turn_id
    )
    SELECT r.id, r.status, r.error_code, r.created_at, r.started_at,
           r.completed_at, r.attributes,
           tc.invocations AS tool_invocations
    FROM runs r
    LEFT JOIN tool_calls tc ON tc.turn_id = r.id
    ORDER BY r.created_at ASC
    `,
    [sessionId],
  );

  return rows.map((r) => {
    const a = (r.attributes ?? {}) as Record<string, string>;
    const started = r.started_at ? new Date(r.started_at as string).getTime() : null;
    const done = r.completed_at ? new Date(r.completed_at as string).getTime() : null;
    const input = NUM(a["$eve.input_tokens"]);
    const output = NUM(a["$eve.output_tokens"]);
    const cacheRead = NUM(a["$eve.cache_read_tokens"]);
    return {
      id: String(r.id),
      type: a["$eve.type"] ?? "unknown",
      parent: a["$eve.parent"] ?? null,
      root: a["$eve.root"] ?? null,
      status: String(r.status),
      model: a["$eve.model"] ?? null,
      subagent: a["$eve.subagent"] ?? null,
      createdAt: new Date(r.created_at as string).toISOString(),
      startedAt: r.started_at ? new Date(r.started_at as string).toISOString() : null,
      completedAt: r.completed_at ? new Date(r.completed_at as string).toISOString() : null,
      durationMs: started !== null && done !== null ? done - started : null,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: NUM(a["$eve.cache_write_tokens"]),
      toolsOffered: NUM_OR_NULL(a["$eve.tool_count"]),
      toolInvocations: NUM_OR_NULL(r.tool_invocations),
      errorCode: (r.error_code as string) ?? null,
      costUsd: costUsd(a["$eve.model"] ?? null, input, output, cacheRead),
      noModelCall:
        (a["$eve.type"] === "turn") &&
        !a["$eve.model"] &&
        r.completed_at !== null,
    };
  });
}

export async function getSession(sessionId: string): Promise<SessionRow | null> {
  const [row] = await query<Record<string, unknown>>(
    `SELECT id, status, attributes, created_at, completed_at,
            to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS cursor_created_at
     FROM workflow.workflow_runs WHERE id = $1`,
    [sessionId],
  );
  if (!row) return null;
  const tree = await getSessionTree(sessionId);
  const turns = tree.filter((t) => t.type === "turn");
  const a = (row.attributes ?? {}) as Record<string, string>;
  return {
    id: String(row.id),
    status: String(row.status),
    title: a["$eve.title"] ?? null,
    trigger: a["$eve.trigger"] ?? null,
    createdAt: new Date(row.created_at as string).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at as string).toISOString() : null,
    turnCount: turns.length,
    inputTokens: turns.reduce((s, t) => s + t.inputTokens, 0),
    outputTokens: turns.reduce((s, t) => s + t.outputTokens, 0),
    cacheReadTokens: turns.reduce((s, t) => s + t.cacheReadTokens, 0),
    models: [...new Set(turns.map((t) => t.model).filter((m): m is string => !!m))],
    costUsd: turns.reduce((s, t) => s + t.costUsd, 0),
    cursor: encodeSessionCursor({
      createdAt: String(row.cursor_created_at),
      id: String(row.id),
    }),
  };
}

/** Totals across every session, for the header stat row. */
export async function getTotals(): Promise<{
  sessions: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}> {
  const [row] = await query<Record<string, unknown>>(
    `
    SELECT
      COUNT(*) FILTER (WHERE attributes->>'$eve.type' = 'session') AS sessions,
      COUNT(*) FILTER (WHERE attributes->>'$eve.type' = 'turn')    AS turns,
      COALESCE(SUM((attributes->>'$eve.input_tokens')::bigint), 0)  AS input_tokens,
      COALESCE(SUM((attributes->>'$eve.output_tokens')::bigint), 0) AS output_tokens,
      COALESCE(ARRAY_AGG(
        (attributes->>'$eve.model') || '|' ||
        COALESCE(attributes->>'$eve.input_tokens','0') || '|' ||
        COALESCE(attributes->>'$eve.output_tokens','0') || '|' ||
        COALESCE(attributes->>'$eve.cache_read_tokens','0')
      ) FILTER (WHERE attributes->>'$eve.model' IS NOT NULL), ARRAY[]::text[]) AS cost_parts
    FROM workflow.workflow_runs
    `,
  );
  return {
    sessions: NUM(row?.sessions),
    turns: NUM(row?.turns),
    inputTokens: NUM(row?.input_tokens),
    outputTokens: NUM(row?.output_tokens),
    costUsd: sumCostParts((row?.cost_parts as string[]) ?? []),
  };
}

function sumCostParts(parts: string[]): number {
  let total = 0;
  for (const part of parts) {
    const [model, input, output, cacheRead] = part.split("|");
    total += costUsd(model ?? null, NUM(input), NUM(output), NUM(cacheRead));
  }
  return total;
}
