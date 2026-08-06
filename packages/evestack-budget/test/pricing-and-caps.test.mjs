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
});
