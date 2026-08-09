/**
 * The first tests this package has had, which is the point.
 *
 * It is the default-on money guard — $2 a session, $10 a principal-day, in every
 * scaffolded project whether or not its owner ever thought about budgets — and
 * nothing in it was executed by CI. `pnpm -r --if-present test` skipped it,
 * because there was no `test` script to find.
 *
 * These cover the two pure halves: what a model costs, and whether that trips a
 * cap. The store and the hook need Postgres and a live session, and are exercised
 * from contract/runtime instead.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// From dist/, not src/. `src/hook.ts` imports its siblings as `./cancel.js` —
// TypeScript's convention for what is really a .ts file — and Node's type
// stripping does not rewrite those specifiers, so importing the source directly
// dies on a module that does not exist under that name. The `test` script builds
// first, so this is always the code that would ship.
import { costUsd, isPriced } from "../dist/pricing.js";
import { evaluate } from "../dist/hook.js";
import { resolveConfig } from "../dist/config.js";

/** A config built from the shipped defaults, with nothing inherited from the
 *  ambient environment — otherwise these pass or fail depending on the shell. */
function defaults(env = {}) {
  const keys = [
    "EVESTACK_BUDGET_SESSION_USD",
    "EVESTACK_BUDGET_DAILY_USD",
    "EVESTACK_BUDGET_DISABLED",
    "EVESTACK_BUDGET_UNPRICED",
    "EVESTACK_PROVIDER",
    "EVESTACK_MODEL",
    "EVESTACK_BUDGET_MODEL",
    "EVESTACK_PRICING",
  ];
  const saved = {};
  for (const key of keys) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, env);
  try {
    return resolveConfig();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

const totals = (sessionUsd, dayUsd = 0) => ({
  session: { costUsd: sessionUsd, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, steps: 0 },
  principalDay: { costUsd: dayUsd, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, steps: 0 },
});

/* -------------------------------------------------------------------------- */
/* the caps themselves                                                         */
/* -------------------------------------------------------------------------- */

test("the shipped defaults are 2 dollars a session and 10 a principal-day", () => {
  const config = defaults();
  assert.equal(config.sessionUsd, 2);
  assert.equal(config.dailyUsd, 10);
});

test("the session cap trips AT the limit, not one cent past it", () => {
  const config = defaults();
  assert.equal(evaluate(config, totals(1.99)).exceeded, false);
  assert.equal(evaluate(config, totals(2)).exceeded, true, "at the cap is over the cap");
  assert.equal(evaluate(config, totals(2)).scope, "session");
});

test("the session cap is checked before the daily one", () => {
  // Both over. Session wins, because it is the one a user can act on inside the
  // conversation they are actually having.
  assert.equal(evaluate(defaults(), totals(5, 50)).scope, "session");
});

test("the daily cap still applies when the session is cheap", () => {
  const verdict = evaluate(defaults(), totals(0.1, 10));
  assert.equal(verdict.exceeded, true);
  assert.notEqual(verdict.scope, "session");
});

test("an axis set to false is not a zero cap", () => {
  // The distinction that would otherwise stop every turn instantly: `false` means
  // "no limit on this axis"; 0 would mean "everything is already over".
  const config = defaults({ EVESTACK_BUDGET_SESSION_USD: "false" });
  assert.equal(config.sessionUsd, false);
  assert.equal(evaluate(config, totals(1000)).exceeded, false);
});

/* -------------------------------------------------------------------------- */
/* pricing — what makes a cap enforceable at all                                */
/* -------------------------------------------------------------------------- */

test("every local model is priced, at zero, through the ollama wildcard", () => {
  // Load-bearing and not obvious: "unpriced" and "free" are different states
  // here. A local model is priced at zero because that is the truth about it, so
  // a stricter posture toward unpriced models could not break a local project.
  for (const model of ["ollama/qwen3", "ollama/llama3.3", "ollama/anything-at-all"]) {
    assert.equal(isPriced(model), true, model);
    assert.equal(costUsd(model, 1_000_000, 1_000_000, 0), 0, model);
  }
});

test("a paid model in the table costs real money", () => {
  assert.equal(isPriced("openai/gpt-5-mini"), true);
  assert.ok((costUsd("openai/gpt-5-mini", 1_000_000, 200_000, 0) ?? 0) > 0);
});

test("a DATED SNAPSHOT of a paid model is unpriced, so its steps record $0.00", () => {
  // The hole the README lists under "Known holes", pinned here so it cannot move
  // in either direction unnoticed. Pinning a dated snapshot is ordinary practice,
  // which is what makes this the likely way to reach it.
  assert.equal(isPriced("openai/gpt-5-mini"), true);
  assert.equal(isPriced("openai/gpt-5-mini-2026-08-01"), false);
  assert.equal(costUsd("openai/gpt-5-mini-2026-08-01", 20_000_000, 4_000_000, 0), 0);

  // And therefore traffic worth real money records as nothing, and the default
  // cap cannot see it. This asserts the DOCUMENTED behaviour, not an aspiration:
  // if it ever flips, that is a deliberate decision, and this is where it gets
  // recorded rather than discovered.
  const config = defaults({ EVESTACK_PROVIDER: "openai", EVESTACK_MODEL: "gpt-5-mini-2026-08-01" });
  assert.equal(config.unpricedModel, "warn", "the shipped default is warn");
  assert.equal(evaluate(config, totals(0)).exceeded, false);
});

test("EVESTACK_PRICING closes the hole, which is what the message promises", () => {
  // In a CHILD process, with the variable set before anything imports the module.
  //
  // Not fussiness: the merged table is built on first use and cached for the life
  // of the process, deliberately, because `findPrice` runs per turn row and the
  // generated table is large. So setting EVESTACK_PRICING partway through this
  // file would do nothing, and asserting that it did nothing would look exactly
  // like the override being broken. It is not — a real deployment sets the
  // variable before the agent starts, which is what this reproduces.
  const script = `
    const { isPriced, costUsd } = await import("../dist/pricing.js");
    console.log(JSON.stringify({
      priced: isPriced("openai/gpt-5-mini-2026-08-01"),
      cost: costUsd("openai/gpt-5-mini-2026-08-01", 1000000, 200000, 0),
    }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: import.meta.dirname,
    encoding: "utf8",
    env: {
      ...process.env,
      EVESTACK_PRICING: JSON.stringify({
        "openai/gpt-5-mini-2026-08-01": { input: 0.25, output: 2 },
      }),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const { priced, cost } = JSON.parse(result.stdout);
  assert.equal(priced, true, "an override makes a dated snapshot priced");
  assert.ok(cost > 0, `and it costs money: ${cost}`);
});

test("EVESTACK_BUDGET_UNPRICED=stop is a real setting, not just prose in a README", () => {
  assert.equal(defaults({ EVESTACK_BUDGET_UNPRICED: "stop" }).unpricedModel, "stop");
  assert.equal(defaults({ EVESTACK_BUDGET_UNPRICED: "warn" }).unpricedModel, "warn");
  // Anything else reads as warn rather than erroring: this is a cost control, and
  // a typo in it must not be the thing that stops an agent.
  assert.equal(defaults({ EVESTACK_BUDGET_UNPRICED: "stahp" }).unpricedModel, "warn");
});

test("the model key is provider-qualified, so one name on two providers prices apart", () => {
  assert.equal(defaults({ EVESTACK_PROVIDER: "ollama", EVESTACK_MODEL: "qwen3" }).model, "ollama/qwen3");
  assert.equal(defaults({ EVESTACK_PROVIDER: "openai" }).model, "openai/gpt-5-mini");
  // An id that already names its provider passes through untouched.
  assert.equal(
    defaults({ EVESTACK_MODEL: "anthropic/claude-sonnet-5" }).model,
    "anthropic/claude-sonnet-5",
  );
  // The case the three above missed, and the only one that was broken: the
  // provider set and the model left unset, which is exactly what .env.example
  // documents for anthropic. It resolved "anthropic/gpt-5-mini" — a key with no
  // price and no wildcard behind it — so every step cost $0.00, the $2 and $10
  // caps could never trip, and EVESTACK_BUDGET_UNPRICED=stop (which that same
  // file recommends) instead stopped the first step of every turn. A default
  // model that only one of the two halves knows about is not a small drift.
  assert.equal(defaults({ EVESTACK_PROVIDER: "anthropic" }).model, "anthropic/claude-sonnet-5");
  assert.equal(isPriced("anthropic/claude-sonnet-5"), true);
  assert.equal(isPriced("anthropic/gpt-5-mini"), false, "which is why the drift was fatal, not cosmetic");
  // And the cap can now see the money: priced means costUsd returns a number an
  // accumulating total can eventually compare against a cap.
  assert.ok(costUsd("anthropic/claude-sonnet-5", 1_000_000, 200_000, 0) > 0);
});

/**
 * The hook must charge for cache WRITES, and for a while it did not.
 *
 * `costUsd(model, input, output, cacheRead, cacheWrite)` takes five arguments.
 * hook.ts called it with four, so `cacheWriteTokens` fell to its `= 0` default
 * on every step — while eve reports the number (its own ZERO_TOKEN_USAGE is
 * `{cacheReadTokens, cacheWriteTokens, inputTokens, outputTokens}`) and
 * pricing.ts has always accepted it.
 *
 * That is not an under-report, it is an under-CHARGE: `cost` is the number the
 * cap is measured against, so a prompt-caching workload could pass its limit
 * without tripping. On Anthropic a cache write is billed above the input rate.
 *
 * Asserted against the source text because the hook needs Postgres and a live
 * session to run — the same reason the header above gives for what is not
 * covered here — and a four-argument call is exactly the shape that regressed.
 * composio-identity.test.mjs uses the same technique for the same reason.
 */
test("the spend hook passes cache-write tokens to the price function", () => {
  const src = readFileSync(new URL("../src/hook.ts", import.meta.url), "utf8");

  assert.match(
    src,
    /const cacheWriteTokens = usage\.cacheWriteTokens \?\? 0;/,
    "the hook must read cacheWriteTokens off the usage eve reports",
  );

  const call = /costUsd\(\s*config\.model,\s*inputTokens,\s*outputTokens,\s*cacheReadTokens,\s*cacheWriteTokens,?\s*\)/;
  assert.match(src, call, "costUsd must be called with all five arguments, cache writes last");
});

/**
 * And the price function must actually charge for them, or the above is theatre.
 *
 * Cache writes are a SUBSET of inputTokens — costUsd subtracts reads and writes
 * to get the non-cached remainder — so the realistic shape is one million input
 * tokens OF WHICH some were writes, not a million writes beside a million
 * inputs. Passing the latter trips the package's own impossible-split warning,
 * which is itself the right behaviour and not what this test is about.
 */
test("dropping the cache-write argument undercharges where a provider prices writes higher", () => {
  const M = 1_000_000;
  const charged = costUsd("anthropic/claude-sonnet-5", M, 0, 0, 0);
  const correct = costUsd("anthropic/claude-sonnet-5", M, 0, 0, 0.4 * M);
  assert.ok(
    correct > charged,
    `sonnet-5 prices a write above input, so omitting it must undercharge (${charged} vs ${correct})`,
  );

  // And the reason it went unnoticed: on the DEFAULT provider there is no gap,
  // because gpt-5-mini publishes no cache-write rate and pricing.ts falls back
  // to the input rate. A test that only exercised the default would pass either
  // way, which is worth pinning so nobody "simplifies" this to one model.
  assert.equal(
    costUsd("openai/gpt-5-mini", M, 0, 0, 0),
    costUsd("openai/gpt-5-mini", M, 0, 0, 0.4 * M),
    "gpt-5-mini has no published write rate, so the two must agree",
  );
});
