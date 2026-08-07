/**
 * EVESTACK_DB_CONNECT_TIMEOUT_MS — the setting that failed by disappearing.
 *
 * lib/db.ts says why the bound exists: without one, pg keeps retrying every
 * address the hostname resolves to and a page render hangs for minutes before
 * anything is rendered at all. What the code did not do was survive a value that
 * is not a number. `Number(process.env.X ?? 5_000)` is NaN for "5s" and 0 for the
 * empty string a docker-compose `environment:` entry passes for a variable that
 * is listed and unset on the host — and pg-pool arms the timer with
 * `if (!this.options.connectionTimeoutMillis)`, so both of those are falsy and
 * REMOVE the timeout instead of shortening it. A mistyped setting silently
 * restored the exact hang it was added to prevent, /api/health included.
 *
 * So these assertions are not about parsing. They are about the one property the
 * call site depends on: whatever comes back must be a number pg-pool will
 * actually arm a timer with.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { connectTimeoutMs } from "../lib/db.ts";

const DOCUMENTED_DEFAULT = 5_000;

let saved;
let warnings;
let realWarn;

beforeEach(() => {
  saved = process.env.EVESTACK_DB_CONNECT_TIMEOUT_MS;
  delete process.env.EVESTACK_DB_CONNECT_TIMEOUT_MS;
  warnings = [];
  realWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
});

afterEach(() => {
  console.warn = realWarn;
  if (saved === undefined) delete process.env.EVESTACK_DB_CONNECT_TIMEOUT_MS;
  else process.env.EVESTACK_DB_CONNECT_TIMEOUT_MS = saved;
});

test("unset is the documented default, quietly", () => {
  assert.equal(connectTimeoutMs(), DOCUMENTED_DEFAULT);
  assert.deepEqual(warnings, [], "nothing was set, so there is nothing to complain about");
});

test("a number is used as given", () => {
  process.env.EVESTACK_DB_CONNECT_TIMEOUT_MS = "1500";
  assert.equal(connectTimeoutMs(), 1500);
  assert.deepEqual(warnings, []);
});

test("a value with a unit falls back and says so", () => {
  process.env.EVESTACK_DB_CONNECT_TIMEOUT_MS = "5s";
  assert.equal(connectTimeoutMs(), DOCUMENTED_DEFAULT);
  assert.equal(warnings.length, 1, "an operator who mistyped this has to be able to find out");
  assert.match(warnings[0], /EVESTACK_DB_CONNECT_TIMEOUT_MS/);
});

test("a blank value is unset, not zero", () => {
  // Number("") is 0, and 0 is how pg-pool spells "wait forever".
  for (const blank of ["", " ", "\t"]) {
    process.env.EVESTACK_DB_CONNECT_TIMEOUT_MS = blank;
    assert.equal(connectTimeoutMs(), DOCUMENTED_DEFAULT);
  }
  assert.deepEqual(warnings, [], "compose passing through an unset variable is not a typo");
});

test("nothing an environment can hold produces a timeout pg-pool would ignore", () => {
  for (const raw of ["0", "-1", "-5000", "abc", "NaN", "null", "1e", "5 000", "Infinity", "0x0"]) {
    process.env.EVESTACK_DB_CONNECT_TIMEOUT_MS = raw;
    const value = connectTimeoutMs();
    assert.ok(value, `${JSON.stringify(raw)} produced ${value}, which pg-pool reads as no timeout`);
    assert.ok(Number.isFinite(value), `${JSON.stringify(raw)} produced ${value}`);
    assert.ok(value > 0, `${JSON.stringify(raw)} produced ${value}`);
  }
});
