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

// The same three functions as seen from OUTSIDE the package, which is not the
// same code. `../dist/pricing.js` above is the build-time copy of
// `packages/dashboard/lib/pricing.ts` — gitignored here and not editable from
// this package — and it is the unchecked lookup. What `@evestack/budget`
// exports, and what the hook prices with, is the wrapper in checked-pricing.ts.
// The catalog tests above are about the table and use the raw module on purpose;
// the tests at the bottom of this file are about the wrapper, and must not be
// able to pass by accident because they happened to import the other one.
import {
  costUsd as costUsdChecked,
  findPrice as findPriceChecked,
  isPriced as isPricedChecked,
} from "../dist/index.js";

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

/* -------------------------------------------------------------------------- */
/* EVESTACK_PRICING overrides — the shape nobody was checking                   */
/* -------------------------------------------------------------------------- */

/**
 * Runs a script against the built package with a controlled environment.
 *
 * Every test below needs `EVESTACK_PRICING` set before anything imports the
 * price table, for the reason the override test above already gives at length:
 * the merged table is built on first use and cached for the life of the process,
 * so setting the variable partway through this file would do nothing and the
 * assertion would look exactly like the feature being broken.
 *
 * `EVESTACK_PRICING` is deleted from the inherited environment rather than left
 * alone, so a variable in the developer's shell cannot decide these outcomes.
 * stdout carries the JSON the script prints and stderr carries the warnings,
 * which several of these are specifically about.
 */
function inChild(env, body) {
  const inherited = { ...process.env };
  delete inherited.EVESTACK_PRICING;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", body], {
    cwd: import.meta.dirname,
    encoding: "utf8",
    env: { ...inherited, ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  return { out: JSON.parse(result.stdout), warnings: result.stderr };
}

/**
 * The defect: an override missing a rate priced every step as NaN, silently.
 *
 * Reproduced against the built package on 2026-09-15 before this was fixed.
 * `EVESTACK_PRICING='{"acme/m1":{"input":0.25}}'` — someone adjusting a rate and
 * forgetting the other half of the pair, which is the likeliest way to get this
 * wrong — was `JSON.parse`d and spread into the merged table with no shape check
 * at all. Then:
 *
 *   costUsd("acme/m1", 1000, 1000)  →  NaN   (0.25 * x + undefined * y)
 *   isPriced("acme/m1")             →  true
 *   evaluate(...)                   →  "not exceeded", because NaN >= 2 is false
 *
 * and that NaN went to `recordStep`, which adds it into `cost_usd` on both the
 * session and the principal-day rows. `cost + NaN` is NaN, so one typo disabled
 * the cap for that principal for the rest of the day and stayed disabled after
 * the variable was corrected, because by then the damage was in Postgres.
 *
 * Every assertion here fails on the old code, and the first one fails as NaN.
 */
test("a half-written EVESTACK_PRICING override is rejected, not billed as NaN", () => {
  const { out, warnings } = inChild(
    { EVESTACK_PRICING: JSON.stringify({ "acme/m1": { input: 0.25 } }) },
    `
      const { costUsd, isPriced, findPrice } = await import("../dist/index.js");
      console.log(JSON.stringify({
        cost: costUsd("acme/m1", 1000, 1000),
        priced: isPriced("acme/m1"),
        price: findPrice("acme/m1"),
      }));
    `,
  );
  assert.equal(out.cost, 0, "an unusable override must not produce a number at all");
  assert.ok(!Number.isNaN(out.cost), "and specifically must not produce NaN");
  assert.equal(out.priced, false, "an override that cannot price a token is not a price");
  assert.equal(out.price, null);
  // Named, because an EVESTACK_PRICING with eight entries and one typo is the
  // case that matters and "some overrides were invalid" does not help anyone.
  assert.match(warnings, /acme\/m1/);
  assert.match(warnings, /"output" is missing/);
});

test("rejecting an override rejects the OVERRIDE, not the model it was aimed at", () => {
  // The distinction that decides where the validation has to live. Filtering bad
  // prices at lookup time would leave gpt-5-mini — a model the built-in table
  // prices perfectly well — unpriced, because the malformed entry shadows it in
  // the merged table. The right answer to "your override is unusable" is the
  // price the operator was trying to adjust, not no price.
  const { out } = inChild(
    { EVESTACK_PRICING: JSON.stringify({ "openai/gpt-5-mini": { input: 9 } }) },
    `
      const { findPrice, isPriced } = await import("../dist/index.js");
      console.log(JSON.stringify({
        price: findPrice("openai/gpt-5-mini"),
        priced: isPriced("openai/gpt-5-mini"),
      }));
    `,
  );
  assert.equal(out.priced, true, "the catalog still prices it");
  assert.equal(out.price.input, 0.25, "at the catalog rate, not the broken override's 9");
  assert.equal(out.price.output, 2);
});

test("a well-formed override still wins, which is the whole point of the variable", () => {
  // Validation that broke the documented feature would be a worse outcome than
  // the bug. A good entry survives untouched, a bad one beside it does not take
  // it down with it, and the variable is rewritten to exactly the survivors.
  const { out } = inChild(
    {
      EVESTACK_PRICING: JSON.stringify({
        "acme/good": { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
        "acme/bad": { input: 1 },
      }),
    },
    `
      const { findPrice, costUsd } = await import("../dist/index.js");
      console.log(JSON.stringify({
        good: findPrice("acme/good"),
        bad: findPrice("acme/bad"),
        cost: costUsd("acme/good", 1000000, 1000000),
        env: process.env.EVESTACK_PRICING,
      }));
    `,
  );
  assert.deepEqual(out.good, { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 });
  assert.equal(out.bad, null);
  assert.equal(out.cost, 3, "1M input at $1 plus 1M output at $2");
  assert.deepEqual(JSON.parse(out.env), { "acme/good": { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } });
});

test("every way an override can fail to be a price is refused the same way", () => {
  // Zero is deliberately absent from this list: it is a legitimate rate, and the
  // ollama and chatgpt wildcards depend on it. Negative is here because a
  // negative rate makes an expensive step LOWER a running total, which is the
  // same poisoning failure wearing a different hat.
  const { out, warnings } = inChild(
    {
      EVESTACK_PRICING: JSON.stringify({
        "bad/missing-input": { output: 2 },
        "bad/negative": { input: -1, output: 2 },
        "bad/string": { input: "0.25", output: "2" },
        "bad/null": null,
        "bad/cache-read": { input: 1, output: 2, cacheRead: "cheap" },
        "bad/infinite": { input: 1, output: 1e999 },
        "ok/zero": { input: 0, output: 0 },
      }),
    },
    `
      const { findPrice } = await import("../dist/index.js");
      const ids = ["bad/missing-input","bad/negative","bad/string","bad/null","bad/cache-read","bad/infinite","ok/zero"];
      console.log(JSON.stringify(Object.fromEntries(ids.map((id) => [id, findPrice(id)]))));
    `,
  );
  for (const id of Object.keys(out)) {
    if (id.startsWith("ok/")) continue;
    assert.equal(out[id], null, `${id} must not be a price`);
    assert.match(warnings, new RegExp(id.replace("/", "\\/")), `${id} must be named in the warning`);
  }
  assert.deepEqual(out["ok/zero"], { input: 0, output: 0 }, "zero is a rate, not a mistake");
});

test("EVESTACK_PRICING that is not an object at all is refused once, not twice", () => {
  for (const raw of ["not json at all", "[1,2,3]", '"a string"']) {
    const { out, warnings } = inChild({ EVESTACK_PRICING: raw }, `
      const { isPriced } = await import("../dist/index.js");
      console.log(JSON.stringify({ stillWorks: isPriced("openai/gpt-5-mini") }));
    `);
    assert.equal(out.stillWorks, true, `${raw} must not take the built-in table down with it`);
    assert.match(warnings, /EVESTACK_PRICING/);
    // One line, not two. The table in pricing.ts warns about unparseable JSON as
    // well, so leaving the variable in place for it to find printed the same
    // mistake twice in different words.
    assert.equal(
      warnings.split("\n").filter((line) => line.includes("EVESTACK_PRICING")).length,
      1,
      `${raw} warns exactly once`,
    );
  }
});

/**
 * The other half of the same defect: the lookup answered for Object.prototype.
 *
 * `findPrice` was `known[model]` over an object literal, so every property
 * JavaScript hangs off every object came back as a price. Measured before the
 * fix: `findPrice("constructor")` returned the `Object` constructor FUNCTION,
 * `isPriced("toString")` and `isPriced("__proto__")` were both true, and costing
 * any of them was NaN — a function has no `input` — which is the poisoning route
 * above reached without any environment variable at all.
 *
 * No override needed, so this one runs in process.
 */
test("Object.prototype members are not models, and are not prices", () => {
  for (const name of [
    "constructor",
    "toString",
    "valueOf",
    "__proto__",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
  ]) {
    assert.equal(findPriceChecked(name), null, name);
    assert.equal(isPricedChecked(name), false, name);
    assert.equal(costUsdChecked(name, 1_000_000, 1_000_000), 0, name);
  }
});

/* -------------------------------------------------------------------------- */
/* a total that is already poisoned                                            */
/* -------------------------------------------------------------------------- */

/**
 * `NaN >= 2` is false, so a poisoned column read as UNDER the cap.
 *
 * This is why the NaN above survived its own cause being fixed: the bad number
 * is in `evestack.budget_usage` now, every later step adds to it, and `evaluate`
 * answered "not exceeded" on every one of them. An install that already has such
 * a row gets no benefit from the two locks in front of the store — it needs the
 * comparison itself to stop trusting a number that is not one.
 *
 * Fails closed rather than warning, and has no environment switch, because there
 * is no deployment in which NaN is the true amount of money spent — a working
 * install takes none of these branches.
 */
test("a total that is not a number fails closed instead of reading as under the cap", () => {
  const config = defaults();
  for (const poison of [NaN, Infinity, -Infinity]) {
    const session = evaluate(config, totals(poison));
    assert.equal(session.exceeded, true, `session total ${String(poison)}`);
    assert.equal(session.scope, "session");
    assert.match(session.reason, /budget_usage/, "and says which table to look at");

    const daily = evaluate(config, totals(0.5, poison));
    assert.equal(daily.exceeded, true, `day total ${String(poison)}`);
    assert.equal(daily.scope, "principal-day");
  }
  // An axis nobody capped has nothing to compare against, so it has nothing to
  // fail closed about — otherwise EVESTACK_BUDGET_DISABLED would stop failing to
  // stop things, which is the one thing it promises.
  const uncapped = defaults({ EVESTACK_BUDGET_SESSION_USD: "false", EVESTACK_BUDGET_DAILY_USD: "false" });
  assert.equal(evaluate(uncapped, totals(NaN, NaN)).exceeded, false);
  // And an ordinary number is still an ordinary number.
  assert.equal(evaluate(config, totals(1.99)).exceeded, false);
  assert.equal(evaluate(config, totals(2)).exceeded, true);
});

/**
 * The remediation this message prints has to work in Postgres, not in JavaScript.
 *
 * Failing closed on a poisoned row is only half an answer: the other half is the
 * statement that unpoisons it, and the operator reading this is already stuck —
 * every turn is being refused — so a statement that reports `UPDATE 0` and
 * changes nothing is worse than printing none at all.
 *
 * The first version of this message printed `NOT (cost_usd = cost_usd)`, which is
 * how you find a NaN in JavaScript and in most other languages, and which matches
 * nothing here. Postgres deliberately departs from IEEE 754 so that numerics can
 * be sorted and indexed: NaN compares EQUAL to NaN, and greater than every
 * non-NaN value. `x <> x` is therefore always false, `cost_usd = 'NaN'::numeric`
 * is the predicate that selects the row, and `cost_usd IS NULL` was dead in the
 * same breath because the column is `NOT NULL DEFAULT 0`.
 */
test("the way out of a poisoned row is SQL Postgres will actually match", () => {
  const reason = evaluate(defaults(), totals(NaN)).reason;
  assert.match(reason, /UPDATE evestack\.budget_usage SET cost_usd = 0/);
  assert.match(reason, /cost_usd = 'NaN'::numeric/, "the predicate Postgres matches on");
  assert.doesNotMatch(
    reason,
    /NOT \(cost_usd = cost_usd\)/,
    "NaN <> NaN is false in Postgres, so this selects no rows and leaves the install stuck",
  );
});

/**
 * The store refuses the write, so a future bug of this shape cannot be durable.
 *
 * Checked BEFORE the connection is opened, which is what this asserts: with no
 * database configured at all, a non-finite cost must produce the refusal and not
 * `getPool`'s "needs WORKFLOW_POSTGRES_URL". Order matters because the whole
 * value of the guard is that it runs on a machine where the write would
 * otherwise have succeeded.
 *
 * `hook.ts` catches this exactly like a Postgres outage — log loudly, honour
 * EVESTACK_BUDGET_FAIL_CLOSED, keep serving — so the cost is one uncounted step
 * against a total that stays addable.
 */
test("the spend store refuses a cost that cannot be added up", async () => {
  const { recordStep } = await import("../dist/store.js");
  const step = {
    sessionId: "wrun_1",
    principalId: "alice",
    turnId: "turn_0",
    stepIndex: 0,
    sequence: 0,
    day: "2026-09-15",
    model: "acme/m1",
    inputTokens: 1000,
    outputTokens: 1000,
    cacheReadTokens: 0,
    priced: true,
  };
  for (const bad of [NaN, Infinity, -1]) {
    await assert.rejects(
      () => recordStep({ sessionUsd: 2, dailyUsd: 10 }, { ...step, costUsd: bad }),
      (error) => {
        assert.match(error.message, /refusing to record a cost/, String(bad));
        assert.doesNotMatch(
          error.message,
          /WORKFLOW_POSTGRES_URL/,
          "must be refused before the pool is even asked for, or the guard only works where it is not needed",
        );
        return true;
      },
      String(bad),
    );
  }
});
