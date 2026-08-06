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

/** A model the generated table prices, with an explicit cache-read rate. */
const SONNET = "anthropic/claude-sonnet-5";
/** One of the 66 priced models that state no cache-read rate. */
const NO_CACHE_RATE = "meta/llama-3.3-70b";

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

test("more cache reads than input tokens cannot produce a negative charge", () => {
  // Upstream counters have disagreed before; a negative row would silently
  // subtract from the session total and make an expensive session look cheap.
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
