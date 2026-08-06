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
 * NOTE ON LOADING. This module reaches Postgres through `import { query } from
 * "./db"`, an extensionless specifier that tsconfig's bundler resolution
 * accepts and Node's does not. test/register-ts-resolve.mjs adds the extension
 * at resolve time; without `--import ./test/register-ts-resolve.mjs` this file
 * dies at import with ERR_MODULE_NOT_FOUND. Importing db.ts is harmless — it
 * opens no connection until a query runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { OtlpFormatError, buildSpanTree, parseOtlpTraces } from "../lib/traces.ts";

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
