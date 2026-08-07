/**
 * lib/facts.ts — the two things in the fact layer that are not PostgreSQL's.
 *
 * Everything else this module does is a claim about what a real server did with
 * a real watermark, and that is asserted by
 * `contract/runtime/probes/07-fact-tables.probe.mjs` against a live database
 * rather than restated here. What is left is arithmetic and one constant, and
 * both are load-bearing:
 *
 * RATE EXTRACTION. `sql/facts.sql` decomposes cost by multiplying token counts
 * by rates that lib/facts.ts hands it. Those rates are not read out of the
 * pricing table — pricing.ts exports no table — they are measured by asking
 * `costUsd` what a million tokens of one class costs. If that measurement is
 * off, every dollar in every chart is off, silently, and in whichever direction
 * flatters the model that happens to be misread. So the tests below check the
 * extraction against `costUsd` itself on token counts that exercise all four
 * classes at once.
 *
 * THE WEDGE THRESHOLD. `outcome = 'wedged'` uses a number that also lives in
 * lib/fleet.ts, which does not export it. A silent divergence would put the
 * fleet banner and the fact table in disagreement about the same turn, so the
 * last test reads fleet.ts and fails if the two ever drift.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { STUCK_TURN_MS, effectiveRates } from "../lib/facts.ts";
import { costUsd, findPrice } from "../lib/pricing.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

test("a model that states every rate is extracted exactly", () => {
  // anthropic/claude-sonnet-5 is the model templates/default picks when
  // EVESTACK_PROVIDER is anthropic, and it states all four.
  const stated = findPrice("anthropic/claude-sonnet-5");
  assert.deepEqual(effectiveRates("anthropic/claude-sonnet-5"), {
    input: stated.input,
    output: stated.output,
    cacheRead: stated.cacheRead,
    cacheWrite: stated.cacheWrite,
  });
});

test("an unstated cache-write rate comes back as the input rate, never as zero", () => {
  // 173 of the 206 generated models state no cache-write rate. These are prompt
  // tokens the provider read and billed; a class quietly worth nothing is the
  // same lie as an unpriced model rendering $0.00.
  const price = findPrice("openai/gpt-5-mini");
  assert.equal(price.cacheWrite, undefined);
  const rates = effectiveRates("openai/gpt-5-mini");
  assert.equal(rates.cacheWrite, price.input);
  assert.notEqual(rates.cacheWrite, 0);
  assert.equal(rates.cacheRead, price.cacheRead);
});

test("an unstated cache-read rate comes back as a tenth of input", () => {
  const price = findPrice("meta/llama-3.3-70b");
  assert.equal(price.cacheRead, undefined);
  const rates = effectiveRates("meta/llama-3.3-70b");
  assert.equal(rates.cacheRead, price.input * 0.1);
  assert.equal(rates.cacheWrite, price.input);
});

test("free and unpriced are different answers", () => {
  // ollama/* is priced, at zero, because local inference costs no API money.
  assert.deepEqual(effectiveRates("ollama/qwen3"), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
  // Nothing has said what this costs. Zero would be a number; null is the truth.
  assert.equal(effectiveRates("acme/experimental-v1"), null);
  assert.equal(effectiveRates(null), null);
  assert.equal(effectiveRates(""), null);
});

test("rate × tokens reproduces costUsd, which is what the SQL relies on", () => {
  // sql/facts.sql multiplies these rates by these token counts. If the two
  // disagree the fact table's dollars are not pricing.ts's dollars, and nothing
  // in the type system can see it.
  const models = [
    "anthropic/claude-sonnet-5",
    "openai/gpt-5-mini",
    "meta/llama-3.3-70b",
    "ollama/qwen3",
    "minimax/minimax-m2.5-highspeed", // states a cache write BELOW the input rate
  ];
  const tuples = [
    // input, output, cacheRead, cacheWrite — cache classes live INSIDE input.
    [10_000, 2_000, 0, 0],
    [10_000, 2_000, 4_000, 0],
    [10_000, 2_000, 0, 3_000],
    [10_000, 2_000, 4_000, 3_000],
    [0, 0, 0, 0],
    // Every input token cached: the non-cached remainder is exactly zero.
    [5_000, 100, 2_000, 3_000],
  ];

  for (const model of models) {
    const rates = effectiveRates(model);
    assert.ok(rates, `${model} should be priced`);
    for (const [input, output, cacheRead, cacheWrite] of tuples) {
      const nonCached = Math.max(0, input - cacheRead - cacheWrite);
      const recomposed =
        (nonCached / 1e6) * rates.input +
        (output / 1e6) * rates.output +
        (cacheRead / 1e6) * rates.cacheRead +
        (cacheWrite / 1e6) * rates.cacheWrite;
      const expected = costUsd(model, input, output, cacheRead, cacheWrite);
      assert.ok(
        Math.abs(recomposed - expected) < 1e-12,
        `${model} ${input}/${output}/${cacheRead}/${cacheWrite}: ${recomposed} vs ${expected}`,
      );
    }
  }
});

test("the wedge threshold still matches lib/fleet.ts", () => {
  // fleet.ts does not export STUCK_TURN_MS, so lib/facts.ts mirrors the value
  // and this reads the source to prove the mirror is still true. Two different
  // thresholds would mean the fleet banner and fact_turn disagree about whether
  // the same turn is wedged.
  const fleet = readFileSync(join(HERE, "../lib/fleet.ts"), "utf8");
  const match = /const STUCK_TURN_MS = ([^;]+);/.exec(fleet);
  assert.ok(match, "lib/fleet.ts still declares STUCK_TURN_MS");
  // eslint-disable-next-line no-new-func
  const fleetValue = Function(`"use strict"; return (${match[1]});`)();
  assert.equal(
    STUCK_TURN_MS,
    fleetValue,
    `lib/facts.ts says ${STUCK_TURN_MS}ms and lib/fleet.ts says ${fleetValue}ms`,
  );
});
