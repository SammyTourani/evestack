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
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { dayKey, isUncapped, resolveConfig } from "../dist/config.js";
import { budgetHook, preflightVerdict, principalOf } from "../dist/hook.js";
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
  "EVESTACK_BUDGET_PREFLIGHT",
  "EVESTACK_BUDGET_GUARD_TOOLS",
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
  // These must equal DEFAULT_MODEL in templates/default/agent/agent.ts.
  // They had drifted on one row and that row was enough: anthropic defaulted to
  // gpt-5-mini here, so EVESTACK_PROVIDER=anthropic with EVESTACK_MODEL unset —
  // what .env.example documents — priced as "anthropic/gpt-5-mini". Nothing
  // prices that and there is no anthropic wildcard, so the caps were dead.
  assert.equal(config({ EVESTACK_PROVIDER: "openai" }).model, "openai/gpt-5-mini");
  assert.equal(config({ EVESTACK_PROVIDER: "anthropic" }).model, "anthropic/claude-sonnet-5");
  assert.equal(config({ EVESTACK_PROVIDER: "ollama" }).model, "ollama/qwen3:0.6b");
  // No provider prefix: envModel passes a slash-bearing id through unchanged,
  // because a gateway model id already names its own vendor.
  assert.equal(config({ EVESTACK_PROVIDER: "openrouter" }).model, "qwen/qwen3.8-27b");
  for (const provider of ["openai", "anthropic", "ollama", "openrouter"]) {
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
  assert.equal(config({ EVESTACK_PROVIDER: " ollama " }).model, "ollama/qwen3:0.6b");
  assert.equal(config({ EVESTACK_PROVIDER: "OLLAMA" }).model, "ollama/qwen3:0.6b");
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

/* -------------------------------------------------------------------------- */
/* the preflight — the field that decides whether a stopped cap stays stopped  */
/* -------------------------------------------------------------------------- */

/**
 * The defect these pin is an aggregate, which is why no single turn showed it.
 *
 * Spend was evaluated only in `step.completed` — after the model call it
 * measures has been billed — and the process-local `stopped` flag is cleared on
 * `turn.cancelled` and `turn.failed` so the next turn can stop again. Nothing
 * read the durable stop table at the START of anything. So a session that had
 * already blown its cap answered every new message with one complete, uncapped
 * model call before failing the turn again: ten follow-up messages were ten
 * billed calls against a budget that was already gone. Every individual turn
 * behaved exactly as the README described; the total did not.
 */

test("the preflight is on by default and only three spellings turn it off", () => {
  assert.equal(config().preflight, true, "enforcement that must be discovered is not enforcement");
  for (const off of ["0", "false", "off", "OFF", " False "]) {
    assert.equal(config({ EVESTACK_BUDGET_PREFLIGHT: off }).preflight, false, off);
  }
  // A blank line in a .env means unset, the same distinction every other field
  // in config.ts draws, and anything unrecognised leaves it ON — a typo in this
  // variable must not be what quietly restores the uncapped model call.
  for (const on of ["", "   ", "1", "true", "yes", "no", "please"]) {
    assert.equal(config({ EVESTACK_BUDGET_PREFLIGHT: on }).preflight, true, JSON.stringify(on));
  }
  assert.equal(config({}, { preflight: false }).preflight, false, "and code wins over the environment");
});

test("the hook subscribes to turn.started, which is the only event before a model call", () => {
  // `session.started` fires once per session and `step.completed` fires after the
  // call has billed. `turn.started` is the one that runs at the top of every
  // message, and eve emits it inside the same preamble whose failure parks the
  // turn without running it.
  const events = Object.keys(budgetHook().events ?? {});
  assert.ok(events.includes("turn.started"), `turn.started missing from [${events.join(", ")}]`);
  assert.ok(events.includes("step.completed"), "the accumulator is still where the money is counted");
});

test("preflightVerdict stops a turn that starts against a live stop, and nothing else", () => {
  const stop = { scope: "principal-day", reason: "Stopped by the evestack daily budget for this user." };
  const enforcing = config();

  const verdict = preflightVerdict(enforcing, stop);
  assert.equal(verdict.exceeded, true);
  assert.equal(verdict.scope, "principal-day", "the scope the hook recorded, not a fresh guess");
  // Spelled out because the user is about to see this three times in a row if
  // they keep sending messages, and "raise the cap or wait" reads like advice
  // about a turn that ran. This one did not run.
  assert.match(verdict.reason, /before it called the model/);

  assert.equal(preflightVerdict(enforcing, null), null, "no stop row, no opinion");
  // `observe` is defined as "record spend, stop nothing". A preflight that failed
  // turns under it would make measuring-before-enforcing impossible, which is the
  // entire reason that mode exists.
  assert.equal(preflightVerdict(config({ EVESTACK_BUDGET_MODE: "observe" }), stop), null);
  assert.equal(preflightVerdict(config({ EVESTACK_BUDGET_PREFLIGHT: "0" }), stop), null);
});

/**
 * A stop row records that a cap was blown ONCE. It does not expire when the cap
 * moves, and only one line in this package ever deletes one.
 *
 * That is why the preflight cannot refuse on the row's bare existence, and the
 * first version of it did. `recordStop` keeps the original `limit_usd` on
 * conflict, nothing rewrites the row when `EVESTACK_BUDGET_SESSION_USD` changes,
 * and the only `clearStop` call site is inside `step.completed`. So a preflight
 * that blocked on the row alone blocked forever: raising the session cap could
 * never heal the session, because no step could complete to notice the raise,
 * and raising the daily cap could not heal the principal until the day key
 * rolled over at midnight. The README two sections up promises the opposite —
 * "a cap raised under a session that already hit the old one heals on its next
 * message" — and the promise is the reason `clearStop` exists at all.
 *
 * So the stop is the trigger and the live verdict is the decision.
 */
test("a stop written under a cap that has since been raised does not brick the session", () => {
  const stop = { scope: "session", reason: "Stopped by the evestack session budget." };
  const enforcing = config();

  // Still over: the turn is refused before it reaches a model, which is the
  // whole point of the preflight and must not be softened by any of this.
  const stillOver = preflightVerdict(enforcing, stop, { exceeded: true, scope: "session" });
  assert.equal(stillOver.exceeded, true);
  assert.match(stillOver.reason, /before it called the model/);

  // Under the cap as it reads NOW: the row is a leftover, so the turn runs and
  // the caller lifts it. Without this branch the session is dead until the stop
  // sweep drops the row 30 days later.
  assert.equal(
    preflightVerdict(enforcing, stop, { exceeded: false }),
    null,
    "raising the cap has to take effect, or the documented heal is unreachable",
  );

  // Omitted rather than false: a caller with no totals in hand gets the plain
  // reading, which is what keeps the argument optional instead of a trap where
  // forgetting it silently stops enforcing.
  assert.ok(preflightVerdict(enforcing, stop)?.exceeded, "no live verdict, no benefit of the doubt");
});

test("a preflight that cannot reach the store lets the turn run, unless told otherwise", async () => {
  // This handler runs on the first event of EVERY turn, so failing closed by
  // default would turn a Postgres blip into an agent that cannot answer at all —
  // the same trade `session.started` and `step.completed` already make, and the
  // reason EVESTACK_BUDGET_FAIL_CLOSED exists rather than being the default.
  //
  // No databaseUrl is configured here, so `getPool` throws on the way in; that is
  // the cheapest available stand-in for an unreachable database.
  const ctx = { session: { id: "wrun_1", auth: {} } };
  const event = { data: { turnId: "turn_0" } };
  const quiet = console.error;
  console.error = () => {};
  try {
    const openHook = budgetHook({ sessionUsd: 2, dailyUsd: 10, databaseUrl: undefined });
    await assert.doesNotReject(() => openHook.events["turn.started"](event, ctx));

    const closedHook = budgetHook({ sessionUsd: 2, dailyUsd: 10, databaseUrl: undefined, failClosed: true });
    await assert.rejects(() => closedHook.events["turn.started"](event, ctx));

    // And an uncapped hook never asks the store anything, so the unreachable
    // database cannot surface at all — EVESTACK_BUDGET_DISABLED=1 has to mean
    // disabled, including the new query.
    const off = budgetHook({ sessionUsd: false, dailyUsd: false, databaseUrl: undefined, failClosed: true });
    await assert.doesNotReject(() => off.events["turn.started"](event, ctx));
  } finally {
    console.error = quiet;
  }
});

/**
 * The wiring itself, asserted against the source.
 *
 * The handler needs a live session and a Postgres to exercise end to end — the
 * same reason the header of this file gives for what it does not cover — and
 * `pricing-and-caps.test.mjs` uses this technique for the same reason. What is
 * pinned here is the part a refactor could quietly undo: that the stop is read
 * from the durable table at the boundary, and that the stop is delivered by a
 * THROW, which is the only lever a hook has. eve 0.54 wraps a throw from
 * `turn.started` in a BoundaryHookError and parks the turn without running it
 * (`eve/dist/src/context/hook-lifecycle.js`, `harness/tool-loop.js`); swapping
 * the throw for a log or a cancel call would restore the billed model call with
 * every test above still green.
 */
test("the preflight reads the durable stop table and stops the turn by throwing", () => {
  const src = readFileSync(new URL("../src/hook.ts", import.meta.url), "utf8");
  const handler = src.slice(src.indexOf('async "turn.started"'), src.indexOf('async "step.completed"'));
  assert.ok(handler.length > 0, "there must be a turn.started handler to read");
  assert.match(handler, /await readStop\(config, \{/, "the decision comes from the durable table");
  assert.match(handler, /throw new BudgetExceededError\(message\)/, "and a hook can only stop a turn by throwing");
  // And the stop is tested against the caps as they are now, not honoured on
  // sight. `readTotals` here is what makes a raised cap reachable; the
  // `clearStop` is what makes it reachable on THIS turn rather than the next
  // one, since guard.ts reads the same row before every model call and would
  // otherwise run the healing turn with its tools still shadowed.
  assert.match(handler, /await readTotals\(config, \{/, "a stop is a reason to look, not the verdict");
  assert.match(handler, /await clearStop\(config, \{/, "and a leftover stop is lifted, not obeyed");
});

/* -------------------------------------------------------------------------- */
/* clearing a stop — the DELETE that could race another session                */
/* -------------------------------------------------------------------------- */

/**
 * Two sessions of one principal share the principal-day row, and the old
 * unconditional DELETE let either one lift the other's stop.
 *
 * The interleaving is ordinary. Session A records a step and gets a day total of
 * $9.80, under the $10 cap. Session B records a step, gets $10.20, and writes the
 * principal-day stop. Session A — whose total was already stale when it read it —
 * reaches the "I am under budget, lift any stop" branch and deletes the row B
 * just wrote, which is exactly the row the guard exists to honour.
 *
 * Re-reading the totals in JavaScript would only move the race. The totals are
 * read inside the DELETE's own statement instead, so the condition is evaluated
 * against what is committed at delete time. Asserted against the SQL because the
 * behaviour is the SQL, and reproducing the interleaving needs two connections to
 * a database this suite does not have.
 */
test("clearing a stop re-checks the cap inside the same statement", () => {
  const src = readFileSync(new URL("../src/store.ts", import.meta.url), "utf8");
  const clear = src.slice(src.indexOf("export async function clearStop"), src.indexOf("export async function readStop"));
  assert.ok(clear.length > 0);
  assert.match(clear, /DELETE FROM evestack\.budget_stops/);
  // The load-bearing part: each scope's delete is conditional on that scope's
  // own current cost_usd, read from budget_usage in a subquery rather than
  // passed in by the caller.
  assert.match(
    clear,
    /scope = 'session'[\s\S]*SELECT u\.cost_usd FROM evestack\.budget_usage u[\s\S]*u\.scope = 'session'/,
  );
  assert.match(
    clear,
    /scope = 'principal-day'[\s\S]*SELECT u\.cost_usd FROM evestack\.budget_usage u[\s\S]*u\.scope = 'principal-day'/,
  );
  // And the hook has to actually hand over the caps, or every condition is NULL
  // and the statement is the unconditional delete again with extra words.
  const hook = readFileSync(new URL("../src/hook.ts", import.meta.url), "utf8");
  assert.match(
    hook,
    /await clearStop\(config, \{[\s\S]*?sessionUsd: config\.sessionUsd,[\s\S]*?dailyUsd: config\.dailyUsd,[\s\S]*?\}\)/,
  );
});

/* -------------------------------------------------------------------------- */
/* the guard that guards nothing                                               */
/* -------------------------------------------------------------------------- */

/**
 * `budgetGuard()` with no arguments installs a resolver that can never fire.
 *
 * `guardTools` defaults to empty — `EVESTACK_BUDGET_GUARD_TOOLS` is unset in
 * every `.env.example` here — and the resolver returns null on the first line
 * when the list is empty. So the call reads in the agent's source exactly like
 * protection and shadows nothing, with no error, no log line, and a dashboard
 * that shows the hook's stop rows whether or not anything honours them.
 *
 * In a child process because the warning is once per process on purpose: a line
 * repeated on every construction is a line nobody reads, and a test that asserts
 * it fires cannot also be the test that proves it fires only once, in the same
 * process, in file order.
 */
function guardWarnings(body) {
  const inherited = { ...process.env };
  for (const key of MANAGED) delete inherited[key];
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", body], {
    cwd: import.meta.dirname,
    encoding: "utf8",
    env: inherited,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stderr.split("\n").filter((line) => line.includes("[evestack:budget]"));
}

test("budgetGuard says out loud when it has no tools to shadow", () => {
  const warnings = guardWarnings(`
    const { budgetGuard } = await import("../dist/index.js");
    budgetGuard();
  `);
  assert.equal(warnings.length, 1, `expected one warning, got: ${warnings.join(" | ")}`);
  assert.match(warnings[0], /no tools to shadow/);
  assert.match(warnings[0], /guardTools/, "and names the thing to set");
});

test("budgetGuard is quiet when it has tools, and when there is no cap to guard", () => {
  assert.deepEqual(
    guardWarnings(`
      const { budgetGuard } = await import("../dist/index.js");
      budgetGuard({ guardTools: ["remember", "bash"] });
    `),
    [],
    "the scaffolded agent/tools/budget.ts passes a real list and must not be nagged",
  );
  assert.deepEqual(
    guardWarnings(`
      const { budgetGuard } = await import("../dist/index.js");
      budgetGuard({ sessionUsd: false, dailyUsd: false });
    `),
    [],
    "no cap means no stop for a guard to honour, so there is nothing to warn about",
  );
  assert.deepEqual(
    guardWarnings(`
      const { budgetGuard } = await import("../dist/index.js");
      budgetGuard({ mode: "observe" });
    `),
    [],
    "observe is a deliberate decision to stop nothing, not a misconfiguration",
  );
});

test("budgetGuard warns once per process, not once per call", () => {
  const warnings = guardWarnings(`
    const { budgetGuard } = await import("../dist/index.js");
    budgetGuard();
    budgetGuard();
    budgetGuard();
  `);
  assert.equal(warnings.length, 1, `expected one warning, got ${warnings.length}`);
});
