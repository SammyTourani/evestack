/**
 * The rest of the exported surface, which had no test at all.
 *
 * `pricing-and-caps.test.mjs` covers what a model costs and whether that trips a
 * cap. Everything else this package exports was unexecuted: `dayKey`,
 * `formatUsd`, `isUncapped`, `principalDayKey`, `principalOf` and `findPrice` are
 * pure functions with no Postgres excuse, and configuration resolution — which
 * decides which model gets priced, which day the daily cap rolls over on, and
 * whether the store can be reached at all — is where every silent-failure mode in
 * this package has actually come from.
 *
 * So these are regression tests before they are unit tests. Each block names the
 * failure it pins, because the failures were not obvious: a typo'd timezone did
 * not misreport a day, it failed every turn; a default model that disagreed with
 * the agent's did not price slightly wrong, it made the cap unenforceable.
 *
 * From dist/, like its sibling, for the same reason: `src/*.ts` imports its
 * siblings as `./config.js`, which Node's type stripping does not rewrite.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { dayKey, isUncapped, resolveConfig } from "../dist/config.js";
import { principalOf } from "../dist/hook.js";
import { principalDayKey } from "../dist/store.js";
import { findPrice, formatUsd } from "../dist/pricing.js";

// The merged price table is built on first use and cached for the life of the
// process, deliberately — so an ambient EVESTACK_PRICING would silently decide
// what "priced" means for this entire file. Cleared before any test runs; the
// imports above only define the lazy build, they do not trigger it.
delete process.env.EVESTACK_PRICING;

/** Every variable `resolveConfig` reads, so a shell cannot decide an outcome. */
const MANAGED = [
  "EVESTACK_BUDGET_SESSION_USD",
  "EVESTACK_BUDGET_DAILY_USD",
  "EVESTACK_BUDGET_DISABLED",
  "EVESTACK_BUDGET_MODE",
  "EVESTACK_BUDGET_TIMEZONE",
  "EVESTACK_BUDGET_UNPRICED",
  "EVESTACK_BUDGET_MODEL",
  "EVESTACK_BUDGET_FAIL_CLOSED",
  "EVESTACK_PROVIDER",
  "EVESTACK_MODEL",
  "EVESTACK_PRICING",
  "WORKFLOW_POSTGRES_URL",
  "DATABASE_URL",
];

function withEnv(env, fn) {
  const saved = {};
  for (const key of MANAGED) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const key of MANAGED) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

const config = (env = {}, options = {}) => withEnv(env, () => resolveConfig(options));

/** Resolves a config and hands back whatever it warned about while doing it. */
function resolveWithWarnings(env = {}, options = {}) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    return { config: config(env, options), warnings };
  } finally {
    console.warn = original;
  }
}

/* -------------------------------------------------------------------------- */
/* the timezone — the field that used to fail every turn                       */
/* -------------------------------------------------------------------------- */

test("dayKey cuts the day in the configured zone, not the host's", () => {
  // 03:30 UTC is still yesterday in Toronto, which is the entire reason this
  // field exists: a daily cap that rolls over at 8pm local is a support ticket.
  const at = new Date("2026-08-06T03:30:00Z");
  assert.equal(dayKey(config({ EVESTACK_BUDGET_TIMEZONE: "UTC" }), at), "2026-08-06");
  assert.equal(dayKey(config({ EVESTACK_BUDGET_TIMEZONE: "America/Toronto" }), at), "2026-08-05");
  assert.equal(dayKey(config({ EVESTACK_BUDGET_TIMEZONE: "Asia/Tokyo" }), at), "2026-08-06");
});

test("dayKey is a real ISO date, because it is written straight into a date column", () => {
  assert.match(dayKey(config()), /^\d{4}-\d{2}-\d{2}$/);
});

test("a typo'd EVESTACK_BUDGET_TIMEZONE falls back to UTC instead of stopping the agent", () => {
  // The defect this pins was not a wrong day. `Intl.DateTimeFormat` throws
  // RangeError on a zone it does not know, that throw escaped the hook, and eve
  // reads a thrown hook as a real turn failure — so every turn died with
  // "MODEL_CALL_FAILED: Invalid time zone specified:" and EVESTACK_BUDGET_FAIL_CLOSED
  // was never consulted. Same policy as every other field: warn, fall back, run.
  for (const bad of ["GMT+2", "America/Torono", "Mars/Olympus_Mons"]) {
    const { config: resolved, warnings } = resolveWithWarnings({ EVESTACK_BUDGET_TIMEZONE: bad });
    assert.equal(resolved.timeZone, "UTC", bad);
    assert.equal(warnings.length, 1, `${bad} warns exactly once`);
    assert.match(warnings[0], /EVESTACK_BUDGET_TIMEZONE/);
    assert.doesNotThrow(() => dayKey(resolved), bad);
  }
});

test("a zone is trimmed before it is judged, so a trailing space is not a typo", () => {
  // "UTC " and " America/Toronto " both arrive this way from a .env file or a
  // compose environment block, and both used to throw.
  for (const [raw, expected] of [
    ["UTC ", "UTC"],
    [" America/Toronto ", "America/Toronto"],
  ]) {
    const { config: resolved, warnings } = resolveWithWarnings({ EVESTACK_BUDGET_TIMEZONE: raw });
    assert.equal(resolved.timeZone, expected);
    assert.deepEqual(warnings, [], "trimming fixed it, so there is nothing to warn about");
  }
});

test("an empty EVESTACK_BUDGET_TIMEZONE means unset, not mistyped", () => {
  // A blank line in a .env is not a typo, so it falls back in silence — the same
  // distinction envNumberOrFalse draws between "" and "abc".
  for (const raw of ["", "   "]) {
    const { config: resolved, warnings } = resolveWithWarnings({ EVESTACK_BUDGET_TIMEZONE: raw });
    assert.equal(resolved.timeZone, "UTC");
    assert.deepEqual(warnings, []);
  }
});

test("a bad zone warns once, not once per resolve", () => {
  // budgetHook() and budgetGuard() each resolve their own config, and a caller
  // may resolve per request. One line in the log, not a stream of them.
  const first = resolveWithWarnings({ EVESTACK_BUDGET_TIMEZONE: "Etc/Nowhere-Real" });
  const second = resolveWithWarnings({ EVESTACK_BUDGET_TIMEZONE: "Etc/Nowhere-Real" });
  assert.equal(first.warnings.length, 1);
  assert.deepEqual(second.warnings, []);
  assert.equal(second.config.timeZone, "UTC");
});

test("a zone passed in code is validated too, since options win over the environment", () => {
  // The merged value is the one dayKey hands to Intl, so validating only the
  // environment would leave budgetHook({ timeZone: "GMT+5" }) throwing. And
  // because BudgetOptions is a Partial, an explicit undefined spreads over a
  // good value as undefined — which Intl rejects as well.
  const inCode = resolveWithWarnings({ EVESTACK_BUDGET_TIMEZONE: "America/Toronto" }, { timeZone: "GMT+5" });
  assert.equal(inCode.config.timeZone, "UTC");
  assert.equal(inCode.warnings.length, 1, "and it says so, rather than falling back in silence");
  assert.equal(config({ EVESTACK_BUDGET_TIMEZONE: "America/Toronto" }, { timeZone: undefined }).timeZone, "UTC");
  assert.equal(config({}, { timeZone: "Asia/Tokyo" }).timeZone, "Asia/Tokyo");
});

test("dayKey still throws on a config nobody validated, which is why hook.ts guards it", () => {
  // resolveConfig cannot be bypassed by the environment, but a BudgetConfig
  // assembled by hand can hold anything. hook.ts now calls dayKey inside the
  // same try that guards recordStep, and guard.ts always did — so this throw
  // becomes a logged "failed to record spend" that honours
  // EVESTACK_BUDGET_FAIL_CLOSED, never a turn failure the caller cannot explain.
  assert.throws(() => dayKey({ timeZone: "GMT+2" }), RangeError);
});

/* -------------------------------------------------------------------------- */
/* the model — the field that made the cap unenforceable                       */
/* -------------------------------------------------------------------------- */

test("every provider the agent knows resolves to the model the agent would pick", () => {
  // These three must equal DEFAULT_MODEL in templates/default/agent/agent.ts.
  // They had drifted on one row and that row was enough: anthropic defaulted to
  // gpt-5-mini here, so EVESTACK_PROVIDER=anthropic with EVESTACK_MODEL unset —
  // what .env.example documents — priced as "anthropic/gpt-5-mini". Nothing
  // prices that and there is no anthropic wildcard, so the caps were dead.
  assert.equal(config({ EVESTACK_PROVIDER: "openai" }).model, "openai/gpt-5-mini");
  assert.equal(config({ EVESTACK_PROVIDER: "anthropic" }).model, "anthropic/claude-sonnet-5");
  assert.equal(config({ EVESTACK_PROVIDER: "ollama" }).model, "ollama/qwen3");
  for (const provider of ["openai", "anthropic", "ollama"]) {
    const { model } = config({ EVESTACK_PROVIDER: provider });
    assert.notEqual(findPrice(model), null, `${model} must be priced or the cap cannot trip`);
  }
  // And the key the drift used to produce, so the reason it was fatal stays pinned.
  assert.equal(findPrice("anthropic/gpt-5-mini"), null);
});

test("no provider is defaulted, so the openai default is the only unset default", () => {
  assert.equal(config().model, "openai/gpt-5-mini");
});

test("EVESTACK_PROVIDER is trimmed and lowercased the way agent.ts reads it", () => {
  // agent.ts does .trim().toLowerCase() before matching; this compared the raw
  // string to "ollama", so "Anthropic" and " ollama " became providers of their
  // own and produced unpriced keys.
  assert.equal(config({ EVESTACK_PROVIDER: "Anthropic" }).model, "anthropic/claude-sonnet-5");
  assert.equal(config({ EVESTACK_PROVIDER: " ollama " }).model, "ollama/qwen3");
  assert.equal(config({ EVESTACK_PROVIDER: "OLLAMA" }).model, "ollama/qwen3");
  assert.equal(config({ EVESTACK_PROVIDER: "" }).model, "openai/gpt-5-mini");
  assert.equal(config({ EVESTACK_PROVIDER: "  " }).model, "openai/gpt-5-mini");
});

test("a blank EVESTACK_MODEL means unset, not a model whose name is empty", () => {
  // `??` only falls back on undefined, so EVESTACK_MODEL= used to resolve
  // "openai/" — a key nothing prices, from a variable nobody meant to set.
  assert.equal(config({ EVESTACK_MODEL: "" }).model, "openai/gpt-5-mini");
  assert.equal(config({ EVESTACK_MODEL: "   ", EVESTACK_PROVIDER: "anthropic" }).model, "anthropic/claude-sonnet-5");
  assert.equal(config({ EVESTACK_MODEL: "  gpt-5  " }).model, "openai/gpt-5");
});

test("EVESTACK_BUDGET_MODEL overrides both and is trimmed", () => {
  assert.equal(
    config({ EVESTACK_BUDGET_MODEL: "  anthropic/claude-opus-5  ", EVESTACK_PROVIDER: "ollama" }).model,
    "anthropic/claude-opus-5",
  );
  // Blank falls through to the provider pair rather than winning with nothing.
  assert.equal(config({ EVESTACK_BUDGET_MODEL: "   ", EVESTACK_PROVIDER: "anthropic" }).model, "anthropic/claude-sonnet-5");
});

test("an unknown provider warns and stays unpriced rather than borrowing openai's prices", () => {
  // agent.ts treats a misspelled provider as a hard error, so the agent will not
  // have started. This package's policy is that a typo never stops an agent, so
  // it warns instead — but it must not invent a price, because a wrong price
  // that looks right is worse than a cap that says out loud it cannot measure.
  const { config: resolved, warnings } = resolveWithWarnings({ EVESTACK_PROVIDER: "ollamma" });
  assert.equal(findPrice(resolved.model), null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /EVESTACK_BUDGET_MODEL/);
});

/* -------------------------------------------------------------------------- */
/* the database url — the field that switched enforcement off in silence       */
/* -------------------------------------------------------------------------- */

test("DATABASE_URL is accepted, the same two names the siblings accept", () => {
  // packages/evestack-schedules/src/store.ts and packages/dashboard/lib/db.ts
  // both read WORKFLOW_POSTGRES_URL ?? DATABASE_URL. Reading only the first meant
  // that on a PaaS which sets only DATABASE_URL the dashboard worked while
  // getPool threw, hook.ts swallowed the throw, and the cap did not run.
  assert.equal(config({ DATABASE_URL: "postgres://only-database-url" }).databaseUrl, "postgres://only-database-url");
  assert.equal(config({ WORKFLOW_POSTGRES_URL: "postgres://workflow" }).databaseUrl, "postgres://workflow");
  assert.equal(
    config({ WORKFLOW_POSTGRES_URL: "postgres://workflow", DATABASE_URL: "postgres://database" }).databaseUrl,
    "postgres://workflow",
    "eve's own variable wins when both are set",
  );
  assert.equal(config({}).databaseUrl, undefined, "neither set stays undefined, so getPool can say so");
  assert.equal(config({}, { databaseUrl: "postgres://explicit" }).databaseUrl, "postgres://explicit");
});

/* -------------------------------------------------------------------------- */
/* the pure helpers                                                            */
/* -------------------------------------------------------------------------- */

test("isUncapped is true only when neither axis is a number", () => {
  assert.equal(isUncapped(config()), false);
  assert.equal(isUncapped(config({ EVESTACK_BUDGET_SESSION_USD: "false" })), false, "the daily cap is still a cap");
  assert.equal(isUncapped(config({ EVESTACK_BUDGET_DAILY_USD: "false" })), false);
  assert.equal(
    isUncapped(config({ EVESTACK_BUDGET_SESSION_USD: "false", EVESTACK_BUDGET_DAILY_USD: "false" })),
    true,
  );
  // The disable switch has to reach it, because that is how the hook returns early.
  assert.equal(isUncapped(config({ EVESTACK_BUDGET_DISABLED: "1" })), true);
  // A zero cap is not uncapped — it is the opposite, everything is already over.
  assert.equal(isUncapped(config({ EVESTACK_BUDGET_SESSION_USD: "0", EVESTACK_BUDGET_DAILY_USD: "0" })), false);
});

test("principalDayKey puts the day first, so the prefix is fixed width", () => {
  assert.equal(principalDayKey("alice", "2026-08-06"), "2026-08-06|alice");
  assert.ok(principalDayKey("alice", "2026-08-06").startsWith("2026-08-06|"));
  // Two principals on one day, and one principal on two days, never collide.
  assert.notEqual(principalDayKey("alice", "2026-08-06"), principalDayKey("alicia", "2026-08-06"));
  assert.notEqual(principalDayKey("alice", "2026-08-06"), principalDayKey("alice", "2026-08-07"));
});

test("principalOf bills the current caller, then the initiator, then nobody", () => {
  const ctx = (auth) => ({ session: { id: "wrun_1", auth } });
  assert.equal(
    principalOf(ctx({ current: { principalId: "alice" }, initiator: { principalId: "bob" } })),
    "alice",
    "a shared session charges whoever is driving it",
  );
  assert.equal(principalOf(ctx({ initiator: { principalId: "bob" } })), "bob");
  assert.equal(principalOf(ctx({})), "anonymous");
  // With no auth configured every caller collapses to one principal, which makes
  // the daily cap agent-wide. Documented as a default, not a bug — pinned so it
  // cannot change into one quietly.
  assert.equal(principalOf(ctx({})), principalOf(ctx({})));
});

test("formatUsd never renders a real cost as free", () => {
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(0.0001), "$0.0001", "a sub-cent step must not read as $0.00");
  assert.equal(formatUsd(0.009), "$0.0090");
  assert.equal(formatUsd(0.01), "$0.01");
  assert.equal(formatUsd(2), "$2.00");
  assert.equal(formatUsd(12.3456), "$12.35");
});

test("findPrice matches exactly, then by wildcard, then not at all", () => {
  assert.equal(findPrice(null), null, "an unknown model is not a free one");
  assert.equal(findPrice(""), null);
  assert.notEqual(findPrice("openai/gpt-5-mini"), null);
  assert.notEqual(findPrice("anthropic/claude-sonnet-5"), null);
  assert.equal(findPrice("nobody/no-such-model"), null);
  // The one wildcard, and the reason "unpriced" and "free" are different states:
  // a local model is priced AT zero because that is the truth about it.
  const local = findPrice("ollama/anything-at-all");
  assert.notEqual(local, null);
  assert.equal(local.input, 0);
  assert.equal(local.output, 0);
  // A wildcard is a prefix, not a substring — "ollama-cloud/x" is not local.
  assert.equal(findPrice("ollama-cloud/qwen3"), null);
});
