/**
 * lib/pricing.ts — every dollar figure in the dashboard.
 *
 * Two failure modes matter more than accuracy of any single number.
 *
 * The first is a model the table has never heard of rendering as $0.00. There
 * is no visual difference between "this run was free" and "we have no idea what
 * this run cost", and the second one silently under-reports spend forever. The
 * contract that prevents it is `isPriced()`: callers must gate on it, and it
 * must be false for anything unknown.
 *
 * The second is double-billing cached reads. eve reports cache reads INSIDE the
 * input total, so charging both at the input rate and at the cache rate
 * overstates every cached turn — and cached turns are the common case for an
 * agent with a long system prompt.
 *
 * The third is a token class charged at the wrong rate, or at no rate at all.
 * Cache writes arrive inside the input total too, and 33 models charge a
 * premium to write a cache entry; a class that silently costs nothing is the
 * same lie as an unpriced model rendering $0.00, just harder to see.
 *
 * Nothing here opens a socket; the table is committed literals and the tests
 * are arithmetic over them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { costUsd, findPrice, formatUsd, isPriced } from "../lib/pricing.ts";

/**
 * The merged table is built once, lazily, on the first lookup. If the machine
 * running the tests happens to export EVESTACK_PRICING, every expectation below
 * would be measured against that operator's negotiated rates instead of the
 * committed ones — so it is cleared here, before any test body runs a lookup.
 * The override is tested through a separately loaded copy of the module.
 */
delete process.env.EVESTACK_PRICING;

/** A model the generated table prices, with explicit cache-read AND cache-write rates. */
const SONNET = "anthropic/claude-sonnet-5";
/** One of the 66 priced models that state no cache-read rate. */
const NO_CACHE_RATE = "meta/llama-3.3-70b";
/**
 * One of the 173 priced models that state no cache-WRITE rate, while stating a
 * cache-read one. The seeded dataset runs this model, so the fallback below is
 * on the common path, not a corner.
 */
const NO_WRITE_RATE = "openai/gpt-5-mini";
/**
 * The two states the seeded dataset keeps distinct, and that the UI must never
 * collapse: `ollama/qwen3` is FREE (local inference costs no API money) and
 * `acme/experimental-v1` is UNPRICED (no catalog entry, cost unknown).
 */
const FREE = "ollama/qwen3";
const UNPRICED = "acme/experimental-v1";

const M = 1_000_000;

/* -------------------------------------------------------------------------- */
/* unknown models                                                              */
/* -------------------------------------------------------------------------- */

test("an unknown model is unpriced, never priced at zero", () => {
  for (const model of [
    "openai/gpt-9",
    "anthropic/claude-opus-99",
    "some-vendor/whatever",
    "gpt-5-mini",
    "",
    null,
  ]) {
    assert.equal(isPriced(model), false, JSON.stringify(model));
    assert.equal(findPrice(model), null, JSON.stringify(model));
  }
});

test("$0.00 and 'unpriced' are only distinguishable through isPriced", () => {
  // costUsd has to return a number, so it returns 0 for a model it cannot
  // price — and formatUsd renders 0 as "$0.00". That pair is precisely why the
  // UI must ask isPriced first. This test is the executable statement of that
  // contract: if it ever passes with isPriced true, an unknown model has
  // started rendering as free.
  assert.equal(costUsd("openai/gpt-9", 1_000_000, 1_000_000), 0);
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(isPriced("openai/gpt-9"), false);
});

test("the two models templates/default reaches for are priced", () => {
  // A regeneration that drops or renames either of these makes the DEFAULT
  // scaffolded deployment show every run as unpriced, which is the one
  // configuration nobody would think to check.
  assert.equal(isPriced(SONNET), true);
  assert.equal(isPriced("openai/gpt-5-mini"), true);
});

/* -------------------------------------------------------------------------- */
/* cache reads                                                                 */
/* -------------------------------------------------------------------------- */

test("cached reads are subtracted from billable input, not billed twice", () => {
  const price = findPrice(SONNET);
  assert.ok(price.cacheRead, "this test is only meaningful on a model with a stated cache rate");

  // 1000 input tokens of which 400 were cache hits: 600 at the input rate and
  // 400 at the cache rate. Billing all 1000 at input AND 400 at cache — the
  // bug — would come to a strictly larger number.
  const split = costUsd(SONNET, 1000, 0, 400);
  assert.equal(split, (600 / M) * price.input + (400 / M) * price.cacheRead);

  const doubleBilled = (1000 / M) * price.input + (400 / M) * price.cacheRead;
  assert.ok(split < doubleBilled);
});

test("an entirely cached turn costs the cache rate and nothing else", () => {
  const price = findPrice(SONNET);
  assert.equal(costUsd(SONNET, 1000, 0, 1000), (1000 / M) * price.cacheRead);
});

test("more cache reads than input tokens cannot produce a negative charge", (t) => {
  // Upstream counters have disagreed before; a negative row would silently
  // subtract from the session total and make an expensive session look cheap.
  // The floor also warns now — that is asserted on its own model below, and
  // muted here so it does not colour the output of a test about arithmetic.
  t.mock.method(console, "warn", () => {});
  const price = findPrice(SONNET);
  assert.equal(costUsd(SONNET, 100, 0, 1000), (1000 / M) * price.cacheRead);
  assert.ok(costUsd(SONNET, 0, 0, 1000) > 0);
});

test("a model with no stated cache rate falls back to a tenth of input", () => {
  const price = findPrice(NO_CACHE_RATE);
  assert.equal(price.cacheRead, undefined, "fixture chosen because the catalog states no rate");
  assert.equal(costUsd(NO_CACHE_RATE, 1000, 0, 1000), (1000 / M) * price.input * 0.1);
});

test("input, output and cache are each charged at their own rate", () => {
  const price = findPrice(SONNET);
  assert.equal(costUsd(SONNET, 1_000_000, 1_000_000, 0), price.input + price.output);
  assert.equal(costUsd(SONNET, 0, 0, 0), 0);
  // cacheReadTokens is optional and must default to none rather than to
  // "everything was cached".
  assert.equal(costUsd(SONNET, 1_000_000, 0), price.input);
});

/* -------------------------------------------------------------------------- */
/* cache writes                                                                */
/* -------------------------------------------------------------------------- */

test("cache writes are charged at the cache-write rate, not the input rate", () => {
  const price = findPrice(SONNET);
  assert.ok(price.cacheWrite, "fixture chosen because the catalog states a write rate");
  assert.ok(price.cacheWrite > price.input, "and because writing costs MORE than plain input");

  // 1000 input tokens of which 400 wrote a cache entry: 600 non-cached and 400
  // at the write rate. Billing all 1000 at the plain input rate — what happens
  // when the write count is dropped on the floor — under-reports the turn.
  const split = costUsd(SONNET, 1000, 0, 0, 400);
  assert.equal(split, (600 / M) * price.input + (400 / M) * price.cacheWrite);

  const asPlainInput = (1000 / M) * price.input;
  assert.ok(split > asPlainInput, "the 1.25x write premium has to show up somewhere");
});

test("non-cached, cache-read and cache-write are three disjoint classes", () => {
  // The decomposition Datadog's ml_obs model uses. All three counts live inside
  // `$eve.input_tokens`, so each token is charged exactly once, at one rate.
  const price = findPrice(SONNET);
  assert.equal(
    costUsd(SONNET, 1000, 500, 300, 200),
    (500 / M) * price.input +
      (500 / M) * price.output +
      (300 / M) * price.cacheRead +
      (200 / M) * price.cacheWrite,
  );
});

test("a model with no stated cache-write rate bills writes as input, never as free", () => {
  // Be honest about what this one is worth: charging the input rate produces
  // the identical number the four-argument signature produced, so no input can
  // make it disagree with the old code. It is not here to. What it pins is the
  // tempting `?? 0` — the one-character version of this fallback that makes a
  // whole token class free for 173 of the 206 priced models, including the one
  // the seeded dataset runs. Under `?? 0` the first assertion reads 600 tokens
  // of input instead of 1000, and the last reads $0.00.
  const price = findPrice(NO_WRITE_RATE);
  assert.equal(price.cacheWrite, undefined, "fixture chosen because the catalog states no rate");

  assert.equal(costUsd(NO_WRITE_RATE, 1000, 0, 0, 400), (1000 / M) * price.input);
  assert.equal(
    costUsd(NO_WRITE_RATE, 1000, 0, 0, 400),
    costUsd(NO_WRITE_RATE, 1000, 0, 0, 0),
    "absent means the label changes nothing, not that the tokens were free",
  );
  // A turn that is nothing but cache writes still costs money.
  assert.equal(costUsd(NO_WRITE_RATE, 400, 0, 0, 400), (400 / M) * price.input);
  assert.ok(costUsd(NO_WRITE_RATE, 400, 0, 0, 400) > 0);
});

test("cache reads and writes together cannot drive input negative", (t) => {
  t.mock.method(console, "warn", () => {});
  const price = findPrice(SONNET);
  assert.equal(
    costUsd(SONNET, 100, 0, 300, 200),
    (300 / M) * price.cacheRead + (200 / M) * price.cacheWrite,
  );
  assert.ok(costUsd(SONNET, 0, 0, 0, 200) > 0);
});

test("a split that cannot be true says so instead of eating the surplus", (t) => {
  // Reads and writes are parts of the input total, so a negative remainder is
  // impossible from eve and means a counter is wrong. The floor that keeps the
  // charge non-negative also drops those input tokens on the floor — 382,813 of
  // them across 160 turns on the seeded month — and a third of a million tokens
  // vanishing without a word is how spend gets under-reported forever.
  //
  // A model of this test's own, because the warning fires once per model for
  // the life of the process and any other test that clamps would have consumed
  // it first.
  const model = "anthropic/claude-haiku-4.5";
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args.join(" ")));

  costUsd(model, 100, 0, 300, 200);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /anthropic\/claude-haiku-4\.5/);
  assert.match(warnings[0], /400/, "the surplus it is about to discard, in tokens");

  // Once per model: this runs per turn row on every render, so a bad fixture
  // must not print one line per row.
  costUsd(model, 0, 0, 900, 100);
  assert.equal(warnings.length, 1);
});

/* -------------------------------------------------------------------------- */
/* free is not unpriced                                                        */
/* -------------------------------------------------------------------------- */

test("the seeded free model and the seeded unpriced model do not collapse", () => {
  // Both render "$0.00" through formatUsd, which is exactly why the states have
  // to be distinguishable some other way. Every axis below has to disagree.
  assert.equal(costUsd(FREE, 9_000_000, 9_000_000, 1_000_000, 1_000_000), 0);
  assert.equal(costUsd(UNPRICED, 9_000_000, 9_000_000, 1_000_000, 1_000_000), 0);
  assert.equal(formatUsd(costUsd(FREE, 1000, 1000)), formatUsd(costUsd(UNPRICED, 1000, 1000)));

  assert.equal(isPriced(FREE), true, "local inference is free, and we know it");
  assert.equal(isPriced(UNPRICED), false, "no catalog entry: the cost is unknown, not zero");
});

/* -------------------------------------------------------------------------- */
/* the ollama wildcard                                                         */
/* -------------------------------------------------------------------------- */

test("every ollama/* model is priced, and priced at zero", () => {
  // The distinction that matters: free is NOT unknown. A local model must show
  // $0.00 with confidence, which means isPriced has to be true for a model no
  // catalog will ever list.
  for (const model of ["ollama/llama3.3", "ollama/qwen3:8b", "ollama/anything-at-all", "ollama/"]) {
    assert.equal(isPriced(model), true, model);
    assert.equal(costUsd(model, 5_000_000, 5_000_000, 1_000_000), 0, model);
  }
});

test("the wildcard matches on the slash, not on the vendor prefix", () => {
  // "ollamax/foo" is a different vendor and must not inherit free pricing.
  for (const model of ["ollamax/foo", "ollam/foo", "notollama/foo", "OLLAMA/llama3"]) {
    assert.equal(isPriced(model), false, model);
  }
});

/* -------------------------------------------------------------------------- */
/* the EVESTACK_PRICING override                                               */
/* -------------------------------------------------------------------------- */

/**
 * The merged table is memoised for the life of the process, so an override can
 * only be observed by a copy of the module that has not built its table yet.
 * The query string is what makes it a distinct module in the ESM cache.
 */
async function withPricing(json, body) {
  const before = process.env.EVESTACK_PRICING;
  if (json === undefined) delete process.env.EVESTACK_PRICING;
  else process.env.EVESTACK_PRICING = json;
  try {
    await body(await import(`../lib/pricing.ts?case=${encodeURIComponent(JSON.stringify(json))}`));
  } finally {
    if (before === undefined) delete process.env.EVESTACK_PRICING;
    else process.env.EVESTACK_PRICING = before;
  }
}

test("an operator's override beats the generated catalog", async () => {
  await withPricing(JSON.stringify({ [SONNET]: { input: 1, output: 4, cacheRead: 0.1 } }), (mod) => {
    assert.deepEqual(mod.findPrice(SONNET), { input: 1, output: 4, cacheRead: 0.1 });
    assert.equal(mod.costUsd(SONNET, 1_000_000, 1_000_000, 0), 5);
    // Everything it did not mention is untouched.
    assert.equal(mod.isPriced("openai/gpt-5-mini"), true);
  });
});

test("an override can price a model the catalog has never heard of", async () => {
  await withPricing(JSON.stringify({ "acme/private-model": { input: 3, output: 9 } }), (mod) => {
    assert.equal(mod.isPriced("acme/private-model"), true);
    assert.equal(mod.costUsd("acme/private-model", 1_000_000, 0), 3);
  });
});

test("an override can add a wildcard, and the wildcard scan is rebuilt with it", async () => {
  // The wildcard list is derived inside build(), so an override arriving after
  // a naive `{...defaults, ...overrides}` would be invisible to prefix lookup.
  await withPricing(JSON.stringify({ "acme/*": { input: 0, output: 0, cacheRead: 0 } }), (mod) => {
    assert.equal(mod.isPriced("acme/anything"), true);
    assert.equal(mod.costUsd("acme/anything", 9_000_000, 9_000_000), 0);
    // ...without disturbing the wildcard that was already there.
    assert.equal(mod.isPriced("ollama/llama3.3"), true);
  });
});

test("invalid EVESTACK_PRICING is ignored with a warning, not a crash", async (t) => {
  // A dashboard that will not boot because a JSON string lost a brace is worse
  // than one that bills at catalog rates and says so.
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args.join(" ")));

  await withPricing("{not json", (mod) => {
    assert.equal(mod.isPriced(SONNET), true);
    assert.equal(mod.costUsd(SONNET, 1_000_000, 0), findPrice(SONNET).input);
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /EVESTACK_PRICING/);
});

/* -------------------------------------------------------------------------- */
/* rendering                                                                   */
/* -------------------------------------------------------------------------- */

test("formatUsd keeps sub-cent amounts visible", () => {
  // Two decimals would print a real 0.0003 charge as "$0.00", which is the same
  // string an unpriced model produces — the confusion this whole file guards
  // against.
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(0.0003), "$0.0003");
  assert.equal(formatUsd(0.009999), "$0.0100");
  assert.equal(formatUsd(0.01), "$0.01");
  assert.equal(formatUsd(0.5), "$0.50");
  assert.equal(formatUsd(12.3456), "$12.35");
});
