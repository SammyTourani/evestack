import assert from "node:assert/strict";
import { test } from "node:test";
import {
  encodeSessionCursor,
  nextSessionCursor,
  parseSessionCursor,
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
