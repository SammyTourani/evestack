import { query } from "./db";
import { costUsd, isPriced } from "./pricing";
import { ensureTraceSchema } from "./traces";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The fact layer's driver: apply `sql/facts.sql`, price the models, run the
 * refresh, and prove afterwards that the tables agree with their source.
 *
 * The SQL is in `sql/facts.sql` and so is the reasoning about what each column
 * means. This file exists for the two things SQL cannot do:
 *
 *   1. PRICE A MODEL. `lib/pricing.ts` owns the catalog, the wildcard rules and
 *      the two fallbacks that decide what a cache read and a cache write cost
 *      when the provider states no rate. Restating those in SQL would be a
 *      second definition of pricing policy, and this codebase has already paid
 *      for one of those. So the rates come out of `pricing.ts` and go in as a
 *      parameter, and SQL multiplies.
 *
 *   2. RECONCILE. `reconcileFacts` re-derives the same totals straight from
 *      `workflow.workflow_runs` and compares. A materialized table that has
 *      drifted from its source is worse than no table, because it is confident.
 *
 * ── How the rates are extracted, and why not by reading the table ────────────
 *
 * `pricing.ts` exports no rate table — deliberately, since the table is
 * generated and the lookup applies wildcards and env overrides on top of it. It
 * exports `costUsd`, which is linear in each token class, so the effective rate
 * of a class is what `costUsd` charges for exactly one million tokens of it and
 * nothing else. That is not an approximation and it is not a re-implementation:
 * whatever fallback `costUsd` applies is what comes back. See `effectiveRates`.
 */

/**
 * How long a turn may be in flight before `outcome` calls it wedged.
 *
 * This is lib/fleet.ts's `STUCK_TURN_MS`, which is not exported, so the value is
 * mirrored rather than imported and `test/facts.test.mjs` reads fleet.ts and
 * fails if the two ever disagree. A second, quietly different wedge threshold
 * would put the fact table and the fleet banner in disagreement about the same
 * turn, which is exactly the kind of split definition W2's brief forbids for
 * `outcome`.
 */
export const STUCK_TURN_MS = 60 * 60 * 1000;

/** USD per million tokens, per class, after every fallback pricing.ts applies. */
export interface TokenRates {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** One million, the denominator every published rate is quoted against. */
const PER_MILLION = 1_000_000;

/**
 * The rates `costUsd` would actually charge this model, or null if it is
 * unpriced.
 *
 * Each class is probed on its own: a million tokens of that class and zero of
 * everything else. Cache reads and cache writes arrive INSIDE the input total,
 * so probing them means sending a million input tokens of which a million are
 * cached — which leaves a non-cached remainder of exactly zero and isolates the
 * class. That is the same arithmetic `costUsd` documents, run forwards.
 *
 * Null and zero are different answers and both occur. `ollama/*` is priced at
 * zero on purpose because local inference costs no API money; `acme/*` is
 * unpriced because nobody has said what it costs. The first is a fact, the
 * second is an absence, and the fact table keeps them apart.
 */
export function effectiveRates(model: string | null): TokenRates | null {
  if (!isPriced(model)) return null;
  return {
    input: costUsd(model, PER_MILLION, 0, 0, 0),
    output: costUsd(model, 0, PER_MILLION, 0, 0),
    cacheRead: costUsd(model, PER_MILLION, 0, PER_MILLION, 0),
    cacheWrite: costUsd(model, PER_MILLION, 0, 0, PER_MILLION),
  };
}

export interface RefreshResult {
  /** Rows the refresh looked at — everything at or after the watermark. */
  readonly turnsExamined: number;
  /** Rows whose content actually differed. Zero on a repeat refresh. */
  readonly turnsChanged: number;
  readonly toolCallsExamined: number;
  readonly toolCallsChanged: number;
  /** Distinct models the rate table was built for. */
  readonly pricedModels: number;
  readonly unpricedModels: readonly string[];
  readonly elapsedMs: number;
}

let schemaReady: Promise<void> | null = null;

/**
 * Apply sql/facts.sql, once per process, after the spans schema it reads.
 *
 * Same read-from-disk mechanism as lib/traces.ts and for the same reason: one
 * definition of the DDL, in the file an operator can also pipe into psql.
 */
function ensureFactSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = ensureTraceSchema()
      .then(() => query(readSchemaSql()))
      .then(() => undefined)
      // Never cache a failure: a database that was merely unreachable at boot
      // would otherwise stay "broken" for the life of the process.
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
      return readFileSync(join(dir, "sql", "facts.sql"), "utf8");
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error(
    `Could not find sql/facts.sql above ${process.cwd()}. ` +
      "Run the dashboard from packages/dashboard, or apply the file by hand.",
  );
}

/**
 * Refresh both fact tables from the watermark forward.
 *
 * The watermark is never read into JavaScript. It is passed to the function as a
 * sub-select so the value stays inside Postgres for its whole life: `updated_at`
 * is a zone-less column, node-pg serializes a Date back out in the HOST's zone,
 * and a round trip through JS would therefore move the watermark by the offset
 * on any machine not set to UTC. That is the same bug lib/fleet.ts documents,
 * and here it would silently skip or re-read hours of runs.
 */
export async function refreshFacts(): Promise<RefreshResult> {
  await ensureFactSchema();
  const started = performance.now();

  // Every distinct model in the table, not just the ones in the pending window.
  // A turn can enter the pending set through the SPAN watermark long after its
  // run row stopped moving, and its model would then be missing from a
  // window-scoped rate table — which does not fail, it silently re-materializes
  // a priced turn as unpriced. One pass over one JSONB key is the cost of not
  // doing that.
  const modelRows = await query<{ model: string }>(
    `SELECT DISTINCT r.attributes ->> '$eve.model' AS model
       FROM workflow.workflow_runs r
      WHERE r.attributes ->> '$eve.type' IN ('turn', 'subagent')
        AND r.attributes ->> '$eve.model' IS NOT NULL`,
  );

  const prices: Record<string, TokenRates> = {};
  const unpricedModels: string[] = [];
  for (const { model } of modelRows) {
    const rates = effectiveRates(model);
    if (rates) prices[model] = rates;
    else unpricedModels.push(model);
  }

  const [row] = await query<Record<string, string>>(
    `SELECT * FROM evestack.refresh_facts(
       (SELECT runs_watermark  FROM evestack.fact_watermark WHERE component = 'fact_turn'),
       (SELECT spans_watermark FROM evestack.fact_watermark WHERE component = 'fact_turn'),
       $1::jsonb,
       $2::double precision
     )`,
    [JSON.stringify(prices), STUCK_TURN_MS / 1000],
  );

  return {
    turnsExamined: Number(row?.turns_examined ?? 0),
    turnsChanged: Number(row?.turns_changed ?? 0),
    toolCallsExamined: Number(row?.tool_calls_examined ?? 0),
    toolCallsChanged: Number(row?.tool_calls_changed ?? 0),
    pricedModels: Object.keys(prices).length,
    unpricedModels: unpricedModels.sort(),
    elapsedMs: performance.now() - started,
  };
}

/** The same totals, counted twice: once from the facts, once from the source. */
export interface FactTotals {
  readonly turns: number;
  readonly sessions: number;
  /** lib/monitors.ts's `errored`: the run row carries an error_code. */
  readonly errored: number;
  /** lib/monitors.ts's `noModelCall`: finished, and never recorded a model. */
  readonly noModelCall: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /** Turns whose model has no price. Counted, never summed as zero dollars. */
  readonly unpricedTurns: number;
}

export interface FactReconciliation {
  readonly fact: FactTotals;
  readonly source: FactTotals;
  /** Field names that differ. Empty means the fact table is telling the truth. */
  readonly disagreements: readonly string[];
}

const num = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

function toTotals(row: Record<string, unknown> | undefined): FactTotals {
  return {
    turns: num(row?.turns),
    sessions: num(row?.sessions),
    errored: num(row?.errored),
    noModelCall: num(row?.no_model_call),
    inputTokens: num(row?.input_tokens),
    outputTokens: num(row?.output_tokens),
    cacheReadTokens: num(row?.cache_read_tokens),
    cacheWriteTokens: num(row?.cache_write_tokens),
    unpricedTurns: num(row?.unpriced_turns),
  };
}

/**
 * Count the same things twice and compare.
 *
 * The fact side reads the materialized columns. The source side re-derives them
 * from `workflow.workflow_runs` with the expressions lib/monitors.ts uses, so
 * the comparison is not circular — if the refresh dropped rows at a shared
 * watermark instant, mis-classified an outcome, or lost a token count in a cast,
 * these two disagree.
 *
 * `errored` and `noModelCall` are checked against `outcome` rather than against
 * the fact table's own copy of `error_code`, because the outcome CASE is the
 * thing that could drift from monitors.ts. `failed` and `no_model_call` are the
 * first two arms of that CASE precisely so this equality can hold: no later arm
 * is allowed to take a row away from monitors' failure population.
 */
export async function reconcileFacts(): Promise<FactReconciliation> {
  await ensureFactSchema();

  const [factRow] = await query<Record<string, unknown>>(
    `SELECT count(*)                                          AS turns,
            count(DISTINCT session_id)                        AS sessions,
            count(*) FILTER (WHERE outcome = 'failed')        AS errored,
            count(*) FILTER (WHERE outcome = 'no_model_call') AS no_model_call,
            COALESCE(sum(input_tokens), 0)                    AS input_tokens,
            COALESCE(sum(output_tokens), 0)                   AS output_tokens,
            COALESCE(sum(cache_read_tokens), 0)               AS cache_read_tokens,
            COALESCE(sum(cache_write_tokens), 0)              AS cache_write_tokens,
            count(*) FILTER (WHERE priced IS FALSE)           AS unpriced_turns
       FROM evestack.fact_turn`,
  );

  const [sourceRow] = await query<Record<string, unknown>>(
    `WITH turns AS (
       SELECT r.attributes ->> '$eve.root'  AS session_id,
              r.attributes ->> '$eve.model' AS model,
              r.error_code,
              r.completed_at,
              (r.attributes ->> '$eve.input_tokens')::bigint       AS input_tokens,
              (r.attributes ->> '$eve.output_tokens')::bigint      AS output_tokens,
              (r.attributes ->> '$eve.cache_read_tokens')::bigint  AS cache_read_tokens,
              (r.attributes ->> '$eve.cache_write_tokens')::bigint AS cache_write_tokens
         FROM workflow.workflow_runs r
        WHERE r.attributes ->> '$eve.type' IN ('turn', 'subagent')
     )
     SELECT count(*)                                   AS turns,
            count(DISTINCT session_id)                 AS sessions,
            count(*) FILTER (WHERE error_code IS NOT NULL) AS errored,
            count(*) FILTER (
              WHERE completed_at IS NOT NULL AND model IS NULL
            )                                          AS no_model_call,
            COALESCE(sum(input_tokens), 0)             AS input_tokens,
            COALESCE(sum(output_tokens), 0)            AS output_tokens,
            COALESCE(sum(cache_read_tokens), 0)        AS cache_read_tokens,
            COALESCE(sum(cache_write_tokens), 0)       AS cache_write_tokens,
            count(*) FILTER (WHERE model = ANY ($1::text[])) AS unpriced_turns
       FROM turns`,
    [await unpricedModelList()],
  );

  const fact = toTotals(factRow);
  const source = toTotals(sourceRow);
  const disagreements = (Object.keys(fact) as Array<keyof FactTotals>).filter(
    (key) => fact[key] !== source[key],
  );

  return { fact, source, disagreements };
}

/**
 * Which models in the database `pricing.ts` has no price for.
 *
 * Needed on the source side of the reconciliation: `priced` only exists on the
 * fact row, so the only way to count unpriced turns straight from
 * `workflow_runs` is to ask pricing.ts the same question it was asked during the
 * refresh.
 */
async function unpricedModelList(): Promise<string[]> {
  const rows = await query<{ model: string }>(
    `SELECT DISTINCT r.attributes ->> '$eve.model' AS model
       FROM workflow.workflow_runs r
      WHERE r.attributes ->> '$eve.type' IN ('turn', 'subagent')
        AND r.attributes ->> '$eve.model' IS NOT NULL`,
  );
  return rows.map((r) => r.model).filter((model) => !isPriced(model));
}
