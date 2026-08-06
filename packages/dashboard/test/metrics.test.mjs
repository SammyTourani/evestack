/**
 * lib/metrics.ts — the parts that are arithmetic, validation and shape.
 *
 * Everything this module claims about PostgreSQL — that the SQL it writes is
 * valid, that every catalog column exists, that the buckets add back up to the
 * rows, that a hostile string arrives as a parameter rather than as SQL — is
 * asserted against a real server by
 * `contract/runtime/probes/08-metric-query.probe.mjs`, because a JavaScript
 * test could only restate it. What is here is the half that is decidable
 * without a database, and it is the half where a mistake is invisible:
 *
 * THE INJECTION SURFACE. Every identifier in the emitted SQL has to have come
 * from the catalog. `compileMetricQuery` is pure, so the tests below can take
 * the SQL apart and prove that a measure name, dimension, operator or order
 * field the caller invented never reaches it, and that a filter VALUE reaches
 * the parameter array instead.
 *
 * THE EMPTY BUCKET. `count`, `count_distinct` and `sum` over no rows are zero;
 * an average or a percentile over no rows is unknown. Getting that backwards
 * draws an hour of silence as a p95 of zero, which is the single most flattering
 * lie a latency chart can tell.
 *
 * THE COVERAGE ARITHMETIC. A response says how many rows fed each measure.
 * Off-by-one there does not fail; it reports 3% of the fleet as the fleet.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AGGREGATIONS,
  CATALOG,
  MetricQueryError,
  UNITS,
  compileMetricQuery,
  shapeMetricRows,
} from "../lib/metrics.ts";

/** A fixed instant, so a default window is assertable. */
const NOW = Date.parse("2026-08-06T12:00:00.000Z");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const compile = (body) => compileMetricQuery(body, NOW);

const rejects = (body, fragment) => {
  assert.throws(
    () => compile(body),
    (error) => {
      assert.ok(
        error instanceof MetricQueryError,
        `expected a MetricQueryError, got ${error?.name}: ${error?.message}`,
      );
      assert.match(error.message, fragment);
      return true;
    },
    `expected ${JSON.stringify(body)} to be refused`,
  );
};

/* -------------------------------------------------------------------------- */
/* the catalog is the whole contract                                           */
/* -------------------------------------------------------------------------- */

test("every measure declares a known unit and known aggregations", () => {
  for (const [viewName, view] of Object.entries(CATALOG)) {
    for (const [name, measure] of Object.entries(view.measures)) {
      assert.ok(UNITS.includes(measure.unit), `${viewName}.${name} unit ${measure.unit}`);
      assert.ok(measure.aggregations.length > 0, `${viewName}.${name} allows nothing`);
      for (const aggregation of measure.aggregations) {
        assert.ok(
          AGGREGATIONS.includes(aggregation),
          `${viewName}.${name} allows unknown aggregation ${aggregation}`,
        );
      }
    }
  }
});

test("every declared unit is used by something", () => {
  // A unit nothing carries is a formatting rule the UI would implement for no
  // data — the "code that does nothing" shape, in the one place where it looks
  // like thoroughness.
  const used = new Set();
  for (const view of Object.values(CATALOG)) {
    for (const measure of Object.values(view.measures)) used.add(measure.unit);
  }
  assert.deepEqual([...UNITS].filter((u) => !used.has(u)), []);
});

test("every declared aggregation compiles to real SQL", () => {
  // AGGREGATIONS drives what NUMERIC_AGGREGATIONS offers, so adding a name to
  // it without teaching `aggregateSql` about it would emit `foo(duration_ms)`
  // and fail at the database rather than here.
  const expected = {
    count: "count(duration_ms)",
    count_distinct: "count(DISTINCT session_id)",
    sum: "sum(duration_ms)",
    avg: "avg(duration_ms)",
    min: "min(duration_ms)",
    max: "max(duration_ms)",
    p50: "percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)",
    p75: "percentile_cont(0.75) WITHIN GROUP (ORDER BY duration_ms)",
    p90: "percentile_cont(0.9) WITHIN GROUP (ORDER BY duration_ms)",
    p95: "percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)",
    p99: "percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms)",
  };
  for (const aggregation of AGGREGATIONS) {
    const measure = aggregation === "count_distinct" ? "sessions" : "duration";
    const { sql } = compile({ view: "turns", measures: [{ measure, aggregation }] });
    assert.ok(
      sql.includes(expected[aggregation]),
      `${aggregation} emitted:\n${sql}\nexpected to contain ${expected[aggregation]}`,
    );
  }
});

test("no dimension can shadow a key the response already uses", () => {
  // A dimension named `time`, `rows`, `coverage` or `<aggregation>_<measure>`
  // would overwrite that key in the JSON and nothing would raise. There is no
  // runtime guard for it because both sides come from the catalog — this is
  // where it is enforced. The reserved names are read out of a real response
  // rather than written down again, so they cannot drift from what shaping
  // actually emits.
  const bare = shapeMetricRows(
    [{ bucket: "1", rows: "1" }],
    compile({ view: "turns", timeDimension: { granularity: "hour" } }),
  ).data[0];
  const reserved = Object.keys(bare);
  assert.deepEqual(reserved.sort(), ["coverage", "rows", "time"]);

  for (const [viewName, view] of Object.entries(CATALOG)) {
    const taken = new Set(reserved);
    for (const [name, measure] of Object.entries(view.measures)) {
      for (const aggregation of measure.aggregations) taken.add(`${aggregation}_${name}`);
    }
    for (const name of Object.keys(view.dimensions)) {
      assert.ok(!taken.has(name), `${viewName}.${name} collides with a response key`);
    }
  }
});

test("a ratio measure refuses to be summed", () => {
  // Total tokens-per-second across a thousand turns is a large confident
  // number that means nothing.
  rejects(
    { view: "turns", measures: [{ measure: "output_tokens_per_second", aggregation: "sum" }] },
    /does not support 'sum'/,
  );
  rejects(
    { view: "turns", measures: [{ measure: "time_per_output_chunk", aggregation: "sum" }] },
    /does not support 'sum'/,
  );
  // …but averaging it is the whole point of having it.
  assert.ok(
    compile({
      view: "turns",
      measures: [{ measure: "output_tokens_per_second", aggregation: "avg" }],
    }).sql.includes("avg(output_tokens_per_second)"),
  );
});

test("sessions can only be counted distinctly", () => {
  // count(session_id) is how many ROWS have a session; under the label
  // "Sessions" that reports 1,922 turns as 1,922 sessions when there are 700.
  rejects(
    { view: "turns", measures: [{ measure: "sessions", aggregation: "count" }] },
    /does not support 'count'/,
  );
});

/* -------------------------------------------------------------------------- */
/* injection                                                                   */
/* -------------------------------------------------------------------------- */

const HOSTILE = "x'); DROP TABLE evestack.fact_turn; --";

test("a name that is not in the catalog never reaches SQL", () => {
  rejects({ view: HOSTILE }, /Unknown view/);
  rejects({ view: "turns", measures: [{ measure: HOSTILE, aggregation: "sum" }] }, /Unknown measure/);
  rejects(
    { view: "turns", measures: [{ measure: "cost", aggregation: HOSTILE }] },
    /does not support/,
  );
  rejects({ view: "turns", dimensions: [HOSTILE] }, /Unknown dimension/);
  rejects({ view: "turns", filters: [{ field: HOSTILE, operator: "eq", value: "a" }] }, /Unknown filter field/);
  rejects(
    { view: "turns", filters: [{ field: "model", operator: HOSTILE, value: "a" }] },
    /is not available on dimension/,
  );
  rejects({ view: "turns", orderBy: [{ field: HOSTILE }] }, /Cannot order by/);
  rejects(
    { view: "turns", orderBy: [{ field: "rows", direction: HOSTILE }] },
    /must be 'asc' or 'desc'/,
  );
  rejects({ view: "turns", timeDimension: { granularity: HOSTILE } }, /Unknown granularity/);
});

test("an inherited property name is unknown, not a catalog entry", () => {
  // `CATALOG["constructor"]` is Object's constructor and is truthy, so a plain
  // `[]` lookup accepts it as a view and then throws reading `.dimensions` off
  // a function: a 500 for what is a typo. `"toString" in GRANULARITY_MS` is
  // worse — the granularity resolves to a function, the bucket count becomes
  // NaN, and NaN is greater than no bound.
  for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
    rejects({ view: name }, /Unknown view/);
    rejects({ view: "turns", measures: [{ measure: name, aggregation: "sum" }] }, /Unknown measure/);
    rejects({ view: "turns", dimensions: [name] }, /Unknown dimension/);
    rejects(
      { view: "turns", filters: [{ field: name, operator: "eq", value: "a" }] },
      /Unknown filter field/,
    );
    rejects({ view: "turns", timeDimension: { granularity: name } }, /Unknown granularity/);
  }
});

test("a filter value is a parameter, never text in the statement", () => {
  const compiled = compile({
    view: "turns",
    dimensions: ["model"],
    filters: [
      { field: "model", operator: "eq", value: HOSTILE },
      { field: "trigger", operator: "in", value: [HOSTILE, "slack"] },
      { field: "cost", operator: "gt", value: 0.01 },
    ],
  });
  assert.ok(!compiled.sql.includes(HOSTILE), `hostile value leaked into SQL:\n${compiled.sql}`);
  assert.ok(!compiled.sql.includes("DROP"), compiled.sql);
  assert.ok(compiled.params.includes(HOSTILE));
  assert.ok(compiled.params.some((p) => Array.isArray(p) && p.includes(HOSTILE)));
  assert.ok(compiled.params.includes(0.01));
});

test("the emitted statement contains only identifiers the catalog supplied", () => {
  // The strongest form of the claim: strip every literal the catalog itself
  // declares out of the SQL and nothing recognisable as caller text is left.
  const compiled = compile({
    view: "turns",
    measures: [
      { measure: "ttft", aggregation: "p95" },
      { measure: "cost", aggregation: "sum" },
    ],
    dimensions: ["model", "outcome"],
    filters: [{ field: "outcome", operator: "ne", value: HOSTILE }],
    timeDimension: { granularity: "hour" },
    orderBy: [{ field: "model", direction: "asc" }],
  });
  const view = CATALOG.turns;
  let remaining = compiled.sql;
  for (const fragment of [
    view.table,
    view.timeColumn,
    ...Object.values(view.measures).map((m) => m.sql),
    ...Object.values(view.dimensions).map((d) => d.sql),
  ]) {
    remaining = remaining.split(fragment).join(" ");
  }
  // Only structure, aliases built from catalog keys, and bind markers survive.
  assert.doesNotMatch(remaining, /DROP|;\s*\w|--/, remaining);
});

test("a high-cardinality field is filterable but not groupable", () => {
  // One row per run is a list pretending to be a chart.
  rejects({ view: "turns", dimensions: ["run_id"] }, /filterable but not groupable/);
  rejects({ view: "turns", dimensions: ["session_id"] }, /filterable but not groupable/);
  const compiled = compile({
    view: "turns",
    filters: [{ field: "session_id", operator: "eq", value: "sess-1" }],
  });
  assert.ok(compiled.sql.includes("session_id = $"));
  assert.ok(compiled.params.includes("sess-1"));
});

test("an operator has to suit the field it is used on", () => {
  rejects(
    { view: "turns", filters: [{ field: "model", operator: "gt", value: "a" }] },
    /not available on dimension 'model'/,
  );
  rejects(
    { view: "turns", filters: [{ field: "cost", operator: "in", value: ["a"] }] },
    /not available on numeric measure 'cost'/,
  );
  rejects(
    { view: "turns", filters: [{ field: "model", operator: "in", value: [] }] },
    /needs a non-empty array/,
  );
  rejects(
    { view: "turns", filters: [{ field: "cost", operator: "gt", value: "lots" }] },
    /needs a finite number/,
  );
  // is_null takes no value and must not demand one.
  assert.ok(
    compile({
      view: "turns",
      filters: [{ field: "error_code", operator: "is_not_null" }],
    }).sql.includes("error_code IS NOT NULL"),
  );
});

/* -------------------------------------------------------------------------- */
/* the window and the buckets                                                  */
/* -------------------------------------------------------------------------- */

test("the window defaults to the last 24 hours and is half-open", () => {
  const { meta, sql } = compile({ view: "turns" });
  assert.equal(meta.to, new Date(NOW).toISOString());
  assert.equal(meta.from, new Date(NOW - DAY).toISOString());
  // `>= from AND < to`, so two adjacent windows share no row and none is
  // counted twice across a pair of charts.
  assert.ok(sql.includes("created_at >= $"));
  assert.ok(sql.includes("created_at < $"));
});

test("a bound without a zone is refused rather than resolved in the server's", () => {
  // The bug lib/fleet.ts and lib/db.ts both document: a naive timestamp moves
  // by the host's offset, so the same request would select a different eight
  // hours in a container set to America/Los_Angeles.
  rejects(
    { view: "turns", timeDimension: { from: "2026-08-01T00:00:00", to: "2026-08-02T00:00:00Z" } },
    /must carry a UTC offset/,
  );
  assert.ok(
    compile({
      view: "turns",
      timeDimension: { from: "2026-08-01T00:00:00-07:00", to: "2026-08-02T00:00:00Z" },
    }),
  );
});

test("buckets are anchored on 'from', not on the clock", () => {
  // This is the whole reason for width_bucket over date_trunc, which
  // lib/monitors.ts explains: date_trunc would start the series at 12:00 and
  // report a 23-minute leading bucket, whose lower count reads as a dip in
  // throughput rather than as a partial interval.
  const from = "2026-08-05T12:37:00.000Z";
  const to = "2026-08-05T18:37:00.000Z";
  const compiled = compile({
    view: "turns",
    timeDimension: { from, to, granularity: "hour" },
  });
  assert.equal(compiled.meta.buckets, 6);
  const shaped = shapeMetricRows([], compiled);
  assert.equal(shaped.data.length, 6);
  assert.equal(shaped.data[0].time, from);
  assert.equal(shaped.data[1].time, "2026-08-05T13:37:00.000Z");
  assert.equal(shaped.data.at(-1).time, "2026-08-05T17:37:00.000Z");
  // Every bucket the same width — the property date_trunc cannot give.
  for (let i = 1; i < shaped.data.length; i += 1) {
    assert.equal(Date.parse(shaped.data[i].time) - Date.parse(shaped.data[i - 1].time), HOUR);
  }
});

test("the bucket bounds passed to width_bucket cover the whole window", () => {
  // Postgres returns 0 below `lo` and n+1 at or above `hi`; either would drop
  // the row out of the densified series without a word. `hi` is therefore the
  // ceiling of the window, not `to`.
  const from = "2026-08-05T00:00:00.000Z";
  const to = "2026-08-05T05:30:00.000Z";
  const compiled = compile({ view: "turns", timeDimension: { from, to, granularity: "hour" } });
  const [lo, hi, buckets] = compiled.params;
  assert.equal(buckets, 6);
  assert.equal(lo, Date.parse(from) / 1000);
  assert.equal(hi, lo + 6 * 3600);
  assert.ok(hi >= Date.parse(to) / 1000);
});

test("'auto' picks a granularity the chart can draw", () => {
  const pick = (spanMs) =>
    compile({
      view: "turns",
      timeDimension: {
        from: new Date(NOW - spanMs).toISOString(),
        to: new Date(NOW).toISOString(),
        granularity: "auto",
      },
    }).meta.granularity;
  assert.equal(pick(HOUR), "minute");
  assert.equal(pick(6 * HOUR), "hour");
  assert.equal(pick(DAY), "hour");
  assert.equal(pick(30 * DAY), "day");
  assert.equal(pick(365 * DAY), "week");
});

test("a window that would need thousands of buckets is refused, with both numbers", () => {
  rejects(
    {
      view: "turns",
      timeDimension: {
        from: new Date(NOW - 30 * DAY).toISOString(),
        to: new Date(NOW).toISOString(),
        granularity: "minute",
      },
    },
    /43200 buckets; the maximum is 500/,
  );
});

test("month is refused, and says why", () => {
  rejects({ view: "turns", timeDimension: { granularity: "month" } }, /not a fixed number of seconds/);
});

test("from must precede to", () => {
  rejects(
    { view: "turns", timeDimension: { from: "2026-08-06T00:00:00Z", to: "2026-08-05T00:00:00Z" } },
    /must be earlier than/,
  );
});

/* -------------------------------------------------------------------------- */
/* ordering                                                                    */
/* -------------------------------------------------------------------------- */

test("a top list sorts by row count unless told otherwise, and nulls sink", () => {
  const byDefault = compile({ view: "turns", dimensions: ["model"] });
  assert.ok(byDefault.sql.includes('ORDER BY "rows" DESC NULLS LAST'));

  // Postgres defaults DESC to NULLS FIRST, so a top list by p95 would open with
  // the groups that have no p95 at all — the models nobody has telemetry for
  // ranked above the ones that are actually slow.
  const byMeasure = compile({
    view: "turns",
    measures: [{ measure: "ttft", aggregation: "p95" }],
    dimensions: ["model"],
    orderBy: [{ field: "p95_ttft", direction: "desc" }],
  });
  assert.ok(byMeasure.sql.includes('ORDER BY "m_p95_ttft" DESC NULLS LAST'));
  const ascending = compile({
    view: "turns",
    measures: [{ measure: "ttft", aggregation: "p95" }],
    dimensions: ["model"],
    orderBy: [{ field: "p95_ttft", direction: "asc" }],
  });
  assert.ok(ascending.sql.includes('ORDER BY "m_p95_ttft" ASC NULLS LAST'));
});

test("ordering a bucketed query by a measure is refused, and says what to do", () => {
  // It reads like "top models by cost over time" and it is not: the sort ranks
  // BUCKETS, so the limit keeps the highest-spending hours of unrelated series
  // and drops the rest of each line — a chart with holes that does not look
  // like it has holes.
  rejects(
    {
      view: "turns",
      measures: [{ measure: "cost", aggregation: "sum" }],
      dimensions: ["model"],
      timeDimension: { granularity: "hour" },
      orderBy: [{ field: "sum_cost", direction: "desc" }],
    },
    /would rank buckets, not series/,
  );
});

test("a bucketed query comes back series-major so a line is contiguous", () => {
  const { sql } = compile({
    view: "turns",
    dimensions: ["model", "trigger"],
    timeDimension: { granularity: "hour" },
  });
  assert.equal(
    sql.slice(sql.indexOf("ORDER BY")).trim(),
    'ORDER BY "d_model" ASC NULLS LAST, "d_trigger" ASC NULLS LAST, bucket ASC NULLS LAST\n LIMIT $6',
  );
});

test("a bucketed query still honours the direction the caller asked for", () => {
  // Adding the implicit series ordering must not put an ASC on a column the
  // caller already ordered DESC — legal SQL that silently ignores the request.
  const { sql } = compile({
    view: "turns",
    dimensions: ["model", "trigger"],
    timeDimension: { granularity: "hour" },
    orderBy: [{ field: "model", direction: "desc" }],
  });
  const order = sql.slice(sql.indexOf("ORDER BY"), sql.indexOf("LIMIT"));
  assert.equal(order.match(/"d_model"/g).length, 1, order);
  assert.ok(order.includes('"d_model" DESC NULLS LAST'), order);
});

test("ordering by something that was not selected is refused", () => {
  rejects({ view: "turns", orderBy: [{ field: "sum_cost" }] }, /it is not selected/);
  rejects({ view: "turns", orderBy: [{ field: "time" }] }, /without a timeDimension granularity/);
});

/* -------------------------------------------------------------------------- */
/* shaping: densification, empty buckets, coverage, truncation                 */
/* -------------------------------------------------------------------------- */

/** One raw row as node-pg hands it back: counts are strings, values are numbers. */
const rawRow = (bucket, extra) => ({ bucket: String(bucket), ...extra });

test("an empty bucket is a real zero for counts and unknown for averages", () => {
  const compiled = compile({
    view: "turns",
    measures: [
      { measure: "cost", aggregation: "sum" },
      { measure: "duration", aggregation: "p95" },
      { measure: "ttft", aggregation: "avg" },
      { measure: "sessions", aggregation: "count_distinct" },
    ],
    timeDimension: {
      from: "2026-08-05T00:00:00.000Z",
      to: "2026-08-05T03:00:00.000Z",
      granularity: "hour",
    },
  });
  const shaped = shapeMetricRows(
    [
      rawRow(1, {
        rows: "10",
        m_sum_cost: "1.5",
        c_sum_cost: "10",
        m_p95_duration: 900,
        c_p95_duration: "10",
        m_avg_ttft: 120,
        c_avg_ttft: "4",
        m_count_distinct_sessions: "3",
        c_count_distinct_sessions: "10",
      }),
    ],
    compiled,
  );

  assert.equal(shaped.data.length, 3);
  const [present, empty] = shaped.data;
  assert.equal(present.rows, 10);
  assert.equal(present.sum_cost, 1.5);
  assert.equal(present.avg_ttft, 120);
  assert.deepEqual(present.coverage, {
    sum_cost: 10,
    p95_duration: 10,
    avg_ttft: 4,
    count_distinct_sessions: 10,
  });

  // The hour nothing happened in. It cost nothing and ran no sessions — both
  // are facts. Its p95 latency is not zero; there is no p95.
  assert.equal(empty.rows, 0);
  assert.equal(empty.sum_cost, 0);
  assert.equal(empty.count_distinct_sessions, 0);
  assert.equal(empty.p95_duration, null);
  assert.equal(empty.avg_ttft, null);
  assert.deepEqual(empty.coverage, {
    sum_cost: 0,
    p95_duration: 0,
    avg_ttft: 0,
    count_distinct_sessions: 0,
  });
});

test("an empty bucket keeps the series it belongs to", () => {
  // Emitting a null model here would fork one line into two: the real series
  // and a phantom "unknown" one that only exists in the quiet hours.
  const compiled = compile({
    view: "turns",
    measures: [{ measure: "duration", aggregation: "avg" }],
    dimensions: ["model"],
    timeDimension: {
      from: "2026-08-05T00:00:00.000Z",
      to: "2026-08-05T03:00:00.000Z",
      granularity: "hour",
    },
  });
  const shaped = shapeMetricRows(
    [
      rawRow(1, { d_model: "openai/gpt-5-mini", rows: "4", m_avg_duration: 100, c_avg_duration: "4" }),
      rawRow(3, { d_model: "openai/gpt-5-mini", rows: "2", m_avg_duration: 200, c_avg_duration: "2" }),
      rawRow(2, { d_model: "ollama/qwen3", rows: "7", m_avg_duration: 50, c_avg_duration: "7" }),
    ],
    compiled,
  );

  assert.equal(shaped.data.length, 6);
  assert.deepEqual(
    shaped.data.map((r) => [r.model, r.time.slice(11, 16), r.rows]),
    [
      ["openai/gpt-5-mini", "00:00", 4],
      ["openai/gpt-5-mini", "01:00", 0],
      ["openai/gpt-5-mini", "02:00", 2],
      ["ollama/qwen3", "00:00", 0],
      ["ollama/qwen3", "01:00", 7],
      ["ollama/qwen3", "02:00", 0],
    ],
  );
});

test("coverage counts the rows that fed each measure, against the rows that matched", () => {
  const compiled = compile({
    view: "turns",
    measures: [
      { measure: "ttft", aggregation: "p95" },
      { measure: "cost", aggregation: "sum" },
    ],
    timeDimension: {
      from: "2026-08-05T00:00:00.000Z",
      to: "2026-08-05T02:00:00.000Z",
      granularity: "hour",
    },
  });
  const shaped = shapeMetricRows(
    [
      rawRow(1, { rows: "100", m_p95_ttft: 500, c_p95_ttft: "3", m_sum_cost: "2", c_sum_cost: "80" }),
      rawRow(2, { rows: "50", m_p95_ttft: 400, c_p95_ttft: "1", m_sum_cost: "1", c_sum_cost: "50" }),
    ],
    compiled,
  );
  assert.equal(shaped.coverage.matchedRows, 150);
  // 4 of 150. A TTFT chart drawn from this without saying so is presenting 2.7%
  // of the fleet as the fleet — the exact failure span_coverage exists for.
  assert.deepEqual(shaped.coverage.byMeasure.p95_ttft, { rows: 4, of: 150 });
  assert.deepEqual(shaped.coverage.byMeasure.sum_cost, { rows: 130, of: 150 });
});

test("a measure nothing recorded reads as absent, not as zero", () => {
  // `arguments_bytes` is written only by eve's local tracer; on a deployed
  // install it is NULL on every row. An average of nothing must not render 0 B.
  const compiled = compile({
    view: "tool_calls",
    measures: [{ measure: "arguments_bytes", aggregation: "avg" }],
    dimensions: ["tool"],
  });
  const shaped = shapeMetricRows(
    [{ d_tool: "bash", rows: "106", m_avg_arguments_bytes: null, c_avg_arguments_bytes: "0" }],
    compiled,
  );
  assert.equal(shaped.data[0].avg_arguments_bytes, null);
  assert.equal(shaped.data[0].rows, 106);
  assert.deepEqual(shaped.coverage.byMeasure.avg_arguments_bytes, { rows: 0, of: 106 });
});

test("a truncated result says so and is not densified", () => {
  // Densifying around rows the limit cut would manufacture empty buckets that
  // are indistinguishable from quiet ones — a chart missing data that does not
  // look like it is missing data.
  const compiled = compile({
    view: "turns",
    limit: 2,
    timeDimension: {
      from: "2026-08-05T00:00:00.000Z",
      to: "2026-08-05T05:00:00.000Z",
      granularity: "hour",
    },
  });
  // The compiler asks for one row past the limit; that is how truncation is
  // detected at all.
  assert.equal(compiled.params.at(-1), 3);

  const overflowing = shapeMetricRows(
    [rawRow(1, { rows: "1" }), rawRow(2, { rows: "1" }), rawRow(3, { rows: "1" })],
    compiled,
  );
  assert.equal(overflowing.truncated, true);
  assert.equal(overflowing.data.length, 2);

  const complete = shapeMetricRows([rawRow(1, { rows: "1" }), rawRow(2, { rows: "1" })], compiled);
  assert.equal(complete.truncated, false);
  assert.equal(complete.data.length, 5, "an untruncated series is densified to every bucket");
});

test("an unbucketed result is returned as it came, with no time key", () => {
  const compiled = compile({ view: "turns", dimensions: ["outcome"] });
  const shaped = shapeMetricRows(
    [
      { d_outcome: "ok", rows: "1699" },
      { d_outcome: "failed", rows: "113" },
    ],
    compiled,
  );
  assert.equal(shaped.data.length, 2);
  assert.equal(shaped.data[0].time, undefined);
  assert.equal(shaped.data[0].outcome, "ok");
  assert.equal(shaped.data[0].rows, 1699);
  assert.equal(shaped.coverage.matchedRows, 1812);
});

test("a request with no measures still answers 'how many'", () => {
  // `rows` is on every row, so throughput needs no measure at all — and it is
  // the denominator every coverage number is stated against.
  const compiled = compile({ view: "turns", timeDimension: { granularity: "hour" } });
  assert.ok(compiled.sql.includes('count(*) AS "rows"'));
  const shaped = shapeMetricRows([rawRow(1, { rows: "12" })], compiled);
  assert.equal(shaped.data.length, 24);
  assert.equal(shaped.data[0].rows, 12);
  assert.equal(shaped.data[1].rows, 0);
});

/* -------------------------------------------------------------------------- */
/* limits and malformed bodies                                                 */
/* -------------------------------------------------------------------------- */

test("the limit is validated rather than clamped", () => {
  rejects({ view: "turns", limit: 0 }, /positive integer/);
  rejects({ view: "turns", limit: 2.5 }, /positive integer/);
  rejects({ view: "turns", limit: "10" }, /positive integer/);
  rejects({ view: "turns", limit: 100_000 }, /at most 5000/);
  assert.equal(compile({ view: "turns", limit: 7 }).meta.limit, 7);
});

test("a malformed body is a MetricQueryError, not a crash", () => {
  rejects(null, /Expected 'body' to be an object/);
  rejects([], /Expected 'body' to be an object/);
  rejects({}, /Expected 'view' to be a non-empty string/);
  rejects({ view: "turns", measures: {} }, /Expected 'measures' to be an array/);
  rejects({ view: "turns", measures: ["cost"] }, /Expected 'measures\[0\]' to be an object/);
  rejects({ view: "turns", dimensions: ["model", "model"] }, /listed twice/);
  rejects(
    {
      view: "turns",
      measures: [
        { measure: "cost", aggregation: "sum" },
        { measure: "cost", aggregation: "sum" },
      ],
    },
    /requested twice/,
  );
});

test("the response describes itself, so the UI formats without guessing", () => {
  const { meta } = compile({
    view: "turns",
    measures: [
      { measure: "cost", aggregation: "sum" },
      { measure: "ttft", aggregation: "p95" },
    ],
    dimensions: ["model"],
    timeDimension: { granularity: "hour" },
  });
  assert.deepEqual(meta.measures, [
    { key: "sum_cost", measure: "cost", aggregation: "sum", unit: "cost", label: "Cost" },
    {
      key: "p95_ttft",
      measure: "ttft",
      aggregation: "p95",
      unit: "duration",
      label: "Time to first chunk",
    },
  ]);
  assert.deepEqual(meta.dimensions, [{ key: "model", label: "Model" }]);
  assert.equal(meta.granularity, "hour");
  assert.equal(meta.buckets, 24);
});
