/**
 * components/ui/format.ts — the three rules the product already gets right.
 *
 * These are cheap assertions guarding expensive mistakes. Every one of them is
 * a case where the wrong output is a plausible-looking number rather than a
 * crash: `$0.00` for a model nobody priced, a p95 over three of forty turns
 * drawn as a confident line, and a `0` where the truth is "we do not know".
 * None of the three is visible in a screenshot, and all three are one character
 * of formatter away.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { EM_DASH, coverageNote, formatCost, formatMetric } from "../components/ui/format.ts";
import { duration } from "../lib/time.ts";

test("the em dash is the same character lib/time.ts already returns", () => {
  // lib/time.ts keeps its own copy private. This is the seam where the two
  // could drift into an en dash and a hyphen on the same table row.
  assert.equal(duration(null), EM_DASH);
});

test("an unpriced model never renders a dollar amount", () => {
  assert.equal(formatCost(0, false), "Unpriced");
  // The dangerous case: pricing.costUsd() returns 0 for an unknown model, so
  // the value reaching the cell is a real, finite, wrong 0.
  assert.equal(formatCost(0, false).includes("$"), false);
  // And a genuinely free priced model — ollama/* is priced at zero on purpose —
  // still gets to say $0.00, because that one is true.
  assert.equal(formatCost(0, true), "$0.00");
});

test("an absent value is an em dash in every unit, and zero is not absent", () => {
  for (const unit of ["duration", "cost", "count", "percent", "bytes", "tokens", "tokens_per_second"]) {
    assert.equal(formatMetric(null, unit), EM_DASH, unit);
    assert.equal(formatMetric(undefined, unit), EM_DASH, unit);
    // A percentile over an empty bucket arrives as null; NaN arrives from a
    // division by a densified zero. Neither is a number to print.
    assert.equal(formatMetric(Number.NaN, unit), EM_DASH, unit);
    assert.notEqual(formatMetric(0, unit), EM_DASH, unit);
  }
});

test("units render as themselves, not as bare numbers", () => {
  assert.equal(formatMetric(4946, "duration"), "4.95s");
  assert.equal(formatMetric(0.0432, "percent"), "4.3%");
  assert.equal(formatMetric(0, "percent"), "0%");
  assert.equal(formatMetric(1_234_567, "tokens"), "1,234,567");
  assert.equal(formatMetric(2048, "bytes"), "2.00 KB");
  assert.equal(formatMetric(512, "bytes"), "512 B");
  // Renders "12.4/s" rather than "12" — the reason tokens_per_second is a unit
  // in lib/metrics.ts instead of being folded into count.
  assert.equal(formatMetric(12.42, "tokens_per_second"), "12.4/s");
});

test("coverage separates nothing-matched from nothing-measured", () => {
  // An empty filter result must not borrow the sentence written for missing
  // spans — "No data — 0 of 0 rows" warns about a measure over a population
  // that does not exist — and a full one must say nothing at all.
  assert.equal(coverageNote({ rows: 0, of: 0 }), null);
  assert.equal(coverageNote({ rows: 40, of: 40 }), null);
  assert.match(coverageNote({ rows: 3, of: 40 }), /^Partial — 3 of 40 rows/);
  assert.match(coverageNote({ rows: 0, of: 40 }), /^No data — 0 of 40 rows/);
});
