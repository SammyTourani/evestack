import { Pool } from "pg";
import type { BudgetConfig } from "./config.js";

/**
 * Spend lives in the `evestack` schema on the Postgres that already stores
 * eve's durable sessions.
 *
 * Never `workflow` — that schema belongs to eve's runtime, and a table of ours
 * colliding with theirs on an upgrade is not a risk worth taking for the
 * convenience of one fewer `CREATE SCHEMA`.
 *
 * The reason this package can exist at all is that this database outlives the
 * session. Every limit eve has is scoped to one durable session, so a caller
 * routes around it by starting a new one. A daily cap needs a store that does
 * not reset when the conversation does.
 */

/** One scope a cap can be enforced on. */
export type BudgetScope = "session" | "principal-day";

export interface SpendTotals {
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly steps: number;
  readonly unpricedSteps: number;
}

export interface StepSpend {
  readonly sessionId: string;
  readonly principalId: string;
  readonly turnId: string;
  readonly stepIndex: number;
  readonly sequence: number;
  readonly day: string;
  readonly model: string;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly priced: boolean;
}

export interface RecordedSpend {
  /** False when this exact step was already counted — see the retry note below. */
  readonly counted: boolean;
  readonly session: SpendTotals;
  readonly principalDay: SpendTotals;
}

const EMPTY: SpendTotals = {
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  steps: 0,
  unpricedSteps: 0,
};

let pool: Pool | null = null;
let ready: Promise<void> | null = null;

function getPool(config: BudgetConfig): Pool {
  const url = config.databaseUrl;
  if (!url) {
    throw new Error(
      "[evestack:budget] needs WORKFLOW_POSTGRES_URL or DATABASE_URL (or an explicit " +
        "databaseUrl). A spend cap that only lives in process memory resets on every " +
        "restart, so there is no safe in-memory fallback to offer here.",
    );
  }
  // Small on purpose: this runs inside the agent process next to eve's own
  // pool and the memory pool, and it does two tiny indexed writes per step.
  if (!pool) {
    pool = new Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 5_000 });
    // Without this, a Postgres restart while a client sits idle here is an
    // uncaughtException, not a failed query, and it takes the agent down with
    // it. pg-pool re-emits an idle client's socket error on the pool, and
    // `emit("error")` with no listener throws. That matters more here than
    // anywhere: spend caps are ON BY DEFAULT, so this pool exists in every
    // project whether or not its owner ever thought about budgets.
    // packages/dashboard/lib/db.ts has carried this listener all along.
    pool.on("error", (error) => {
      console.warn(`[evestack:budget] idle Postgres client error: ${error.message}`);
    });
  }
  return pool;
}

export async function ensureSchema(config: BudgetConfig): Promise<void> {
  ready ??= (async () => {
    const db = getPool(config);
    await db.query("CREATE SCHEMA IF NOT EXISTS evestack");

    /**
     * The per-step ledger exists for exactly one reason: hooks are
     * at-least-once.
     *
     * eve runs each durable step up to four times. An interrupted step
     * re-emits its events with fresh `meta.id`s, so keying money on `meta.id`
     * would bill a retried step twice. eve's own guidance for a side effect
     * that must happen once per step is to key on the step coordinates the
     * retry restores from its input — `turnId`, `stepIndex`, `sequence` — and
     * that is exactly what this primary key is.
     */
    await db.query(`
      CREATE TABLE IF NOT EXISTS evestack.budget_steps (
        session_id        text        NOT NULL,
        turn_id           text        NOT NULL,
        step_index        int         NOT NULL,
        sequence          int         NOT NULL,
        principal_id      text        NOT NULL,
        day               date        NOT NULL,
        model             text        NOT NULL,
        cost_usd          numeric(16, 8) NOT NULL DEFAULT 0,
        input_tokens      bigint      NOT NULL DEFAULT 0,
        output_tokens     bigint      NOT NULL DEFAULT 0,
        cache_read_tokens bigint      NOT NULL DEFAULT 0,
        priced            boolean     NOT NULL DEFAULT true,
        created_at        timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (session_id, turn_id, step_index, sequence)
      )
    `);

    /**
     * Aggregates, one row per (scope, key). Reading a cap has to be a single
     * primary-key lookup: the step-scoped guard runs before every model call,
     * so anything slower here shows up as latency on every turn.
     */
    await db.query(`
      CREATE TABLE IF NOT EXISTS evestack.budget_usage (
        scope             text        NOT NULL,
        scope_key         text        NOT NULL,
        principal_id      text,
        session_id        text,
        day               date,
        cost_usd          numeric(16, 8) NOT NULL DEFAULT 0,
        input_tokens      bigint      NOT NULL DEFAULT 0,
        output_tokens     bigint      NOT NULL DEFAULT 0,
        cache_read_tokens bigint      NOT NULL DEFAULT 0,
        steps             int         NOT NULL DEFAULT 0,
        unpriced_steps    int         NOT NULL DEFAULT 0,
        updated_at        timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (scope, scope_key)
      )
    `);

    /**
     * Why the cap tripped, kept separately from the counters.
     *
     * `turn.cancelled` on the stream says a turn stopped; it does not say a
     * budget stopped it. Without this table the dashboard could only show that
     * spend is at the cap and infer the rest. `session_id` is indexed because
     * that is the only way anyone ever looks these up.
     */
    await db.query(`
      CREATE TABLE IF NOT EXISTS evestack.budget_events (
        id           bigserial   PRIMARY KEY,
        session_id   text        NOT NULL,
        turn_id      text,
        principal_id text,
        scope        text        NOT NULL,
        limit_usd    numeric(16, 8) NOT NULL,
        spent_usd    numeric(16, 8) NOT NULL,
        action       text        NOT NULL,
        detail       jsonb,
        created_at   timestamptz NOT NULL DEFAULT now()
      )
    `);
    await db.query(
      "CREATE INDEX IF NOT EXISTS budget_events_session_idx ON evestack.budget_events (session_id, created_at DESC)",
    );

    /**
     * The current stop state, and the only thing the tool guard reads.
     *
     * The guard runs before every model call and has to know whether the
     * budget is gone. Letting it evaluate the caps itself was the obvious
     * design and the wrong one: the hook and the guard resolve configuration
     * independently, so a cap passed as an option to one and not the other
     * left the guard comparing against a stale limit and quietly leaving every
     * tool enabled. Measured exactly that.
     *
     * So the hook is the only thing that decides, and this table is how the
     * decision travels. It is also durable, which the process-local flag was
     * not: a restart used to forget that a session was already stopped.
     */
    await db.query(`
      CREATE TABLE IF NOT EXISTS evestack.budget_stops (
        scope      text        NOT NULL,
        scope_key  text        NOT NULL,
        session_id text,
        reason     text        NOT NULL,
        limit_usd  numeric(16, 8) NOT NULL,
        spent_usd  numeric(16, 8) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (scope, scope_key)
      )
    `);
    /**
     * Retention. Both sweeps run once per process, on the same 30 days.
     *
     * A principal-day key contains the day, so yesterday's stop can never match
     * today's lookup — it is simply litter. A session-scoped stop for a session
     * that ended over budget is litter for exactly the same reason, and it was
     * not covered here at all: the scope filter meant the one table nobody
     * cleaned kept a row per stopped session forever.
     *
     * Dropping a session stop this old is safe because `budget_usage` is
     * deliberately not swept. The money survives, so if such a session is ever
     * resumed its very next `step.completed` re-reads the same over-budget total
     * and `recordStop` writes the row again — at the cost of the one in-flight
     * step this package already documents as its overshoot. `recordStop` does
     * not refresh `created_at` on conflict, so a session that has been stopped
     * continuously for longer than the window is swept and immediately rewritten.
     */
    await db.query(
      "DELETE FROM evestack.budget_stops WHERE created_at < now() - interval '30 days'",
    );
    /**
     * The per-step ledger is the table that grows per model call, and it had no
     * bound at all: one row per step forever, with `resetSession` the sole other
     * `DELETE` and that one scoped to a single session.
     *
     * It is cheap to keep it short. The row exists to deduplicate eve's step
     * retries, which happen inside a turn and at most four times, so it is
     * load-bearing for seconds and kept for 30 days only to stay on one number
     * with the sweep above rather than inventing a second. Nothing is lost that
     * a cap reads: `budget_usage` holds the totals, so removing a step row can
     * never lower a total or raise a cap.
     *
     * `budget_events` is left alone on purpose. It is also unswept, but it grows
     * per stop rather than per step, and it is the whole answer to "why did this
     * session stop" — the question the event stream cannot answer and this
     * package exists to record. Deleting that is a different decision from
     * garbage-collecting a dedup key, and not one to make in passing.
     *
     * No index on `created_at` on purpose. This runs once per process against a
     * table retention now keeps small, whereas an index would be paid for on
     * every step insert on the hot path.
     */
    await db.query(
      "DELETE FROM evestack.budget_steps WHERE created_at < now() - interval '30 days'",
    );
    await db.query(
      "CREATE INDEX IF NOT EXISTS budget_usage_day_idx ON evestack.budget_usage (day DESC) WHERE scope = 'principal-day'",
    );
  })().catch((error: unknown) => {
    // A memoized promise that REJECTED is still memoized, so without this the
    // first call made before Postgres was accepting connections disabled spend
    // tracking for the life of the process and kept quoting the original error
    // afterwards. Same defect, same fix, as templates/default/lib/memory.ts.
    ready = null;
    throw error;
  });
  return ready;
}

/** `2026-08-04|alice` — the day first so the fixed-width prefix parses cleanly. */
export function principalDayKey(principalId: string, day: string): string {
  return `${day}|${principalId}`;
}

interface TotalsRow {
  readonly counted: boolean;
  readonly session_cost: string | null;
  readonly session_input: string | null;
  readonly session_output: string | null;
  readonly session_cache: string | null;
  readonly session_steps: string | null;
  readonly session_unpriced: string | null;
  readonly day_cost: string | null;
  readonly day_input: string | null;
  readonly day_output: string | null;
  readonly day_cache: string | null;
  readonly day_steps: string | null;
  readonly day_unpriced: string | null;
}

function num(value: string | null): number {
  return value === null ? 0 : Number(value);
}

/**
 * Adds one step's spend to both scopes and returns the new totals.
 *
 * One statement, because the guard's decision must be made against the same
 * snapshot the write produced. The `step` CTE is the deduplication gate: on a
 * retried step it returns no rows, the two upserts insert nothing, and the
 * `COALESCE` falls through to the stored totals — the caller still gets an
 * accurate number to compare against the cap, it just does not pay twice.
 */
export async function recordStep(config: BudgetConfig, spend: StepSpend): Promise<RecordedSpend> {
  await ensureSchema(config);
  const db = getPool(config);
  const dayScopeKey = principalDayKey(spend.principalId, spend.day);
  const unpriced = spend.priced ? 0 : 1;

  const { rows } = await db.query<TotalsRow>(
    `
    WITH step AS (
      INSERT INTO evestack.budget_steps (
        session_id, turn_id, step_index, sequence, principal_id, day, model,
        cost_usd, input_tokens, output_tokens, cache_read_tokens, priced
      )
      VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (session_id, turn_id, step_index, sequence) DO NOTHING
      RETURNING cost_usd, input_tokens, output_tokens, cache_read_tokens, priced
    ),
    sess AS (
      INSERT INTO evestack.budget_usage (
        scope, scope_key, session_id, principal_id, day,
        cost_usd, input_tokens, output_tokens, cache_read_tokens, steps, unpriced_steps
      )
      SELECT 'session', $1, $1, $5, $6::date,
             step.cost_usd, step.input_tokens, step.output_tokens, step.cache_read_tokens, 1, $13
      FROM step
      ON CONFLICT (scope, scope_key) DO UPDATE SET
        cost_usd          = evestack.budget_usage.cost_usd + EXCLUDED.cost_usd,
        input_tokens      = evestack.budget_usage.input_tokens + EXCLUDED.input_tokens,
        output_tokens     = evestack.budget_usage.output_tokens + EXCLUDED.output_tokens,
        cache_read_tokens = evestack.budget_usage.cache_read_tokens + EXCLUDED.cache_read_tokens,
        steps             = evestack.budget_usage.steps + 1,
        unpriced_steps    = evestack.budget_usage.unpriced_steps + EXCLUDED.unpriced_steps,
        updated_at        = now()
      RETURNING cost_usd, input_tokens, output_tokens, cache_read_tokens, steps, unpriced_steps
    ),
    daily AS (
      INSERT INTO evestack.budget_usage (
        scope, scope_key, session_id, principal_id, day,
        cost_usd, input_tokens, output_tokens, cache_read_tokens, steps, unpriced_steps
      )
      SELECT 'principal-day', $14, NULL, $5, $6::date,
             step.cost_usd, step.input_tokens, step.output_tokens, step.cache_read_tokens, 1, $13
      FROM step
      ON CONFLICT (scope, scope_key) DO UPDATE SET
        cost_usd          = evestack.budget_usage.cost_usd + EXCLUDED.cost_usd,
        input_tokens      = evestack.budget_usage.input_tokens + EXCLUDED.input_tokens,
        output_tokens     = evestack.budget_usage.output_tokens + EXCLUDED.output_tokens,
        cache_read_tokens = evestack.budget_usage.cache_read_tokens + EXCLUDED.cache_read_tokens,
        steps             = evestack.budget_usage.steps + 1,
        unpriced_steps    = evestack.budget_usage.unpriced_steps + EXCLUDED.unpriced_steps,
        updated_at        = now()
      RETURNING cost_usd, input_tokens, output_tokens, cache_read_tokens, steps, unpriced_steps
    ),
    stored_session AS (
      SELECT * FROM evestack.budget_usage WHERE scope = 'session' AND scope_key = $1
    ),
    stored_day AS (
      SELECT * FROM evestack.budget_usage WHERE scope = 'principal-day' AND scope_key = $14
    )
    SELECT
      EXISTS (SELECT 1 FROM step)                                                     AS counted,
      COALESCE((SELECT cost_usd FROM sess),  (SELECT cost_usd FROM stored_session), 0) AS session_cost,
      COALESCE((SELECT input_tokens FROM sess),  (SELECT input_tokens FROM stored_session), 0) AS session_input,
      COALESCE((SELECT output_tokens FROM sess), (SELECT output_tokens FROM stored_session), 0) AS session_output,
      COALESCE((SELECT cache_read_tokens FROM sess), (SELECT cache_read_tokens FROM stored_session), 0) AS session_cache,
      COALESCE((SELECT steps FROM sess), (SELECT steps FROM stored_session), 0)        AS session_steps,
      COALESCE((SELECT unpriced_steps FROM sess), (SELECT unpriced_steps FROM stored_session), 0) AS session_unpriced,
      COALESCE((SELECT cost_usd FROM daily), (SELECT cost_usd FROM stored_day), 0)     AS day_cost,
      COALESCE((SELECT input_tokens FROM daily), (SELECT input_tokens FROM stored_day), 0) AS day_input,
      COALESCE((SELECT output_tokens FROM daily), (SELECT output_tokens FROM stored_day), 0) AS day_output,
      COALESCE((SELECT cache_read_tokens FROM daily), (SELECT cache_read_tokens FROM stored_day), 0) AS day_cache,
      COALESCE((SELECT steps FROM daily), (SELECT steps FROM stored_day), 0)           AS day_steps,
      COALESCE((SELECT unpriced_steps FROM daily), (SELECT unpriced_steps FROM stored_day), 0) AS day_unpriced
    `,
    [
      spend.sessionId,
      spend.turnId,
      spend.stepIndex,
      spend.sequence,
      spend.principalId,
      spend.day,
      spend.model,
      spend.costUsd,
      spend.inputTokens,
      spend.outputTokens,
      spend.cacheReadTokens,
      spend.priced,
      unpriced,
      dayScopeKey,
    ],
  );

  const row = rows[0];
  if (!row) return { counted: false, session: EMPTY, principalDay: EMPTY };

  return {
    counted: row.counted,
    session: {
      costUsd: num(row.session_cost),
      inputTokens: num(row.session_input),
      outputTokens: num(row.session_output),
      cacheReadTokens: num(row.session_cache),
      steps: num(row.session_steps),
      unpricedSteps: num(row.session_unpriced),
    },
    principalDay: {
      costUsd: num(row.day_cost),
      inputTokens: num(row.day_input),
      outputTokens: num(row.day_output),
      cacheReadTokens: num(row.day_cache),
      steps: num(row.day_steps),
      unpricedSteps: num(row.day_unpriced),
    },
  };
}

/** Reads both scopes without writing. Used by the guard and the report route. */
export async function readTotals(
  config: BudgetConfig,
  input: { readonly sessionId: string; readonly principalId: string; readonly day: string },
): Promise<{ readonly session: SpendTotals; readonly principalDay: SpendTotals }> {
  await ensureSchema(config);
  const db = getPool(config);
  const { rows } = await db.query<{
    scope: string;
    cost_usd: string;
    input_tokens: string;
    output_tokens: string;
    cache_read_tokens: string;
    steps: number;
    unpriced_steps: number;
  }>(
    `SELECT scope, cost_usd, input_tokens, output_tokens, cache_read_tokens, steps, unpriced_steps
       FROM evestack.budget_usage
      WHERE (scope = 'session' AND scope_key = $1)
         OR (scope = 'principal-day' AND scope_key = $2)`,
    [input.sessionId, principalDayKey(input.principalId, input.day)],
  );

  const pick = (scope: string): SpendTotals => {
    const row = rows.find((candidate) => candidate.scope === scope);
    if (!row) return EMPTY;
    return {
      costUsd: Number(row.cost_usd),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      cacheReadTokens: Number(row.cache_read_tokens),
      steps: row.steps,
      unpricedSteps: row.unpriced_steps,
    };
  };

  return { session: pick("session"), principalDay: pick("principal-day") };
}

/** Marks a scope as out of budget. Idempotent: the first reason is kept. */
export async function recordStop(
  config: BudgetConfig,
  input: {
    readonly scope: BudgetScope;
    readonly scopeKey: string;
    readonly sessionId: string;
    readonly reason: string;
    readonly limitUsd: number;
    readonly spentUsd: number;
  },
): Promise<void> {
  await ensureSchema(config);
  const db = getPool(config);
  await db.query(
    `INSERT INTO evestack.budget_stops (scope, scope_key, session_id, reason, limit_usd, spent_usd)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (scope, scope_key) DO UPDATE SET spent_usd = EXCLUDED.spent_usd`,
    [input.scope, input.scopeKey, input.sessionId, input.reason, input.limitUsd, input.spentUsd],
  );
}

/**
 * Lifts a stop, for when the cap was raised under a session that had already
 * hit the old one. The hook calls this the next time it evaluates and finds
 * the budget is no longer gone, so a raised cap heals within one step instead
 * of leaving the tools shadowed for the life of the session.
 */
export async function clearStop(
  config: BudgetConfig,
  input: { readonly sessionId: string; readonly principalId: string; readonly day: string },
): Promise<void> {
  await ensureSchema(config);
  const db = getPool(config);
  await db.query(
    `DELETE FROM evestack.budget_stops
      WHERE (scope = 'session' AND scope_key = $1)
         OR (scope = 'principal-day' AND scope_key = $2)`,
    [input.sessionId, principalDayKey(input.principalId, input.day)],
  );
}

/** The guard's whole question, answered in one primary-key lookup. */
export async function readStop(
  config: BudgetConfig,
  input: { readonly sessionId: string; readonly principalId: string; readonly day: string },
): Promise<{ readonly scope: BudgetScope; readonly reason: string } | null> {
  await ensureSchema(config);
  const db = getPool(config);
  // Session first, which is the order `evaluate` in hook.ts decides in and for
  // the reason stated there: when both scopes have stopped, the session message
  // names a conversation the user can see where the daily one names an aggregate
  // they cannot. Plain `ORDER BY scope` sorted 'principal-day' ahead of 'session'
  // alphabetically, so the guard answered with the less actionable of the two and
  // blamed the daily budget for a turn the session budget stopped.
  const { rows } = await db.query<{ scope: string; reason: string }>(
    `SELECT scope, reason
       FROM evestack.budget_stops
      WHERE (scope = 'session' AND scope_key = $1)
         OR (scope = 'principal-day' AND scope_key = $2)
      ORDER BY CASE WHEN scope = 'session' THEN 0 ELSE 1 END
      LIMIT 1`,
    [input.sessionId, principalDayKey(input.principalId, input.day)],
  );
  const row = rows[0];
  return row ? { scope: row.scope as BudgetScope, reason: row.reason } : null;
}

export interface BudgetEventInput {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly principalId: string;
  readonly scope: BudgetScope;
  readonly limitUsd: number;
  readonly spentUsd: number;
  readonly action: string;
  readonly detail?: Record<string, unknown>;
}

export async function recordBudgetEvent(
  config: BudgetConfig,
  input: BudgetEventInput,
): Promise<void> {
  await ensureSchema(config);
  const db = getPool(config);
  await db.query(
    `INSERT INTO evestack.budget_events
       (session_id, turn_id, principal_id, scope, limit_usd, spent_usd, action, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.sessionId,
      input.turnId ?? null,
      input.principalId,
      input.scope,
      input.limitUsd,
      input.spentUsd,
      input.action,
      input.detail ? JSON.stringify(input.detail) : null,
    ],
  );
}

export interface BudgetEventRow {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string | null;
  readonly principalId: string | null;
  readonly scope: string;
  readonly limitUsd: number;
  readonly spentUsd: number;
  readonly action: string;
  readonly detail: Record<string, unknown> | null;
  readonly createdAt: Date;
}

/** Most recent stops, newest first. The dashboard's "why did it stop" answer. */
export async function recentBudgetEvents(
  config: BudgetConfig,
  input: { readonly sessionId?: string; readonly limit?: number } = {},
): Promise<readonly BudgetEventRow[]> {
  await ensureSchema(config);
  const db = getPool(config);
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 200);
  const { rows } = await db.query(
    `SELECT id, session_id, turn_id, principal_id, scope, limit_usd, spent_usd, action, detail, created_at
       FROM evestack.budget_events
      WHERE $1::text IS NULL OR session_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [input.sessionId ?? null, limit],
  );
  return rows.map((row) => ({
    id: String(row.id),
    sessionId: row.session_id as string,
    turnId: row.turn_id as string | null,
    principalId: row.principal_id as string | null,
    scope: row.scope as string,
    limitUsd: Number(row.limit_usd),
    spentUsd: Number(row.spent_usd),
    action: row.action as string,
    detail: row.detail as Record<string, unknown> | null,
    createdAt: row.created_at as Date,
  }));
}

/** Today's spend for every principal, for the dashboard's daily view. */
export async function principalDaySpend(
  config: BudgetConfig,
  day: string,
): Promise<readonly { principalId: string; costUsd: number; steps: number; unpricedSteps: number }[]> {
  await ensureSchema(config);
  const db = getPool(config);
  const { rows } = await db.query(
    `SELECT principal_id, cost_usd, steps, unpriced_steps
       FROM evestack.budget_usage
      WHERE scope = 'principal-day' AND day = $1::date
      ORDER BY cost_usd DESC`,
    [day],
  );
  return rows.map((row) => ({
    principalId: (row.principal_id as string | null) ?? "unknown",
    costUsd: Number(row.cost_usd),
    steps: Number(row.steps),
    unpricedSteps: Number(row.unpriced_steps),
  }));
}

/** Test/ops helper: clears a session's counters so a cap can be re-observed. */
export async function resetSession(config: BudgetConfig, sessionId: string): Promise<void> {
  await ensureSchema(config);
  const db = getPool(config);
  await db.query("DELETE FROM evestack.budget_steps WHERE session_id = $1", [sessionId]);
  await db.query(
    "DELETE FROM evestack.budget_usage WHERE scope = 'session' AND scope_key = $1",
    [sessionId],
  );
  await db.query(
    "DELETE FROM evestack.budget_stops WHERE scope = 'session' AND scope_key = $1",
    [sessionId],
  );
}
