/**
 * lib/traces.ts — the OTLP parser and the tree it feeds.
 *
 * `parseOtlpTraces` is the dashboard's only unauthenticated-by-design write
 * path: an exporter POSTs to /api/ingest/v1/traces and whatever comes back out
 * of this function is what gets inserted. Everything it touches is attacker- or
 * at least stranger-shaped JSON, so the properties worth pinning are the
 * defensive ones — a malformed envelope must throw (the exporter needs a 400 so
 * it stops retrying), while a single unreadable span must not take the batch
 * down with it.
 *
 * Only pure functions are exercised. Nothing here connects to Postgres:
 * `insertSpans`, `ensureTraceSchema` and every list* function do, and are out of
 * scope for a suite that has to run in CI with no services.
 *
 * Two more pure surfaces are pinned below for the same reason they exist. The
 * span-family table is the single source both the SQL counts and the JS lists
 * are generated from, so a name recognised by one and not the other — a page
 * reading "3 tool calls" over a list of two — is checkable here rather than only
 * against a live database. `selectCallSpans` is the JS half of the tool-call
 * list, split out of its query so the property that matters (the count IS the
 * list) can be asserted without one.
 *
 * NOTE ON LOADING. This module reaches Postgres through `import { query } from
 * "./db"`, an extensionless specifier that tsconfig's bundler resolution
 * accepts and Node's does not. test/register-ts-resolve.mjs adds the extension
 * at resolve time; without `--import ./test/register-ts-resolve.mjs` this file
 * dies at import with ERR_MODULE_NOT_FOUND. Importing db.ts is harmless — it
 * opens no connection until a query runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import * as traces from "../lib/traces.ts";
import {
  MAX_UNIX_NANO,
  MODEL_CALL_SPANS,
  OtlpFormatError,
  TOOL_CALL_SPANS,
  buildSpanTree,
  matchesSpanFamily,
  parseOtlpTraces,
  selectCallSpans,
  sqlSpanFamily,
} from "../lib/traces.ts";

const TRACE_HEX = "0123456789abcdef0123456789abcdef";
const SPAN_HEX = "0123456789abcdef";
const PARENT_HEX = "fedcba9876543210";

/** An OTLP/HTTP JSON ExportTraceServiceRequest carrying exactly these spans. */
function envelope(spans, extra = {}) {
  return {
    resourceSpans: [
      {
        resource: { attributes: extra.resourceAttributes ?? [] },
        scopeSpans: [{ scope: extra.scope, spans }],
      },
    ],
  };
}

function span(overrides = {}) {
  return {
    traceId: TRACE_HEX,
    spanId: SPAN_HEX,
    name: "agent.turn",
    startTimeUnixNano: "1754400000000000000",
    endTimeUnixNano: "1754400001000000000",
    ...overrides,
  };
}

function parseOne(overrides) {
  const { spans, rejected } = parseOtlpTraces(envelope([span(overrides)]));
  assert.equal(rejected, 0);
  assert.equal(spans.length, 1);
  return spans[0];
}

/* -------------------------------------------------------------------------- */
/* the envelope                                                                */
/* -------------------------------------------------------------------------- */

test("a malformed envelope throws, so the route can answer 400", () => {
  // OTLP exporters retry a 5xx forever and drop a 4xx. A body that can never
  // become spans has to be the second one.
  for (const payload of [null, undefined, "", "resourceSpans", 42, true, []]) {
    assert.throws(() => parseOtlpTraces(payload), OtlpFormatError, JSON.stringify(payload));
  }
  assert.throws(() => parseOtlpTraces({}), /missing `resourceSpans` array/);
  assert.throws(() => parseOtlpTraces({ resourceSpans: {} }), /missing `resourceSpans` array/);
  assert.throws(() => parseOtlpTraces({ resourceSpans: null }), OtlpFormatError);
});

test("an empty but well-formed batch is a success with nothing in it", () => {
  assert.deepEqual(parseOtlpTraces({ resourceSpans: [] }), { spans: [], rejected: 0, errors: [] });
  // Junk at the resourceSpans / scopeSpans level is skipped rather than
  // counted as a rejected span: there was no span there to reject.
  const parsed = parseOtlpTraces({ resourceSpans: [null, 7, {}, { scopeSpans: "nope" }] });
  assert.deepEqual(parsed, { spans: [], rejected: 0, errors: [] });
});

/* -------------------------------------------------------------------------- */
/* ids                                                                         */
/* -------------------------------------------------------------------------- */

test("hex ids are kept, and normalised to lower case", () => {
  const parsed = parseOne({ traceId: TRACE_HEX.toUpperCase(), spanId: SPAN_HEX.toUpperCase() });
  assert.equal(parsed.traceId, TRACE_HEX);
  assert.equal(parsed.spanId, SPAN_HEX);
});

test("base64 ids are decoded to hex rather than stored verbatim", () => {
  // eve sends hex, but a generic protobuf-to-JSON encoder emits base64 for the
  // same bytes field. Storing that would break every join against a hex id
  // from Jaeger or from eve's own logs.
  const traceBytes = Buffer.from(TRACE_HEX, "hex").toString("base64");
  const spanBytes = Buffer.from(SPAN_HEX, "hex").toString("base64");
  const parentBytes = Buffer.from(PARENT_HEX, "hex").toString("base64");

  const parsed = parseOne({
    traceId: traceBytes,
    spanId: spanBytes,
    parentSpanId: parentBytes,
  });
  assert.equal(parsed.traceId, TRACE_HEX);
  assert.equal(parsed.spanId, SPAN_HEX);
  assert.equal(parsed.parentSpanId, PARENT_HEX);
});

test("an id of the wrong length is not an id", () => {
  const cases = {
    "half a trace id": { traceId: SPAN_HEX },
    "a trace id where a span id goes": { spanId: TRACE_HEX },
    "non-hex characters": { traceId: "z".repeat(32) },
    "empty": { traceId: "" },
    "a number": { traceId: 12345 },
    "null": { traceId: null },
    "absent": { spanId: undefined },
  };
  for (const [name, overrides] of Object.entries(cases)) {
    const { spans, rejected, errors } = parseOtlpTraces(envelope([span(overrides)]));
    assert.equal(spans.length, 0, name);
    assert.equal(rejected, 1, name);
    assert.equal(errors.length, 1, name);
    assert.match(errors[0], /agent\.turn/, name);
  }
});

test("a bad span id is named as a bad span id, not as a bad trace id", () => {
  // The error text is the only thing an exporter author has to debug with.
  const { errors } = parseOtlpTraces(envelope([span({ spanId: "nope" })]));
  assert.match(errors[0], /bad spanId/);
  const missingStart = parseOtlpTraces(envelope([span({ startTimeUnixNano: "0" })]));
  assert.match(missingStart.errors[0], /bad startTimeUnixNano/);
});

test("an unreadable parentSpanId makes the span a root, not a rejection", () => {
  // A parent id we cannot read is a lost edge; the span itself is still data.
  assert.equal(parseOne({ parentSpanId: "garbage" }).parentSpanId, null);
  assert.equal(parseOne({ parentSpanId: "" }).parentSpanId, null);
  assert.equal(parseOne({}).parentSpanId, null);
});

/* -------------------------------------------------------------------------- */
/* timestamps                                                                  */
/* -------------------------------------------------------------------------- */

test("unix nanos survive as strings, because they do not fit in a double", () => {
  // 1754400000000000000 > 2^53. Parsing it as a number would round it, and a
  // span would land tens of nanoseconds from where it happened — invisible in
  // the UI and fatal to ordering.
  const parsed = parseOne({});
  assert.equal(parsed.startUnixNano, "1754400000000000000");
  assert.equal(typeof parsed.startUnixNano, "string");
  assert.equal(parsed.endUnixNano, "1754400001000000000");
});

test("a numeric timestamp is accepted, since exporters send both", () => {
  const parsed = parseOne({ startTimeUnixNano: 1754400000000, endTimeUnixNano: 1754400001000 });
  assert.equal(parsed.startUnixNano, "1754400000000");
  assert.equal(parsed.endUnixNano, "1754400001000");
});

test("a span with no usable start time is rejected; no end time is fine", () => {
  for (const bad of ["0", 0, "", null, undefined, "not-a-number", "-1", "1.5"]) {
    const { rejected } = parseOtlpTraces(envelope([span({ startTimeUnixNano: bad })]));
    assert.equal(rejected, 1, JSON.stringify(bad));
  }
  // An in-flight span has no end yet. Rejecting it would make live traces
  // invisible until they finished.
  assert.equal(parseOne({ endTimeUnixNano: undefined }).endUnixNano, null);
  assert.equal(parseOne({ endTimeUnixNano: "0" }).endUnixNano, null);
});

/* -------------------------------------------------------------------------- */
/* timestamps that cannot be stored                                            */
/* -------------------------------------------------------------------------- */

/**
 * `Date.now() * 1e12` — a clock scaled twice, and the value that actually turns
 * up. 25 digits, which overflows `bigint` AND is past what Date can represent.
 */
const DOUBLE_SCALED = String(BigInt(Date.now()) * 1_000_000_000_000n);

/** 20 digits: past `bigint`, but a date Date is perfectly happy with (year 2525). */
const PAST_BIGINT = "17544000000000000000";

test("a timestamp too large to store is rejected, not thrown", () => {
  // The bug this replaces was not a wrong number on a page, it was a permanent
  // stall. Both of these used to reach insertSpans: PAST_BIGINT died in Postgres
  // ("value ... is out of range for type bigint") and DOUBLE_SCALED died before
  // it, in `new Date(...).toISOString()` with `RangeError: Invalid time value`.
  // route.ts sees either one as "could not store spans" and answers 503 with
  // Retry-After — OTLP's retryable signal — so the exporter resent the identical
  // batch forever and the message blamed the database. Rejecting at parse time
  // routes it to partialSuccess instead, which is how OTLP says "stop sending
  // this one".
  for (const bad of [PAST_BIGINT, DOUBLE_SCALED, "9223372036854775808"]) {
    const { spans, rejected, errors } = parseOtlpTraces(
      envelope([span({ startTimeUnixNano: bad })]),
    );
    assert.equal(spans.length, 0, bad);
    assert.equal(rejected, 1, bad);
    assert.match(errors[0], /bad startTimeUnixNano/, bad);
    // The message has to name the ceiling, or the reader goes looking at
    // Postgres exactly as the old 503 invited them to.
    assert.match(errors[0], /bigint ceiling/, bad);
  }
});

test("the bound is exactly what bigint holds, not a digit either side", () => {
  // 2^63-1. An off-by-one here rejects real spans or admits ones that cannot be
  // inserted, and both failures are silent until a batch stalls.
  assert.equal(MAX_UNIX_NANO, 9223372036854775807n);
  assert.equal(parseOne({ startTimeUnixNano: String(MAX_UNIX_NANO) }).startUnixNano, "9223372036854775807");
  assert.equal(parseOtlpTraces(envelope([span({ startTimeUnixNano: String(MAX_UNIX_NANO + 1n) })])).rejected, 1);
});

test("bigint is the tighter of the two ceilings, which is why there is only one", () => {
  // The reasoning MAX_UNIX_NANO rests on, since a second constant for Date would
  // be one more thing to fall out of step: every timestamp bigint can hold is
  // one Date can represent, so bounding at the bigint ceiling bounds both.
  // Measured: the bigint ceiling is 9,223,372,036,854 ms and Date gives up at
  // 8.64e15 ms, roughly 937x further out.
  const maxMillis = Number(MAX_UNIX_NANO / 1_000_000n);
  assert.ok(maxMillis < 8.64e15, `${maxMillis} ms must be inside Date's range`);
  assert.equal(new Date(maxMillis).toISOString().slice(0, 4), "2262");
});

test("an unstorable end time is reported, not quietly nulled", () => {
  // An ABSENT end time means a span still running and is kept — but a value the
  // exporter did send lands in the same bigint column the start time does. If it
  // were nulled instead, a broken clock would render as a span that is "open"
  // forever and the exporter would never be told anything was wrong.
  const { spans, rejected, errors } = parseOtlpTraces(
    envelope([span({ endTimeUnixNano: DOUBLE_SCALED })]),
  );
  assert.equal(spans.length, 0);
  assert.equal(rejected, 1);
  assert.match(errors[0], /bad endTimeUnixNano/);
  // ...and it is named as the END time, not blamed on the start time.
  assert.doesNotMatch(errors[0], /startTimeUnixNano/);
});

test("one span with a double-scaled clock does not stall the batch behind it", () => {
  // The whole point of fixing it at parse time. The other spans are stored, and
  // the exporter is told about the one that was not, so it stops resending.
  const { spans, rejected } = parseOtlpTraces(
    envelope([
      span({ spanId: SPAN_HEX }),
      span({ spanId: PARENT_HEX, startTimeUnixNano: DOUBLE_SCALED }),
      span({ spanId: "1111111111111111" }),
    ]),
  );
  assert.deepEqual(
    spans.map((s) => s.spanId),
    [SPAN_HEX, "1111111111111111"],
  );
  assert.equal(rejected, 1);
});

test("an out-of-range event timestamp drops the timestamp, not the span", () => {
  // `events` is a jsonb column, never a bigint, so there is nothing to overflow
  // and nothing to reject — and null is already how an unset event time reads.
  const parsed = parseOne({
    events: [{ name: "exception", timeUnixNano: DOUBLE_SCALED }],
  });
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].name, "exception");
  assert.equal(parsed.events[0].timeUnixNano, null);
});

test("a non-finite numeric timestamp is rejected rather than thrown out of the parser", () => {
  // BigInt(NaN) throws, and a throw here escapes parseOtlpTraces as something
  // route.ts does not catch — a 500 for the whole batch instead of one rejected
  // span. JSON cannot carry NaN, but this function takes `unknown`.
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -Number.MAX_VALUE]) {
    const { rejected } = parseOtlpTraces(envelope([span({ startTimeUnixNano: bad })]));
    assert.equal(rejected, 1, String(bad));
  }
});

/* -------------------------------------------------------------------------- */
/* AnyValue unwrapping                                                         */
/* -------------------------------------------------------------------------- */

test("every AnyValue variant is unwrapped to a plain JS value", () => {
  const parsed = parseOne({
    attributes: [
      { key: "string", value: { stringValue: "hello" } },
      { key: "empty-string", value: { stringValue: "" } },
      { key: "bool", value: { boolValue: true } },
      { key: "bool-false", value: { boolValue: false } },
      { key: "double", value: { doubleValue: 1.5 } },
      { key: "bytes", value: { bytesValue: "aGk=" } },
      { key: "array", value: { arrayValue: { values: [{ stringValue: "a" }, { intValue: 2 }] } } },
      {
        key: "kvlist",
        value: { kvlistValue: { values: [{ key: "nested", value: { stringValue: "deep" } }] } },
      },
      // An AnyValue with no field set is OTLP's way of saying "unset".
      { key: "unset", value: {} },
      { key: "null-value", value: null },
    ],
  });

  assert.deepEqual(parsed.attributes, {
    string: "hello",
    "empty-string": "",
    bool: true,
    "bool-false": false,
    double: 1.5,
    // Deliberately NOT decoded to text: nothing promised an encoding.
    bytes: "aGk=",
    array: ["a", 2],
    kvlist: { nested: "deep" },
    unset: null,
    "null-value": null,
  });
});

test("int64 arrives as a string or a number, and huge values keep their string form", () => {
  const parsed = parseOne({
    attributes: [
      { key: "as-string", value: { intValue: "1024" } },
      { key: "as-number", value: { intValue: 1024 } },
      { key: "negative", value: { intValue: "-7" } },
      // Past 2^53 a Number would silently round. eve's usage counters are the
      // reason this matters: a wrong token count is a wrong dollar figure.
      { key: "huge", value: { intValue: "9223372036854775807" } },
      { key: "missing", value: { intValue: null } },
    ],
  });
  assert.equal(parsed.attributes["as-string"], 1024);
  assert.equal(parsed.attributes["as-number"], 1024);
  assert.equal(parsed.attributes.negative, -7);
  assert.equal(parsed.attributes.huge, "9223372036854775807");
  assert.equal(parsed.attributes.missing, 0);
});

test("attribute entries that are not key/value pairs are dropped, not thrown on", () => {
  const parsed = parseOne({
    attributes: [
      null,
      "not-an-object",
      42,
      { value: { stringValue: "no key" } },
      { key: "", value: { stringValue: "empty key" } },
      { key: 7, value: { stringValue: "numeric key" } },
      { key: "kept", value: { stringValue: "yes" } },
    ],
  });
  assert.deepEqual(parsed.attributes, { kept: "yes" });
});

test("a non-array attributes field yields no attributes at all", () => {
  assert.deepEqual(parseOne({ attributes: "nope" }).attributes, {});
  assert.deepEqual(parseOne({}).attributes, {});
});

/* -------------------------------------------------------------------------- */
/* the rest of the span                                                        */
/* -------------------------------------------------------------------------- */

test("resource attributes are attached to every span under that resource", () => {
  const payload = envelope([span({ spanId: SPAN_HEX }), span({ spanId: PARENT_HEX })], {
    resourceAttributes: [{ key: "service.name", value: { stringValue: "eve" } }],
    scope: { name: "eve", version: "0.30.8" },
  });
  const { spans } = parseOtlpTraces(payload);
  assert.equal(spans.length, 2);
  for (const parsed of spans) {
    assert.deepEqual(parsed.resource, { "service.name": "eve" });
    assert.equal(parsed.scopeName, "eve");
    assert.equal(parsed.scopeVersion, "0.30.8");
  }
});

test("kind, status and name default rather than becoming NaN or undefined", () => {
  const bare = parseOne({ name: undefined, kind: undefined, status: undefined });
  assert.equal(bare.name, "");
  assert.equal(bare.kind, 0);
  assert.equal(bare.statusCode, 0);
  assert.equal(bare.statusMessage, null);
  assert.equal(bare.scopeName, null);
  assert.equal(bare.scopeVersion, null);

  // A non-numeric kind must not reach Postgres as NaN, which is not an integer.
  assert.equal(parseOne({ kind: "SPAN_KIND_INTERNAL" }).kind, 0);

  const failed = parseOne({ status: { code: 2, message: "boom" } });
  assert.equal(failed.statusCode, 2);
  assert.equal(failed.statusMessage, "boom");
});

test("span events are unwrapped like attributes, and absent events are an empty list", () => {
  const parsed = parseOne({
    events: [
      {
        name: "exception",
        timeUnixNano: "1754400000500000000",
        attributes: [{ key: "exception.type", value: { stringValue: "TypeError" } }],
      },
      null,
      "not-an-event",
      { name: undefined, timeUnixNano: "0" },
    ],
  });
  assert.deepEqual(parsed.events[0], {
    name: "exception",
    timeUnixNano: "1754400000500000000",
    attributes: { "exception.type": "TypeError" },
  });
  assert.deepEqual(parsed.events[1], { name: "", timeUnixNano: null, attributes: {} });
  assert.equal(parsed.events.length, 2);
  assert.deepEqual(parseOne({ events: "nope" }).events, []);
  assert.deepEqual(parseOne({}).events, []);
});

/* -------------------------------------------------------------------------- */
/* partial success                                                             */
/* -------------------------------------------------------------------------- */

test("one bad span does not take the batch down with it", () => {
  // This is what OTLP's partial-success response exists to express, and the
  // difference between losing one span and losing a whole trace.
  const { spans, rejected } = parseOtlpTraces(
    envelope([
      span({ spanId: SPAN_HEX }),
      span({ spanId: "bad" }),
      null,
      "not-a-span",
      span({ spanId: PARENT_HEX }),
    ]),
  );
  assert.deepEqual(
    spans.map((s) => s.spanId),
    [SPAN_HEX, PARENT_HEX],
  );
  assert.equal(rejected, 3);
});

test("the error list is capped so a broken exporter cannot flood the response", () => {
  const bad = Array.from({ length: 50 }, () => span({ spanId: "bad" }));
  const { rejected, errors } = parseOtlpTraces(envelope(bad));
  assert.equal(rejected, 50);
  assert.equal(errors.length, 5);
});

test("spans spread across several resources and scopes all come through", () => {
  const payload = {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "a" } }] },
        scopeSpans: [
          { scope: { name: "eve" }, spans: [span({ spanId: "1111111111111111" })] },
          { scope: { name: "ai" }, spans: [span({ spanId: "2222222222222222" })] },
        ],
      },
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "b" } }] },
        scopeSpans: [{ spans: [span({ spanId: "3333333333333333" })] }],
      },
    ],
  };
  const { spans } = parseOtlpTraces(payload);
  assert.equal(spans.length, 3);
  assert.equal(spans[0].resource["service.name"], "a");
  assert.equal(spans[1].scopeName, "ai");
  assert.equal(spans[2].resource["service.name"], "b");
  assert.equal(spans[2].scopeName, null);
});

/* -------------------------------------------------------------------------- */
/* the tree                                                                    */
/* -------------------------------------------------------------------------- */

function row(spanId, parentSpanId, extra = {}) {
  return {
    traceId: TRACE_HEX,
    spanId,
    parentSpanId,
    name: extra.name ?? spanId,
    kind: 0,
    startTime: "2026-08-05T00:00:00.000Z",
    endTime: null,
    durationMs: null,
    statusCode: 0,
    statusMessage: null,
    attributes: {},
    resource: {},
    events: [],
    scopeName: null,
    sessionId: extra.sessionId ?? null,
    rootSessionId: extra.rootSessionId ?? null,
    turnId: extra.turnId ?? null,
  };
}

test("children nest under their parent and carry a depth", () => {
  const roots = buildSpanTree([
    row("a", null),
    row("b", "a"),
    row("c", "b"),
    row("d", "a"),
  ]);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].spanId, "a");
  assert.equal(roots[0].depth, 0);
  assert.deepEqual(
    roots[0].children.map((n) => n.spanId),
    ["b", "d"],
  );
  assert.equal(roots[0].children[0].depth, 1);
  assert.equal(roots[0].children[0].children[0].spanId, "c");
  assert.equal(roots[0].children[0].children[0].depth, 2);
});

test("a span whose parent is missing is rendered as a root, not dropped", () => {
  // Happens for real: a batch still in flight, or a dropped span. An orphan we
  // never render is a tool call that silently vanishes from the trace view.
  const roots = buildSpanTree([row("child", "parent-that-was-never-inserted")]);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].spanId, "child");
  assert.equal(roots[0].depth, 0);
});

test("eve's session and turn ids are inherited by the AI SDK spans beneath them", () => {
  // The whole reason this function exists. `ai.toolCall` is created by the AI
  // SDK and carries none of eve's ids; its parent chain is the only thing that
  // knows which turn it belongs to.
  const roots = buildSpanTree([
    row("turn", null, { sessionId: "wrun_1", rootSessionId: "wrun_1", turnId: "turn_0" }),
    row("streamText", "turn"),
    row("toolCall", "streamText"),
  ]);
  const streamText = roots[0].children[0];
  const toolCall = streamText.children[0];
  assert.equal(streamText.sessionId, "wrun_1");
  assert.equal(toolCall.sessionId, "wrun_1");
  assert.equal(toolCall.rootSessionId, "wrun_1");
  assert.equal(toolCall.turnId, "turn_0");
});

test("a child's own ids win over the ones it would inherit", () => {
  // A sub-agent run is a real case: the child span names its own session and
  // must not be relabelled with its parent's.
  const roots = buildSpanTree([
    row("parent", null, { sessionId: "wrun_parent", turnId: "turn_0" }),
    row("child", "parent", { sessionId: "wrun_child" }),
  ]);
  const child = roots[0].children[0];
  assert.equal(child.sessionId, "wrun_child");
  // ...while the ids it does NOT state are still inherited.
  assert.equal(child.turnId, "turn_0");
});

test("a cyclic parent chain terminates instead of hanging the page", () => {
  // Nothing upstream promises acyclic ids, and this runs while rendering a
  // page — an infinite walk here is a wedged request, not a bad pixel. The
  // spans in a cycle have no root and so are not rendered; the point of this
  // test is that everything else still is, promptly.
  const roots = buildSpanTree([row("a", "b"), row("b", "a"), row("standalone", null)]);
  assert.deepEqual(
    roots.map((n) => n.spanId),
    ["standalone"],
  );
});

test("an empty result is an empty tree", () => {
  assert.deepEqual(buildSpanTree([]), []);
});

/* -------------------------------------------------------------------------- */
/* one predicate for the counts and for the lists                              */
/* -------------------------------------------------------------------------- */

/**
 * Read the two names back out of a generated SQL predicate.
 *
 * Not a Postgres reimplementation — the point is to prove the SQL half and the
 * JS half are the same two strings, which is the only thing that keeps a count
 * and the list under it in step.
 */
function namesInSql(sql) {
  const match = /^\(name = '([^']*)' OR starts_with\(name, '([^']*)'\)\)$/.exec(sql);
  assert.ok(match, `unrecognised predicate shape: ${sql}`);
  return { exact: match[1], prefix: match[2] };
}

test("both vocabularies are recognised, because which one arrives is not our choice", () => {
  // eve's local tracer emits a fixed span name; the AI SDK exporter appends the
  // model or the tool. Only the second reaches a dashboard over the wire, and
  // matching only the first is what made the ingest endpoint report zero.
  assert.ok(matchesSpanFamily(TOOL_CALL_SPANS, "ai.toolCall"));
  assert.ok(matchesSpanFamily(TOOL_CALL_SPANS, "execute_tool bash"));
  assert.ok(matchesSpanFamily(MODEL_CALL_SPANS, "ai.streamText.doStream"));
  assert.ok(matchesSpanFamily(MODEL_CALL_SPANS, "chat some-model"));

  // The prefix carries its trailing space, so a name that merely starts with the
  // same letters is not a call.
  assert.equal(matchesSpanFamily(TOOL_CALL_SPANS, "execute_toolbar"), false);
  assert.equal(matchesSpanFamily(TOOL_CALL_SPANS, "execute_tool"), false);
  assert.equal(matchesSpanFamily(MODEL_CALL_SPANS, "chatty"), false);
  assert.equal(matchesSpanFamily(TOOL_CALL_SPANS, ""), false);
});

test("the exact-match predicate the ingest endpoint used to run sees none of this", () => {
  // Exactly the defect, stated as a property: the old getTraceStats counted
  // `name = 'ai.toolCall'` and `name = 'ai.streamText.doStream'` and nothing
  // else, so on a deployment that exports — the only kind that can POST here —
  // both fields read 0 over a table full of calls, and the endpoint whose one
  // job is telling a wired exporter from a silent one reported silent.
  /** The predicate getTraceStats ran: equality against the local tracer's name. */
  const exactOnly = (family, name) => name === family.exact;

  for (const [family, exported] of [
    [TOOL_CALL_SPANS, "execute_tool bash"],
    [MODEL_CALL_SPANS, "chat some-model"],
  ]) {
    assert.equal(exactOnly(family, exported), false, exported);
    assert.ok(matchesSpanFamily(family, exported), exported);
  }
});

test("the SQL half and the JS half are generated from the same two names", () => {
  for (const family of [MODEL_CALL_SPANS, TOOL_CALL_SPANS]) {
    const sql = sqlSpanFamily(family);
    assert.deepEqual(namesInSql(sql), { exact: family.exact, prefix: family.prefix });
    // `starts_with` and not LIKE: `_` is a LIKE wildcard, so `'execute_tool %'`
    // would also match `'executeXtool '`.
    assert.match(sql, /starts_with\(/);
    assert.doesNotMatch(sql, /LIKE/i);
  }
});

test("there is one table-wide stats query, not two spellings of it", () => {
  // getTraceStats was a second, near-identical query whose predicates had never
  // been repointed, and the ingest route was its only caller. Deleting it is the
  // fix; this fails if a second one comes back.
  assert.equal(typeof traces.getTraceOverview, "function");
  assert.equal(traces.getTraceStats, undefined);
});

/* -------------------------------------------------------------------------- */
/* the count IS the list                                                       */
/* -------------------------------------------------------------------------- */

test("every call in the rows is listed, including the one at the very end", () => {
  // The truncation this replaces was positional: listSpansBySession takes the
  // first 5,000 spans in start order for the waterfall, and the tool-call list
  // used to be filtered out of that window. A tool call past span 5,000 vanished
  // from a page whose own note promised "every model and tool call is still
  // listed below". The tail row here stands in for that call.
  const rows = [
    row("turn", null, { name: "agent.turn", sessionId: "wrun_1", turnId: "turn_0" }),
    row("t1", "turn", { name: "execute_tool bash" }),
    row("noise", "turn"),
    row("m1", "turn", { name: "chat some-model" }),
    row("tail", "turn", { name: "execute_tool read_file" }),
  ];

  const tools = selectCallSpans(TOOL_CALL_SPANS, rows);
  // The property: the length a page prints is the length of the array it renders,
  // and both equal what COUNT(*) FILTER returns over the same rows.
  assert.equal(tools.calls.length, rows.filter((r) => matchesSpanFamily(TOOL_CALL_SPANS, r.name)).length);
  assert.deepEqual(
    tools.calls.map((c) => c.spanId),
    ["t1", "tail"],
  );

  const models = selectCallSpans(MODEL_CALL_SPANS, rows);
  assert.deepEqual(
    models.calls.map((c) => c.spanId),
    ["m1"],
  );
});

test("a listed call carries the ids it can only get from its ancestors", () => {
  // `ai.toolCall` is created by the AI SDK and stamped with none of eve's ids,
  // so the ancestors have to come back with it — which is why the query walks
  // parents rather than selecting the call spans alone.
  const { calls, byId } = selectCallSpans(TOOL_CALL_SPANS, [
    row("turn", null, { name: "agent.turn", sessionId: "wrun_1", turnId: "turn_0" }),
    row("streamText", "turn"),
    row("toolCall", "streamText", { name: "ai.toolCall" }),
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, "wrun_1");
  assert.equal(calls[0].turnId, "turn_0");
  // The ancestors are in the index too, for the attribute walk.
  assert.ok(byId.has("turn"));
  assert.ok(byId.has("streamText"));
});

test("a call caught in a cyclic parent chain is still listed", () => {
  // buildSpanTree drops the spans in a cycle, because a cycle has no root, and
  // it must keep doing that — an infinite walk while rendering is a wedged
  // request. But a call the SQL counted still has to appear, or the count and
  // the list part company again. It loses only the inherited ids, which are the
  // ones the cycle made unknowable in the first place.
  const { calls } = selectCallSpans(TOOL_CALL_SPANS, [
    row("cycleA", "cycleB", { name: "execute_tool bash" }),
    row("cycleB", "cycleA"),
    row("fine", null, { name: "execute_tool read_file" }),
  ]);
  assert.deepEqual(
    calls.map((c) => c.spanId),
    ["cycleA", "fine"],
  );
  assert.equal(calls[0].turnId, null);
});

test("no rows means no calls, not a thrown page", () => {
  assert.deepEqual(selectCallSpans(TOOL_CALL_SPANS, []).calls, []);
  assert.deepEqual(selectCallSpans(MODEL_CALL_SPANS, [row("a", null)]).calls, []);
});
