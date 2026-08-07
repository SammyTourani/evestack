/**
 * components/ui/time-range.ts — what a window means, right now.
 *
 * Three claims, each guarding a page that would otherwise render confidently
 * and wrongly. That the preset list has not drifted away from the one
 * `/monitors` already ships, so the same question does not get two answers on
 * two pages. That a preset is resolved against a clock the caller pins, so a
 * server render and its hydration do not disagree. And that an id nobody
 * recognises — a bookmark to a preset that has since been removed — falls back
 * rather than throwing or drawing a blank.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { WINDOWS } from "../lib/monitors.ts";
import { DEFAULT_RANGE, PRESETS, resolveRange } from "../components/ui/time-range.ts";

const NOW = Date.parse("2026-08-06T12:00:00Z");

test("the presets still contain every window lib/monitors.ts offers", () => {
  // The monitors page has shipped a 1h/6h/12h/24h/7d selector since cfbff14.
  // If that list moves and this one does not, the same question gets two
  // different answers on two pages.
  const hours = PRESETS.map((p) => p.ms / 3_600_000);
  for (const window of WINDOWS) {
    assert.ok(hours.includes(window), `no preset for ${window}h`);
  }
});

test("a preset resolves against the clock it is given", () => {
  const range = resolveRange({ kind: "preset", id: "24h" }, NOW);
  assert.equal(range.from, "2026-08-05T12:00:00.000Z");
  assert.equal(range.to, "2026-08-06T12:00:00.000Z");
  assert.equal(range.label, "Last 24 hours");
});

test("an unknown preset falls back to the default instead of throwing", () => {
  // The case: someone's bookmark says ?range=90d after 90d was removed.
  const range = resolveRange({ kind: "preset", id: "90d" }, NOW);
  const fallback = resolveRange(DEFAULT_RANGE, NOW);
  assert.equal(range.from, fallback.from);
  assert.equal(range.label, fallback.label);
});

test("an absolute range keeps its own instants and reads as a pair", () => {
  const range = resolveRange(
    { kind: "absolute", fromMs: Date.parse("2026-08-01T00:00:00Z"), toMs: NOW },
    // A different `now` must not move an absolute window.
    Date.parse("2027-01-01T00:00:00Z"),
  );
  assert.equal(range.from, "2026-08-01T00:00:00.000Z");
  assert.equal(range.to, "2026-08-06T12:00:00.000Z");
  assert.match(range.label, /Aug 1 00:00 UTC → Aug 6 12:00 UTC/);
});
