import { strict as assert } from "node:assert";
import test from "node:test";
import "./register-ts-resolve.mjs";

const { SESSION_MAX_LIMIT, SESSION_PAGE_SIZE, sessionLimit } = await import("../lib/queries.ts");

// The session list was capped at 100 with nothing on screen saying so: the stat
// row reads the true total while the table shows the newest slice. At 57
// sessions the two agree, which is why a soak test at that size did not surface
// it. The cap is fine; the silence was not.

test("no parameter means the page size, not everything", () => {
  assert.equal(sessionLimit(undefined), SESSION_PAGE_SIZE);
  assert.equal(sessionLimit(""), SESSION_PAGE_SIZE);
});

test("junk falls back to the page size rather than to an unbounded query", () => {
  for (const bad of ["abc", "-1", "0", "NaN", "1e999", "  "]) {
    const got = sessionLimit(bad);
    assert.ok(got > 0 && got <= SESSION_MAX_LIMIT, `${bad} -> ${got}`);
  }
  assert.equal(sessionLimit("abc"), SESSION_PAGE_SIZE);
  assert.equal(sessionLimit("-1"), SESSION_PAGE_SIZE);
  assert.equal(sessionLimit("0"), SESSION_PAGE_SIZE);
});

test("a real number is honoured", () => {
  assert.equal(sessionLimit("20"), 20);
  assert.equal(sessionLimit("250"), 250);
});

test("a hand-typed URL cannot ask for every row", () => {
  assert.equal(sessionLimit("999999"), SESSION_MAX_LIMIT);
});

test("Infinity is treated as junk, not as the maximum", () => {
  // "1e999" parses to Infinity, which is not finite, so it takes the
  // fallback rather than the ceiling. Both are bounded; the fallback is the
  // smaller and therefore the right one for input nobody meant to type.
  assert.equal(sessionLimit("1e999"), SESSION_PAGE_SIZE);
  assert.equal(sessionLimit("Infinity"), SESSION_PAGE_SIZE);
});
