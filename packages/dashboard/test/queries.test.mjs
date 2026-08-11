import assert from "node:assert/strict";
import { test } from "node:test";
import {
  encodeSessionCursor,
  nextSessionCursor,
  parseSessionCursor,
  priceOf,
  toTurnRow,
} from "../lib/queries.ts";

/**
 * The keyset predicate itself is PostgreSQL semantics — a row comparison over
 * `(timestamp, text)` against a partial expression index — so it is asserted
 * against a real server by
 * contract/runtime/probes/06-session-keyset-and-tool-calls.probe.mjs. Asserting
 * it here would only restate it.
 *
 * What belongs in JavaScript is the cursor's own contract: it is the one thing
 * a caller handles directly, it arrives from a URL rather than from us, and
 * every way of getting it wrong produces duplicated or skipped rows rather than
 * an error.
 */

const CURSOR = { createdAt: "2026-08-06T11:56:37.310418", id: "wrun_01KZBEXEHYX7XDP9JBGMYVGMYG" };

test("a cursor round-trips with its microseconds intact", () => {
  const encoded = encodeSessionCursor(CURSOR);
  assert.equal(encoded, `${CURSOR.createdAt}|${CURSOR.id}`);
  assert.deepEqual(parseSessionCursor(encoded), CURSOR);
  // The whole reason this is not `new Date(...).toISOString()`: that TRUNCATES
  // to milliseconds, and the list walks DESC keeping rows strictly below the
  // cursor, so a cursor of .310 excludes rows at .310418 that should still have
  // been served. They appear on no page at all. The probe measures it.
  assert.ok(encoded.includes(".310418"));
});

test("a run id containing the separator survives the round trip", () => {
  const odd = { createdAt: CURSOR.createdAt, id: "wrun_a|b" };
  assert.deepEqual(parseSessionCursor(encodeSessionCursor(odd)), odd);
});

test("a cursor whose date cannot exist is rejected here, not by Postgres", () => {
  // These all match the format. Nothing in JavaScript objected, so the first
  // thing that noticed was Postgres, mid-SELECT, with `date/time field value
  // out of range` — which the session list renders as "Can't reach the
  // database — start it with docker compose up". Postgres is up; the cursor is
  // wrong; the advice sends the reader to restart a healthy container.
  for (const bad of [
    "2026-02-30T00:00:00.000000|wrun_x",
    "2026-13-01T00:00:00.000000|wrun_x",
    "2026-08-06T25:00:00.000000|wrun_x",
    "2026-08-06T11:60:00.000000|wrun_x",
    // Year zero exists in JavaScript's proleptic calendar and not in Postgres.
    "0000-01-01T00:00:00.000000|wrun_x",
    // Postgres would ACCEPT this one and read it as 11:57:00 — a different
    // instant from the row the cursor claims to be, so the page boundary moves
    // and rows in between are served nowhere. `to_char` never emits :60.
    "2026-08-06T11:56:60.000000|wrun_x",
  ]) {
    assert.throws(() => parseSessionCursor(bad), /Not a session cursor/, `should reject ${bad}`);
  }
  // Real dates the rejection must not take with it: a leap day, and a year
  // outside the two-digit range that `Date.UTC()` would have mapped onto 19xx.
  assert.equal(parseSessionCursor("2028-02-29T12:00:00.000000|wrun_x").createdAt, "2028-02-29T12:00:00.000000");
  assert.equal(parseSessionCursor("0050-02-28T12:00:00.000000|wrun_x").createdAt, "0050-02-28T12:00:00.000000");
});

test("a malformed cursor throws instead of quietly meaning page one", () => {
  // Silently restarting is the worst option available: the caller appends rows
  // it has already rendered and the list duplicates with no error anywhere.
  for (const bad of [
    "",
    "|",
    "wrun_only",
    "|wrun_no_timestamp",
    "2026-08-06T11:56:37.310418|",
    // Millisecond precision — i.e. someone passed SessionRow.createdAt, which
    // is exactly the mistake this format exists to make impossible.
    "2026-08-06T11:56:37.310|wrun_x",
    // An ISO string with a zone designator: parses as a date, is not what the
    // naive-UTC column holds, and would shift the page boundary.
    "2026-08-06T11:56:37.310418Z|wrun_x",
    "not a timestamp at all|wrun_x",
  ]) {
    assert.throws(() => parseSessionCursor(bad), /Not a session cursor/, `should reject ${JSON.stringify(bad)}`);
  }
});

test("a full page yields a cursor and a short page ends the walk", () => {
  const rows = [
    { cursor: "2026-08-06T11:00:00.000000|wrun_a" },
    { cursor: "2026-08-06T10:00:00.000000|wrun_b" },
  ];
  assert.equal(nextSessionCursor(rows, 2), "2026-08-06T10:00:00.000000|wrun_b");
  assert.equal(nextSessionCursor(rows, 3), null);
  assert.equal(nextSessionCursor([], 2), null);
  // Position comes from the LAST row, because the list is ordered DESC and the
  // next page continues below it. Taking the first would re-serve the page.
  assert.notEqual(nextSessionCursor(rows, 2), rows[0].cursor);
});

/**
 * The null-vs-zero rule, in the tier that decides it.
 *
 * The SQL half — which turns get a count at all — is asserted against a real
 * server by contract/runtime/probes/06-session-keyset-and-tool-calls.probe.mjs.
 * What that probe cannot see is the mapping: `tool_invocations` arrives from
 * `getSessionTree`'s LEFT JOIN as SQL NULL for every turn nobody traced, and
 * one token decides whether that becomes `null` or `0`. `NUM` is used on the
 * lines either side of it and would compile, pass every other test, and quietly
 * tell every reader that 1,356 of the seeded database's 1,726 turns called no
 * tools. Nothing in either tier caught that until this test.
 */

/** A joined row as pg hands it over: attributes parsed, timestamps as Dates. */
function joined(extra = {}) {
  return {
    id: "wrun_x",
    status: "completed",
    error_code: null,
    created_at: new Date("2026-08-06T11:56:37.310Z"),
    started_at: new Date("2026-08-06T11:56:37.310Z"),
    completed_at: new Date("2026-08-06T11:56:40.310Z"),
    attributes: { "$eve.type": "turn", "$eve.model": "gpt-5-mini" },
    ...extra,
  };
}

test("an untraced turn reports null tool calls, never a confident zero", () => {
  // The LEFT JOIN missed: no trace, or a trace that resolved to more than one
  // turn. Either way nothing recorded whether this turn called a tool.
  const unknown = toTurnRow(joined({ tool_invocations: null }));
  assert.equal(unknown.toolInvocations, null);
  assert.notEqual(unknown.toolInvocations, 0, "0 claims the turn called no tools; we have no evidence of that");

  // A column that is not in the result set at all must read the same way, so
  // that dropping it from the SELECT cannot invent zeros either.
  assert.equal(toTurnRow(joined()).toolInvocations, null);

  // COUNT(*) is a bigint, and pg hands bigints over as STRINGS. "0" is the one
  // zero that is real: the trace was found and held no execute_tool span.
  assert.equal(toTurnRow(joined({ tool_invocations: "0" })).toolInvocations, 0);
  assert.equal(toTurnRow(joined({ tool_invocations: "3" })).toolInvocations, 3);
});

test("tools offered is null when untagged, while tokens are zero when untagged", () => {
  // The two defaults are opposite on purpose and sit two lines apart. A missing
  // token tag means none were spent; a missing count means eve never said.
  const untagged = toTurnRow(joined());
  assert.equal(untagged.toolsOffered, null);
  assert.equal(untagged.inputTokens, 0);
  assert.equal(untagged.outputTokens, 0);

  const tagged = toTurnRow(
    joined({ attributes: { "$eve.type": "turn", "$eve.tool_count": "12", "$eve.input_tokens": "40" } }),
  );
  assert.equal(tagged.toolsOffered, 12);
  assert.equal(tagged.inputTokens, 40);
});

/**
 * The one about lying, on the JSON surface.
 *
 * `costUsd()` returns 0 for a model the catalog has never heard of, which is
 * the same number it returns for one that is genuinely free. `/costs` and the
 * `/sessions` page already tell those apart by reading `fact_turn.priced`;
 * `lib/queries.ts` did not, so `listSessions()` and `/api/health/detail` — the
 * surface a monitor polls — reported an unknown bill as a confident $0.00,
 * against a product promise that an unpriced model is "never a silent $0.00".
 *
 * These assert the distinction directly rather than through a live database,
 * because the guarantee is arithmetic and a guarantee that can only be checked
 * where Postgres is running is a guarantee nobody runs.
 */
const UNCATALOGUED = "probe-vendor/no-catalog-entry-v0";
const part = (model, input = 1_000_000, output = 1_000_000) =>
  `${model}|${input}|${output}|0|0`;

test("an uncatalogued model costs nothing AND says it was never priced", () => {
  const { costUsd, unpricedModels } = priceOf([part(UNCATALOGUED)]);
  assert.equal(costUsd, 0, "costUsd() has no price to apply, so the sum is 0");
  assert.deepEqual(
    unpricedModels,
    [UNCATALOGUED],
    "and that 0 must arrive carrying the reason it is 0",
  );
});

test("a genuinely free model costs nothing and is NOT called unpriced", () => {
  // `ollama/*` is in the catalog at zero, so this 0 is a real $0.00 rather
  // than a missing price. If this ever reports unpriced, every local install
  // grows a permanent false warning.
  const { costUsd, unpricedModels } = priceOf([part("ollama/qwen3")]);
  assert.equal(costUsd, 0);
  assert.deepEqual(unpricedModels, []);
});

test("the two zeroes are distinguishable, which is the whole claim", () => {
  const unknown = priceOf([part(UNCATALOGUED)]);
  const free = priceOf([part("ollama/qwen3")]);
  assert.equal(unknown.costUsd, free.costUsd, "the numbers are identical...");
  assert.notDeepEqual(
    unknown.unpricedModels,
    free.unpricedModels,
    "...so the number alone can never carry the difference",
  );
});

test("a partly-priced session reports a real number and still names the gap", () => {
  const { costUsd, unpricedModels } = priceOf([
    part("openai/gpt-5-mini"),
    part(UNCATALOGUED),
  ]);
  assert.ok(costUsd > 0, "the priced half is real spend and must be reported");
  assert.deepEqual(
    unpricedModels,
    [UNCATALOGUED],
    "a positive total is the more dangerous case: it looks complete",
  );
});

test("the same model twice is named once, and an empty session names nothing", () => {
  assert.deepEqual(priceOf([part(UNCATALOGUED), part(UNCATALOGUED)]).unpricedModels, [
    UNCATALOGUED,
  ]);
  assert.deepEqual(priceOf([]).unpricedModels, []);
});
