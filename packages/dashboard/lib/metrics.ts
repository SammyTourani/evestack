import { query } from "./db";
import { refreshFacts } from "./facts";

/**
 * The metric catalog, and the one compiler that turns a config object into SQL.
 *
 * ── What this is for ─────────────────────────────────────────────────────────
 *
 * After this file exists, adding a chart is a JSON body, not a code change:
 *
 *   { view: "turns",
 *     measures: [{ measure: "ttft", aggregation: "p95" }],
 *     dimensions: ["model"],
 *     filters: [{ field: "outcome", operator: "eq", value: "ok" }],
 *     timeDimension: { from, to, granularity: "hour" } }
 *
 * The shape is Langfuse's — `{view, measures, dimensions, filters,
 * timeDimension, orderBy, limit}` — because it is proven, MIT, and their preset
 * dashboards are then importable as configuration rather than as work.
 *
 * The catalog below is the ONLY place a column name appears. `compileQuery`
 * cannot emit an identifier that is not in it, so a measure or dimension name
 * from an HTTP body is a lookup key and never a fragment of SQL. Values are
 * always bound as parameters. That is the whole injection story, and
 * `test/metrics.test.mjs` attacks it directly.
 *
 * ── Three things that would otherwise be quiet lies ──────────────────────────
 *
 * 1. COVERAGE. Every response says how many rows actually contributed to each
 *    measure, next to how many matched the query. `p95 ttft` over the seeded
 *    month is computed from 370 of 1,922 turns, because spans are opt-in — a
 *    chart that draws that as "the fleet's TTFT" is the exact failure
 *    `span_coverage` was added to prevent. `sum cost` is 1,651 of 1,922,
 *    because 209 turns ran an unpriced model and 62 never called one. Neither
 *    number is reachable by looking at the value alone.
 *
 * 2. EMPTY IS NOT MISSING. A densified bucket with no rows reports `rows: 0`,
 *    and then `count`/`count_distinct`/`sum` as 0 — those are defined over an
 *    empty set — while `avg`/`min`/`max`/percentiles come back `null`, because
 *    they are not. An hour with no traffic cost zero dollars; its p95 latency
 *    is not zero, it is unknown.
 *
 * 3. TRUNCATION. If the row limit cut the result, `truncated` is true and
 *    densification is skipped — inventing empty buckets around a truncated
 *    series would draw a chart that is missing data and does not look it.
 *
 * ── Bucketing: width_bucket, not date_trunc ──────────────────────────────────
 *
 * lib/monitors.ts already explains this and the reasoning carries over: the
 * window is an arbitrary `[from, to)`, and `date_trunc` would put its boundary
 * on a clock unit instead of on `from`, producing a short leading bucket whose
 * lower count reads as a dip in throughput rather than as a partial interval.
 * `width_bucket` over epoch seconds anchored at `from` makes every bucket
 * exactly one granularity wide. It is also why granularities are limited to
 * fixed-width ones: a month is not a fixed number of seconds, so a monthly
 * bucket cannot be expressed this way, and expressing it with `date_trunc`
 * would bring back the very artefact this avoids.
 *
 * ── Dimensions the brief lists that are NOT here ─────────────────────────────
 *
 * `agent` and `channel`. Not an oversight and not a shortcut: `sql/facts.sql`
 * documents that eve emits neither — a top-level turn carries no agent name at
 * all, and `$eve.channel_request_id` is an id, not a channel. A dimension that
 * groups every row of every install under one NULL bucket is worse than an
 * absent one, because a chart drawn on it looks like an answer. `trigger` is
 * the honest version of `channel`, and `run_type` separates a subagent from the
 * turn that spawned it, which is the part of `agent` that exists.
 */

/* -------------------------------------------------------------------------- */
/* units                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * What a number means, so the UI formats it without guessing.
 *
 * `duration` is milliseconds, `cost` is USD, `bytes` is bytes, `tokens` is
 * tokens, `count` is a plain cardinal, `percent` is a FRACTION in 0..1 (the
 * same convention `lib/monitors.ts#failureRate` already returns, so the two
 * surfaces cannot disagree about what 0.05 means).
 *
 * `tokens_per_second` is the one unit beyond the brief's list, and it exists
 * because `fact_turn.output_tokens_per_second` exists and is one of Langfuse's
 * preset charts. Calling it a `count` would make the UI render "12" for twelve
 * tokens per second, which is a number lying about what it is.
 */
export const UNITS = [
  "duration",
  "cost",
  "count",
  "percent",
  "bytes",
  "tokens",
  "tokens_per_second",
] as const;
export type Unit = (typeof UNITS)[number];

export const AGGREGATIONS = [
  "count",
  "count_distinct",
  "sum",
  "avg",
  "min",
  "max",
  "p50",
  "p75",
  "p90",
  "p95",
  "p99",
] as const;
export type Aggregation = (typeof AGGREGATIONS)[number];

/** Percentiles are `percentile_cont`, which interpolates and ignores NULLs. */
const PERCENTILE_FRACTION: Readonly<Record<string, number>> = {
  p50: 0.5,
  p75: 0.75,
  p90: 0.9,
  p95: 0.95,
  p99: 0.99,
};

/**
 * Defined over an empty set, so a densified bucket reports 0 rather than null.
 * `avg`, `min`, `max` and the percentiles are not, and report null.
 */
const ZERO_OVER_EMPTY_SET: ReadonlySet<Aggregation> = new Set<Aggregation>([
  "count",
  "count_distinct",
  "sum",
]);

/**
 * Everything a plain numeric column supports: all of them except
 * `count_distinct`, which is a question about identity, not about magnitude.
 * Derived rather than restated so a new aggregation cannot be half-added.
 */
const NUMERIC_AGGREGATIONS: readonly Aggregation[] = AGGREGATIONS.filter(
  (a) => a !== "count_distinct",
);

/**
 * The same list without `sum`. A measure that is already a ratio — tokens per
 * second, milliseconds per chunk — has no meaningful total, and summing one
 * produces a large confident number that means nothing.
 */
const RATIO_AGGREGATIONS: readonly Aggregation[] = NUMERIC_AGGREGATIONS.filter((a) => a !== "sum");

/* -------------------------------------------------------------------------- */
/* the catalog                                                                 */
/* -------------------------------------------------------------------------- */

export interface MeasureDef {
  readonly label: string;
  readonly unit: Unit;
  /** SQL expression over the view's table. Never built from input. */
  readonly sql: string;
  readonly aggregations: readonly Aggregation[];
}

export interface DimensionDef {
  readonly label: string;
  readonly sql: string;
  /**
   * False for fields that are filterable but not groupable. Grouping on a run
   * id produces one row per run, which is a list pretending to be a chart, and
   * at a month of traffic it is a 1,922-row response nobody can read. Langfuse
   * draws the same line for `id`, `traceId`, `userId` and `sessionId`.
   */
  readonly groupable: boolean;
}

export interface ViewDef {
  readonly label: string;
  readonly table: string;
  /** The column `from`/`to` and the bucket are computed on. */
  readonly timeColumn: string;
  readonly measures: Readonly<Record<string, MeasureDef>>;
  readonly dimensions: Readonly<Record<string, DimensionDef>>;
}

/**
 * `failure_rate` restates `lib/monitors.ts`: a turn is failed when it carries an
 * error_code OR finished without ever recording a model call. `sql/facts.sql`
 * folds exactly those two into `outcome`'s first two arms so that this
 * expression, the monitors page and the fact table cannot disagree about the
 * error rate. Averaging a 0/1 gives the fraction, which is what `percent` means.
 */
const TURN_FAILED_SQL = "CASE WHEN outcome IN ('failed', 'no_model_call') THEN 1 ELSE 0 END";

const TURNS: ViewDef = {
  label: "Turns",
  table: "evestack.fact_turn",
  timeColumn: "created_at",
  measures: {
    duration: {
      label: "Turn duration",
      unit: "duration",
      sql: "duration_ms",
      aggregations: NUMERIC_AGGREGATIONS,
    },
    ttft: {
      label: "Time to first chunk",
      unit: "duration",
      sql: "ttft_ms",
      aggregations: NUMERIC_AGGREGATIONS,
    },
    time_per_output_chunk: {
      label: "Time per output chunk",
      unit: "duration",
      sql: "time_per_output_chunk_ms",
      aggregations: RATIO_AGGREGATIONS,
    },
    output_tokens_per_second: {
      label: "Output tokens per second",
      unit: "tokens_per_second",
      sql: "output_tokens_per_second",
      aggregations: RATIO_AGGREGATIONS,
    },
    input_tokens: {
      label: "Input tokens",
      unit: "tokens",
      sql: "input_tokens",
      aggregations: NUMERIC_AGGREGATIONS,
    },
    output_tokens: {
      label: "Output tokens",
      unit: "tokens",
      sql: "output_tokens",
      aggregations: NUMERIC_AGGREGATIONS,
    },
    cache_read_tokens: {
      label: "Cache read tokens",
      unit: "tokens",
      sql: "cache_read_tokens",
      aggregations: NUMERIC_AGGREGATIONS,
    },
    cache_write_tokens: {
      label: "Cache write tokens",
      unit: "tokens",
      sql: "cache_write_tokens",
      aggregations: NUMERIC_AGGREGATIONS,
    },
    // The four cost classes are separate measures rather than one measure with
    // a class dimension because that is how they are stored, and storing them
    // that way was the point: Datadog decomposes spend into non-cached input,
    // output, cache read and cache write, each at its own rate. A stacked cost
    // chart is these four measures on one query.
    cost: { label: "Cost", unit: "cost", sql: "cost_usd", aggregations: NUMERIC_AGGREGATIONS },
    cost_input: {
      label: "Input cost",
      unit: "cost",
      sql: "cost_input_usd",
      aggregations: NUMERIC_AGGREGATIONS,
    },
    cost_output: {
      label: "Output cost",
      unit: "cost",
      sql: "cost_output_usd",
      aggregations: NUMERIC_AGGREGATIONS,
    },
    cost_cache_read: {
      label: "Cache read cost",
      unit: "cost",
      sql: "cost_cache_read_usd",
      aggregations: NUMERIC_AGGREGATIONS,
    },
    cost_cache_write: {
      label: "Cache write cost",
      unit: "cost",
      sql: "cost_cache_write_usd",
      aggregations: NUMERIC_AGGREGATIONS,
    },
    steps: { label: "Steps", unit: "count", sql: "step_count", aggregations: NUMERIC_AGGREGATIONS },
    retries: {
      label: "Retries",
      unit: "count",
      sql: "retry_count",
      aggregations: NUMERIC_AGGREGATIONS,
    },
    // Offered and called are different facts and were one column until W1.
    tools_offered: {
      label: "Tools offered",
      unit: "count",
      sql: "tools_offered",
      aggregations: NUMERIC_AGGREGATIONS,
    },
    tools_called: {
      label: "Tools called",
      unit: "count",
      sql: "tools_called",
      aggregations: NUMERIC_AGGREGATIONS,
    },
    failure_rate: {
      label: "Failure rate",
      unit: "percent",
      sql: TURN_FAILED_SQL,
      aggregations: ["avg"],
    },
    // count_distinct only. `count(session_id)` is how many ROWS carry a
    // session, which under the label "Sessions" would report 1,922 turns as
    // 1,922 sessions when there are 700.
    sessions: {
      label: "Sessions",
      unit: "count",
      sql: "session_id",
      aggregations: ["count_distinct"],
    },
  },
  dimensions: {
    model: { label: "Model", sql: "model", groupable: true },
    provider: { label: "Provider", sql: "provider", groupable: true },
    trigger: { label: "Trigger", sql: "trigger", groupable: true },
    environment: { label: "Environment", sql: "environment", groupable: true },
    outcome: { label: "Outcome", sql: "outcome", groupable: true },
    run_type: { label: "Run type", sql: "run_type", groupable: true },
    finish_reason: { label: "Finish reason", sql: "finish_reason", groupable: true },
    span_coverage: { label: "Span coverage", sql: "span_coverage", groupable: true },
    error_code: { label: "Error code", sql: "error_code", groupable: true },
    session_id: { label: "Session", sql: "session_id", groupable: false },
    run_id: { label: "Run", sql: "run_id", groupable: false },
  },
};

const TOOL_CALLS: ViewDef = {
  label: "Tool calls",
  table: "evestack.fact_tool_call",
  timeColumn: "started_at",
  measures: {
    duration: {
      label: "Tool duration",
      unit: "duration",
      sql: "duration_ms",
      aggregations: NUMERIC_AGGREGATIONS,
    },
    // Recorded only by eve's local tracer; the AI SDK's exported spans carry no
    // `gen_ai.tool.call.*`, so on a deployed install these are NULL on every
    // row. That is what the coverage block is for — the response reports
    // `rows: 0 of 838` rather than an average of nothing.
    arguments_bytes: {
      label: "Argument size",
      unit: "bytes",
      sql: "arguments_bytes",
      aggregations: NUMERIC_AGGREGATIONS,
    },
    result_bytes: {
      label: "Result size",
      unit: "bytes",
      sql: "result_bytes",
      aggregations: NUMERIC_AGGREGATIONS,
    },
    failure_rate: {
      label: "Tool failure rate",
      unit: "percent",
      sql: "CASE WHEN ok THEN 0 ELSE 1 END",
      aggregations: ["avg"],
    },
    // count_distinct only. `count(session_id)` is how many ROWS carry a
    // session, which under the label "Sessions" would report 1,922 turns as
    // 1,922 sessions when there are 700.
    sessions: {
      label: "Sessions",
      unit: "count",
      sql: "session_id",
      aggregations: ["count_distinct"],
    },
  },
  dimensions: {
    tool: { label: "Tool", sql: "tool_name", groupable: true },
    status: { label: "Status", sql: "CASE WHEN ok THEN 'ok' ELSE 'failed' END", groupable: true },
    session_id: { label: "Session", sql: "session_id", groupable: false },
    run_id: { label: "Run", sql: "run_id", groupable: false },
  },
};

/** Every view the query endpoint will serve. Adding a chart never edits this. */
export const CATALOG: Readonly<Record<string, ViewDef>> = {
  turns: TURNS,
  tool_calls: TOOL_CALLS,
};

/* -------------------------------------------------------------------------- */
/* granularity                                                                 */
/* -------------------------------------------------------------------------- */

export type Granularity = "minute" | "hour" | "day" | "week";

/**
 * Fixed-width only, in milliseconds. See the header: `width_bucket` needs a
 * constant width, and a month does not have one.
 */
const GRANULARITY_MS: Readonly<Record<Granularity, number>> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
};

/**
 * Ceiling on buckets in one response. A minute granularity over the seeded
 * 30-day month is 43,200 buckets — a request that would either be truncated or
 * would return more points than a chart has pixels. Refusing with a message
 * that names both numbers is more useful than either.
 */
const MAX_BUCKETS = 500;

/**
 * `auto` picks the finest granularity that stays under this many points, so a
 * chart has detail without having more points than pixels. W3's drag-to-select
 * zoom produces arbitrary windows, and asking the caller to recompute a
 * granularity per drag is how a 12-hour selection ends up drawn at daily
 * resolution.
 */
const AUTO_TARGET_BUCKETS = 60;

/** The finest granularity that keeps the series under the target, else the
 * coarsest one there is. A window so long that even weekly buckets exceed
 * MAX_BUCKETS is rejected below, by the check every granularity goes through,
 * rather than by a second rule here. */
function autoGranularity(spanMs: number): Granularity {
  const order: Granularity[] = ["minute", "hour", "day", "week"];
  return order.find((g) => spanMs / GRANULARITY_MS[g] <= AUTO_TARGET_BUCKETS) ?? "week";
}

/* -------------------------------------------------------------------------- */
/* request shape                                                               */
/* -------------------------------------------------------------------------- */

export type FilterOperator =
  | "eq"
  | "ne"
  | "in"
  | "not_in"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "is_null"
  | "is_not_null";

/*
 * There are deliberately no interfaces for the REQUEST here.
 *
 * The body arrives as `unknown` over HTTP and every field is validated at
 * runtime against the catalog, so a compile-time mirror of the same shape would
 * be read by nothing and enforce nothing — it would only be a second, silently
 * drifting description of what the validation below already states, with better
 * error messages. The shape is in this file's header, and every rejection names
 * the field and lists the values that would have worked.
 */

/** Thrown for anything the caller can fix. The route answers 400. */
export class MetricQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetricQueryError";
  }
}

/* -------------------------------------------------------------------------- */
/* compiled form                                                               */
/* -------------------------------------------------------------------------- */

export interface CompiledMeasure {
  /** The key this measure's value appears under in every data row. */
  readonly key: string;
  readonly measure: string;
  readonly aggregation: Aggregation;
  readonly unit: Unit;
  readonly label: string;
}

export interface CompiledDimension {
  readonly key: string;
  readonly label: string;
}

export interface QueryMeta {
  readonly view: string;
  /** Inclusive. */
  readonly from: string;
  /** Exclusive — `[from, to)`, so two adjacent windows share no row. */
  readonly to: string;
  readonly granularity: Granularity | null;
  readonly buckets: number | null;
  readonly measures: readonly CompiledMeasure[];
  readonly dimensions: readonly CompiledDimension[];
  readonly limit: number;
}

export interface CompiledQuery {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly meta: QueryMeta;
}

/* -------------------------------------------------------------------------- */
/* result shape                                                                */
/* -------------------------------------------------------------------------- */

export interface MetricRow {
  /** Bucket start, ISO. Present only when a granularity was requested. */
  readonly time?: string;
  /** Rows in this group. 0 means the bucket was densified — no data, not zero. */
  readonly rows: number;
  /** How many rows contributed to each measure, keyed the same as the values. */
  readonly coverage: Readonly<Record<string, number>>;
  /** Dimension values (may be null) and measure values (may be null). */
  readonly [key: string]: unknown;
}

export interface MeasureCoverage {
  /** Rows that contributed a non-null value. */
  readonly rows: number;
  /** Rows that matched the query. */
  readonly of: number;
}

export interface MetricResult {
  readonly meta: QueryMeta;
  readonly data: readonly MetricRow[];
  readonly coverage: {
    readonly matchedRows: number;
    readonly byMeasure: Readonly<Record<string, MeasureCoverage>>;
  };
  /** True when the limit cut rows. Densification is skipped when it is. */
  readonly truncated: boolean;
}

/* -------------------------------------------------------------------------- */
/* validation helpers                                                          */
/* -------------------------------------------------------------------------- */

const known = (names: Iterable<string>): string => [...names].sort().join(", ");

/**
 * Every catalog lookup goes through this, and the reason is `constructor`.
 *
 * A request naming an inherited property finds one: `CATALOG["constructor"]` is
 * Object's constructor and is truthy, so a plain `[]` lookup accepts it as a
 * view and then throws a TypeError two lines later reading `.dimensions` off a
 * function — a 500 that reads as "the server is broken" for what is a typo.
 * `"toString" in GRANULARITY_MS` is worse: it is true, the granularity resolves
 * to a function, the bucket count becomes NaN, and NaN fails no bound. Nothing
 * here is an injection — no name reaches SQL either way — but a 400 that names
 * the mistake is the whole difference between a caller fixing it and a caller
 * filing a bug.
 */
function lookup<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MetricQueryError(`Expected '${what}' to be an object.`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, what: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new MetricQueryError(`Expected '${what}' to be an array.`);
  return value;
}

function asString(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new MetricQueryError(`Expected '${what}' to be a non-empty string.`);
  }
  return value;
}

/** `Z`, `+00:00`, `-0800`. Anything that pins the string to an instant. */
const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * Parse a window bound, and refuse one that does not carry a zone.
 *
 * `Date.parse("2026-08-06T12:00:00")` — no `Z` — is resolved in the HOST's
 * zone, so the same request would select a different eight hours depending on
 * where the container runs. That is the bug `lib/fleet.ts` and `lib/db.ts` both
 * document from the other direction, and here it would move a chart's window
 * silently. `toISOString()` always emits the `Z`, so nothing that should work
 * is refused.
 */
function parseInstant(value: unknown, what: string): number {
  const text = asString(value, what);
  if (!HAS_OFFSET.test(text)) {
    throw new MetricQueryError(
      `'${what}' must carry a UTC offset (…Z or …+01:00): ${JSON.stringify(text)}. Without one ` +
        "the window would be resolved in whatever zone the server happens to run in.",
    );
  }
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) {
    throw new MetricQueryError(`'${what}' is not a parseable timestamp: ${JSON.stringify(text)}.`);
  }
  return ms;
}

/** Default window. The same 24 hours lib/monitors.ts opens on. */
const DEFAULT_WINDOW_MS = 24 * 3_600_000;

const DEFAULT_LIMIT = 1_000;

/**
 * Deliberately above Langfuse's 1,000. Theirs bounds a hosted multi-tenant API;
 * this reads a Postgres on the same machine, and a silently short chart costs
 * more than a large JSON body. The limit still exists because a truncated
 * response has to be able to say so.
 */
const MAX_LIMIT = 5_000;

/* -------------------------------------------------------------------------- */
/* compile                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Validate a request against the catalog and build its SQL.
 *
 * Pure and exported so the injection surface can be tested without a database:
 * every identifier in the returned SQL came from the catalog, and every value
 * the caller supplied is in `params`.
 */
export function compileMetricQuery(input: unknown, now = Date.now()): CompiledQuery {
  const body = asObject(input, "body");

  const viewName = asString(body.view, "view");
  const view = lookup(CATALOG, viewName);
  if (!view) {
    throw new MetricQueryError(
      `Unknown view ${JSON.stringify(viewName)}. Known views: ${known(Object.keys(CATALOG))}.`,
    );
  }

  /* ── window and bucketing ─────────────────────────────────────────────── */

  const time = body.timeDimension === undefined || body.timeDimension === null
    ? {}
    : asObject(body.timeDimension, "timeDimension");

  const toMs = time.to === undefined ? now : parseInstant(time.to, "timeDimension.to");
  const fromMs =
    time.from === undefined ? toMs - DEFAULT_WINDOW_MS : parseInstant(time.from, "timeDimension.from");
  if (!(fromMs < toMs)) {
    throw new MetricQueryError("'timeDimension.from' must be earlier than 'timeDimension.to'.");
  }

  let granularity: Granularity | null = null;
  if (time.granularity !== undefined && time.granularity !== null) {
    const g = asString(time.granularity, "timeDimension.granularity");
    if (g === "auto") {
      granularity = autoGranularity(toMs - fromMs);
    } else if (Object.hasOwn(GRANULARITY_MS, g)) {
      granularity = g as Granularity;
    } else {
      throw new MetricQueryError(
        `Unknown granularity ${JSON.stringify(g)}. Known granularities: auto, ` +
          `${known(Object.keys(GRANULARITY_MS))}. Month is absent on purpose: it is not a ` +
          "fixed number of seconds, and every bucket here is.",
      );
    }
  }

  const granularityMs = granularity === null ? null : GRANULARITY_MS[granularity];
  const buckets = granularityMs === null ? null : Math.ceil((toMs - fromMs) / granularityMs);
  if (buckets !== null && buckets > MAX_BUCKETS) {
    throw new MetricQueryError(
      `That window at '${granularity}' granularity is ${buckets} buckets; the maximum is ` +
        `${MAX_BUCKETS}. Use a coarser granularity or 'auto'.`,
    );
  }

  /* ── dimensions ───────────────────────────────────────────────────────── */

  const dimensionNames = asArray(body.dimensions, "dimensions").map((d, i) =>
    asString(d, `dimensions[${i}]`),
  );
  /**
   * "A list, not a chart" — said explicitly, so the catalog can keep refusing it
   * everywhere else.
   *
   * `session_id` and `run_id` are `groupable: false` in both views to stop
   * anyone putting a hundred thousand distinct values on a chart axis. That is
   * the right default and the wrong answer for a top-N list, which is exactly
   * the shape `ranked()` builds — and /costs asked for the ten most expensive
   * SESSIONS. The compile threw, `ranked`'s caller swallowed it, and the panel
   * rendered "Nothing to rank" on every install since it shipped.
   *
   * An opt-in rather than making the dimension groupable: a caller that wants a
   * bounded ordered list says so, and a caller that forgets still cannot put
   * session_id on an axis. `ranked()` is the only thing that sets it.
   */
  const topN = body.topN === true;
  const dimensions: CompiledDimension[] = [];
  // key -> the catalog SQL it resolved to, so nothing below has to look it up
  // again with a non-null assertion.
  const dimensionSql = new Map<string, string>();
  const seenDimension = new Set<string>();
  for (const name of dimensionNames) {
    const def = lookup(view.dimensions, name);
    if (!def) {
      throw new MetricQueryError(
        `Unknown dimension ${JSON.stringify(name)} on view '${viewName}'. Groupable ` +
          `dimensions: ${known(
            Object.entries(view.dimensions)
              .filter(([, d]) => d.groupable)
              .map(([k]) => k),
          )}.`,
      );
    }
    if (!def.groupable && !topN) {
      throw new MetricQueryError(
        `Dimension '${name}' is filterable but not groupable — it has one value per row, so ` +
          "grouping on it returns a list, not a chart. Pass topN:true if a list is what you want.",
      );
    }
    if (seenDimension.has(name)) {
      throw new MetricQueryError(`Dimension '${name}' is listed twice.`);
    }
    seenDimension.add(name);
    dimensionSql.set(name, def.sql);
    dimensions.push({ key: name, label: def.label });
  }

  /* ── measures ─────────────────────────────────────────────────────────── */

  const measures: CompiledMeasure[] = [];
  const measureSql = new Map<string, string>();
  const seenMeasure = new Set<string>();
  for (const [i, raw] of asArray(body.measures, "measures").entries()) {
    const entry = asObject(raw, `measures[${i}]`);
    const name = asString(entry.measure, `measures[${i}].measure`);
    const def = lookup(view.measures, name);
    if (!def) {
      throw new MetricQueryError(
        `Unknown measure ${JSON.stringify(name)} on view '${viewName}'. Known measures: ` +
          `${known(Object.keys(view.measures))}.`,
      );
    }
    const aggregation = asString(entry.aggregation, `measures[${i}].aggregation`) as Aggregation;
    if (!def.aggregations.includes(aggregation)) {
      throw new MetricQueryError(
        `Measure '${name}' does not support '${aggregation}'. Supported: ` +
          `${known(def.aggregations)}.`,
      );
    }
    const key = `${aggregation}_${name}`;
    if (seenMeasure.has(key)) throw new MetricQueryError(`Measure '${key}' is requested twice.`);
    seenMeasure.add(key);
    measureSql.set(name, def.sql);
    // The AGGREGATION decides the unit, not only the measure. `count` answers
    // "how many rows", which is a count whatever it counted — carrying the
    // measure's unit through would make `count(cost)` claim to be dollars and
    // the shipped formatter would render five rows as "$5.00". `count` is
    // offered on 17 of the 24 measures, so this is not an edge. The same
    // applies to `count_distinct`. Every other aggregation (sum, avg, min, max,
    // the percentiles) returns a value in the measure's own unit and keeps it.
    const unit = aggregation === "count" || aggregation === "count_distinct" ? "count" : def.unit;
    measures.push({ key, measure: name, aggregation, unit, label: def.label });
  }

  /* ── SQL ──────────────────────────────────────────────────────────────── */

  const params: unknown[] = [];
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  const select: string[] = [];
  const groupBy: string[] = [];

  if (granularityMs !== null && buckets !== null) {
    const lo = fromMs / 1000;
    const hi = lo + (buckets * granularityMs) / 1000;
    select.push(
      `width_bucket(extract(epoch from ${view.timeColumn})::double precision, ` +
        `${bind(lo)}::double precision, ${bind(hi)}::double precision, ${bind(buckets)}::int) AS bucket`,
    );
    groupBy.push("bucket");
  }

  for (const dimension of dimensions) {
    const alias = `d_${dimension.key}`;
    select.push(`${dimensionSql.get(dimension.key)!} AS "${alias}"`);
    groupBy.push(`"${alias}"`);
  }

  // On every row, always. It is the group's row count, the denominator every
  // coverage number is stated against, and the only thing that tells a
  // densified bucket (0) apart from a bucket whose measures happen to be zero.
  select.push('count(*) AS "rows"');

  for (const measure of measures) {
    const expr = measureSql.get(measure.measure)!;
    select.push(`${aggregateSql(measure.aggregation, expr)} AS "m_${measure.key}"`);
    // The coverage column. `count(expr)` counts non-NULL inputs, which is
    // exactly "how many rows had this value" — the number that separates a p95
    // over 370 turns from a p95 over 1,922.
    select.push(`count(${expr}) AS "c_${measure.key}"`);
  }

  const where: string[] = [
    `${view.timeColumn} >= ${bind(new Date(fromMs).toISOString())}::timestamptz`,
    `${view.timeColumn} < ${bind(new Date(toMs).toISOString())}::timestamptz`,
  ];
  for (const [i, raw] of asArray(body.filters, "filters").entries()) {
    where.push(compileFilter(view, asObject(raw, `filters[${i}]`), i, bind));
  }

  /* ── order ────────────────────────────────────────────────────────────── */

  const orderBy = compileOrderBy(body.orderBy, { measures, dimensions, bucketed: granularity !== null });

  const limitRaw = body.limit;
  let limit = DEFAULT_LIMIT;
  if (limitRaw !== undefined && limitRaw !== null) {
    if (typeof limitRaw !== "number" || !Number.isInteger(limitRaw) || limitRaw < 1) {
      throw new MetricQueryError("'limit' must be a positive integer.");
    }
    if (limitRaw > MAX_LIMIT) {
      throw new MetricQueryError(`'limit' must be at most ${MAX_LIMIT}.`);
    }
    limit = limitRaw;
  }

  // One row past the limit, so the response can distinguish "this is all of it"
  // from "there was more". Nothing else can tell those apart after the fact.
  const sql =
    `SELECT ${select.join(", ")}\n` +
    `  FROM ${view.table}\n` +
    ` WHERE ${where.join("\n   AND ")}\n` +
    (groupBy.length > 0 ? ` GROUP BY ${groupBy.join(", ")}\n` : "") +
    ` ORDER BY ${orderBy.join(", ")}\n` +
    ` LIMIT ${bind(limit + 1)}`;

  return {
    sql,
    params,
    meta: {
      view: viewName,
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      granularity,
      buckets,
      measures,
      dimensions,
      limit,
    },
  };
}

/*
 * `shapeMetricRows` writes `time`, `rows` and `coverage` into every data row,
 * and each measure under `<aggregation>_<measure>`. A dimension named one of
 * those would silently overwrite it in the JSON — but it cannot happen from a
 * request, because both sides come from the catalog, so there is no runtime
 * guard for it here: a branch nothing can reach is worse than no branch.
 * `test/metrics.test.mjs` asserts it instead, over every view at once, and
 * reads the reserved names out of an actual response rather than from a list
 * that could drift from the one below.
 */

function aggregateSql(aggregation: Aggregation, expr: string): string {
  if (aggregation === "count") return `count(${expr})`;
  if (aggregation === "count_distinct") return `count(DISTINCT ${expr})`;
  const fraction = PERCENTILE_FRACTION[aggregation];
  if (fraction !== undefined) {
    // No cast to double precision here, though `percentile_cont` is declared on
    // it. Every measure this can reach is numeric, bigint, integer or double,
    // and Postgres casts all four implicitly — measured against
    // `numeric(20,10)` cost_usd, which resolves and returns the same value. An
    // explicit cast would only add reach: it would let a TEXT expression into
    // the aggregate, where it would parse row by row and fail on the first row
    // that is not a number, instead of being refused outright.
    return `percentile_cont(${fraction}) WITHIN GROUP (ORDER BY ${expr})`;
  }
  return `${aggregation}(${expr})`;
}

const TEXT_OPERATORS: ReadonlySet<FilterOperator> = new Set<FilterOperator>([
  "eq",
  "ne",
  "in",
  "not_in",
  "is_null",
  "is_not_null",
]);

const NUMERIC_OPERATORS: ReadonlySet<FilterOperator> = new Set<FilterOperator>([
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "is_null",
  "is_not_null",
]);

const COMPARISON: Readonly<Record<string, string>> = {
  eq: "=",
  ne: "<>",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

/**
 * A filter names a dimension (text) or a measure (numeric). Measure filters
 * apply to rows before aggregation, which is the useful half of it: "p95
 * duration of the turns that cost more than a cent" is a WHERE, not a HAVING.
 */
function compileFilter(
  view: ViewDef,
  raw: Record<string, unknown>,
  index: number,
  bind: (value: unknown) => string,
): string {
  const field = asString(raw.field, `filters[${index}].field`);
  const dimension = lookup(view.dimensions, field);
  const measure = lookup(view.measures, field);
  if (!dimension && !measure) {
    throw new MetricQueryError(
      `Unknown filter field ${JSON.stringify(field)} on view '${view.label}'. Filterable: ` +
        `${known([...Object.keys(view.dimensions), ...Object.keys(view.measures)])}.`,
    );
  }
  const expr = dimension ? dimension.sql : measure!.sql;
  /**
   * Whether the underlying COLUMN is numeric, not whether the field is a
   * measure. `sessions` is a measure whose `sql` is `session_id`, a text column
   * it only ever `count_distinct`s — asking for `sessions > 5` used to compile
   * to `session_id > $3::double precision` and come back as a 500 carrying a
   * raw driver message, which is exactly the class of failure the route layer
   * separates 400s from.
   *
   * A measure supporting only `count_distinct` is a question about identity,
   * not magnitude, so it takes the text operators. Derived from the declared
   * aggregations rather than a new flag on all 24 measures, because a flag can
   * disagree with the aggregations and this cannot.
   */
  const numeric =
    !dimension && measure!.aggregations.some((a) => NUMERIC_AGGREGATIONS.includes(a));
  const allowed = numeric ? NUMERIC_OPERATORS : TEXT_OPERATORS;

  const operator = asString(raw.operator, `filters[${index}].operator`) as FilterOperator;
  if (!allowed.has(operator)) {
    throw new MetricQueryError(
      `Operator '${operator}' is not available on ${
        numeric ? "numeric measure" : dimension ? "dimension" : "non-numeric measure"
      } '${field}'. Available: ${known(allowed)}.`,
    );
  }

  if (operator === "is_null") return `${expr} IS NULL`;
  if (operator === "is_not_null") return `${expr} IS NOT NULL`;

  const value = raw.value;
  if (operator === "in" || operator === "not_in") {
    if (!Array.isArray(value) || value.length === 0) {
      throw new MetricQueryError(`'${operator}' on '${field}' needs a non-empty array value.`);
    }
    const items = value.map((v, i) => asString(v, `filters[${index}].value[${i}]`));
    const test = `${expr} = ANY(${bind(items)}::text[])`;
    // `NOT (NULL = ANY(...))` is NULL, not true, so plain negation silently drops
    // every row whose dimension is absent. Same reason as `ne` just below.
    return operator === "in" ? test : `(${expr} IS NULL OR NOT (${test}))`;
  }

  /**
   * `ne` compiles to `IS DISTINCT FROM`, not `<>`.
   *
   * Three-valued logic makes `NULL <> 'x'` evaluate to NULL, so a WHERE built on
   * `<>` excludes the row entirely. "Every model except acme" therefore returned
   * 1,651 of the seeded month's 1,713 non-acme turns and silently lost the 62
   * that never called a model — which is the population an error-rate question
   * most wants, since a turn with no model is usually a turn that failed to
   * reach one. Nothing in the response distinguished 1,651-of-1,651 from
   * 1,651-of-1,713.
   *
   * That is correct SQL and the wrong answer for this catalog, whose stated rule
   * — and `components/ui/table-filter`'s behaviour — is that an absent value is
   * its own bucket, not a row that quietly stops existing. `IS DISTINCT FROM`
   * treats NULL as a value differing from every non-null one, which is what
   * "not X" means to someone reading a chart.
   */
  const comparison = operator === "ne" ? "IS DISTINCT FROM" : COMPARISON[operator];

  if (numeric) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new MetricQueryError(`'${operator}' on measure '${field}' needs a finite number.`);
    }
    return `${expr} ${comparison} ${bind(value)}::double precision`;
  }
  return `${expr} ${comparison} ${bind(asString(value, `filters[${index}].value`))}::text`;
}

/**
 * Ordering, and the one restriction worth explaining.
 *
 * With a timeDimension, ordering by a MEASURE is refused. It reads like "top
 * models by cost over time" and it is not: the sort would rank BUCKETS, so a
 * limit would keep the highest-spending hours of unrelated series and drop the
 * rest of each line — a chart with holes that does not look like it has holes.
 * The two-call shape Langfuse's own UI uses is the honest one: rank without a
 * timeDimension, then chart the winners with a filter.
 */
function compileOrderBy(
  raw: unknown,
  ctx: {
    measures: readonly CompiledMeasure[];
    dimensions: readonly CompiledDimension[];
    bucketed: boolean;
  },
): string[] {
  const entries = asArray(raw, "orderBy");
  const measureKeys = new Set(ctx.measures.map((m) => m.key));
  const dimensionKeys = new Set(ctx.dimensions.map((d) => d.key));

  const clauses: string[] = [];
  for (const [i, item] of entries.entries()) {
    const entry = asObject(item, `orderBy[${i}]`);
    const field = asString(entry.field, `orderBy[${i}].field`);
    const direction = entry.direction === undefined ? "desc" : asString(entry.direction, `orderBy[${i}].direction`);
    if (direction !== "asc" && direction !== "desc") {
      throw new MetricQueryError(`'orderBy[${i}].direction' must be 'asc' or 'desc'.`);
    }
    // NULLS LAST in both directions. Postgres defaults DESC to NULLS FIRST, so
    // a top list by p95 would open with the groups that have no p95 at all.
    const suffix = `${direction.toUpperCase()} NULLS LAST`;

    if (field === "time") {
      if (!ctx.bucketed) {
        throw new MetricQueryError("Cannot order by 'time' without a timeDimension granularity.");
      }
      clauses.push(`bucket ${suffix}`);
    } else if (field === "rows") {
      clauses.push(`"rows" ${suffix}`);
    } else if (measureKeys.has(field)) {
      if (ctx.bucketed) {
        throw new MetricQueryError(
          `Cannot order a bucketed query by measure '${field}': the sort would rank buckets, ` +
            "not series. Drop 'timeDimension.granularity' to rank, then chart the result with " +
            "a filter.",
        );
      }
      clauses.push(`"m_${field}" ${suffix}`);
    } else if (dimensionKeys.has(field)) {
      clauses.push(`"d_${field}" ${suffix}`);
    } else {
      throw new MetricQueryError(
        `Cannot order by ${JSON.stringify(field)} — it is not selected. Orderable: ` +
          `${known(["rows", ...(ctx.bucketed ? ["time"] : []), ...measureKeys, ...dimensionKeys])}.`,
      );
    }
  }

  if (ctx.bucketed) {
    // Series-major output: every dimension first, then time within the series.
    // Densification then walks each series once, and a caller reading the rows
    // in order sees whole lines rather than interleaved points.
    //
    // Matched on the COLUMN rather than on the whole clause, and the caller's
    // direction wins. Comparing whole clauses would add `"d_model" ASC` in
    // front of the `"d_model" DESC` the caller asked for — legal SQL, and the
    // request silently ignored.
    const ordered = new Set(clauses.map((clause) => clause.slice(0, clause.indexOf(" "))));
    // Reversed, because each unshift goes in front of the last: without it the
    // series would sort by the LAST dimension named rather than the first.
    for (const dimension of [...ctx.dimensions].reverse()) {
      const column = `"d_${dimension.key}"`;
      if (!ordered.has(column)) {
        clauses.unshift(`${column} ASC NULLS LAST`);
        ordered.add(column);
      }
    }
    if (!ordered.has("bucket")) clauses.push("bucket ASC NULLS LAST");
    return clauses;
  }

  return clauses.length > 0 ? clauses : ['"rows" DESC NULLS LAST'];
}

/* -------------------------------------------------------------------------- */
/* shaping                                                                     */
/* -------------------------------------------------------------------------- */

const toNumber = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const toCount = (value: unknown): number => toNumber(value) ?? 0;

/**
 * Turn raw rows into the response, densifying and computing coverage.
 *
 * Separated from the query and exported so the parts that are easy to get
 * silently wrong — the empty-bucket values, the coverage arithmetic, the
 * truncation rule — are unit-testable without a database.
 */
export function shapeMetricRows(raw: readonly Record<string, unknown>[], compiled: CompiledQuery): MetricResult {
  const { meta } = compiled;
  // Both derived rather than carried on the compiled query: bucket 1 starts at
  // `from` by construction, and a second copy of either is a second thing that
  // can drift from the SQL's own bounds.
  const bucketOriginMs = Date.parse(meta.from);
  const granularityMs = meta.granularity === null ? null : GRANULARITY_MS[meta.granularity];
  const truncated = raw.length > meta.limit;
  const rows = truncated ? raw.slice(0, meta.limit) : raw;

  /**
   * `source` is null for a densified bucket. `labels` carries that series'
   * dimension values, which an empty bucket still belongs to — emitting nulls
   * there would split one line into two.
   */
  const emit = (
    source: Record<string, unknown> | null,
    bucket: number | null,
    labels: Record<string, unknown> | null = source,
  ): MetricRow => {
    const out: Record<string, unknown> = {};
    if (bucket !== null && granularityMs !== null && bucketOriginMs !== null) {
      out.time = new Date(bucketOriginMs + (bucket - 1) * granularityMs).toISOString();
    }
    for (const dimension of meta.dimensions) {
      out[dimension.key] = labels === null ? null : (labels[`d_${dimension.key}`] ?? null);
    }
    out.rows = source === null ? 0 : toCount(source.rows);
    const coverage: Record<string, number> = {};
    for (const measure of meta.measures) {
      if (source === null) {
        // An empty bucket. `count`, `count_distinct` and `sum` are defined over
        // an empty set and are 0; an average or a percentile of nothing is not
        // zero, it is unknown.
        out[measure.key] = ZERO_OVER_EMPTY_SET.has(measure.aggregation) ? 0 : null;
        coverage[measure.key] = 0;
      } else {
        out[measure.key] = toNumber(source[`m_${measure.key}`]);
        coverage[measure.key] = toCount(source[`c_${measure.key}`]);
      }
    }
    out.coverage = coverage;
    return out as MetricRow;
  };

  let data: MetricRow[];
  if (meta.granularity === null || meta.buckets === null || truncated) {
    // No bucketing to densify, or a truncated result where densifying would
    // manufacture empty buckets around data that was cut rather than absent.
    data = rows.map((row) => emit(row, meta.granularity === null ? null : toCount(row.bucket)));
  } else {
    data = [];
    // Series in the order SQL returned them, which compileOrderBy made
    // series-major on purpose.
    const seriesOrder: string[] = [];
    const bySeries = new Map<string, Map<number, Record<string, unknown>>>();
    for (const row of rows) {
      const key = meta.dimensions.map((d) => String(row[`d_${d.key}`] ?? "\u0000")).join("\u0001");
      let series = bySeries.get(key);
      if (!series) {
        series = new Map();
        bySeries.set(key, series);
        seriesOrder.push(key);
      }
      series.set(toCount(row.bucket), row);
    }
    if (seriesOrder.length === 0) seriesOrder.push("");
    for (const key of seriesOrder) {
      const series = bySeries.get(key) ?? new Map<number, Record<string, unknown>>();
      // A densified row still has to carry its series' dimension values, so
      // take them from any row of the series rather than emitting nulls.
      const sample = series.values().next().value ?? null;
      for (let bucket = 1; bucket <= meta.buckets; bucket += 1) {
        const row = series.get(bucket);
        data.push(row ? emit(row, bucket) : emit(null, bucket, sample));
      }
    }
  }

  // Coverage is summed over the rows the DATABASE returned, not over the
  // densified ones — an invented empty bucket contributes nothing to either
  // side of "370 of 1,922", and counting it would inflate the denominator with
  // rows that do not exist. When `truncated`, both numbers are therefore about
  // the rows that came back, which is why the flag is part of the response.
  let matchedRows = 0;
  const contributed = new Map(meta.measures.map((measure) => [measure.key, 0]));
  for (const row of rows) {
    matchedRows += toCount(row.rows);
    for (const measure of meta.measures) {
      contributed.set(
        measure.key,
        contributed.get(measure.key)! + toCount(row[`c_${measure.key}`]),
      );
    }
  }
  const byMeasure: Record<string, MeasureCoverage> = {};
  for (const [key, contributedRows] of contributed) {
    byMeasure[key] = { rows: contributedRows, of: matchedRows };
  }

  return { meta, data, coverage: { matchedRows, byMeasure }, truncated };
}

/* -------------------------------------------------------------------------- */
/* execution                                                                   */
/* -------------------------------------------------------------------------- */

let refreshInFlight: Promise<unknown> | null = null;

/**
 * Bring the fact tables up to date, once, however many charts asked at once.
 *
 * A dashboard page is several of these queries in parallel, and without the
 * coalescing each one would run the same upsert over the same rows in its own
 * transaction — wasted work at best and lock contention at worst. There is no
 * TTL on top of it: a no-op refresh over the seeded month is ~20ms, and a
 * staleness window would be a second thing to be wrong about.
 */
export function freshFacts(): Promise<unknown> {
  if (!refreshInFlight) {
    refreshInFlight = refreshFacts().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/** Compile, refresh, run, shape. The endpoint is this function plus HTTP. */
export async function runMetricQuery(input: unknown, now = Date.now()): Promise<MetricResult> {
  const compiled = compileMetricQuery(input, now);
  await freshFacts();
  const rows = await query<Record<string, unknown>>(compiled.sql, compiled.params);
  return shapeMetricRows(rows, compiled);
}
