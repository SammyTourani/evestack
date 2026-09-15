import { defineHook } from "eve/hooks";
import type { HookContext, HookDefinition } from "eve/hooks";
import { cancelTurn } from "./cancel.js";
import { dayKey, isUncapped, resolveConfig, type BudgetConfig, type BudgetOptions } from "./config.js";
// Never `./pricing.js` directly. That module is a build-time copy of the
// dashboard's table and reads EVESTACK_PRICING with no shape check; importing
// the checked wrapper is what keeps a half-written override from pricing every
// step as NaN and poisoning the stored totals. See checked-pricing.ts.
import { costUsd, formatUsd, isPriced } from "./checked-pricing.js";
import {
  clearStop,
  ensureSchema,
  principalDayKey,
  readStop,
  readTotals,
  recordBudgetEvent,
  recordStep,
  recordStop,
  type BudgetScope,
  type SpendTotals,
} from "./store.js";

/**
 * The accumulator half of the budget.
 *
 * Usage arrives on `step.completed` and nowhere else. `message.completed` and
 * `action.result` carry no token counts, and `turn.completed` carries only a
 * turn id — so `step.completed` is the one event that can be turned into money,
 * and it fires once per model call, which is also the finest granularity at
 * which anything can be stopped.
 */

/**
 * Process-local bookkeeping, bounded.
 *
 * These are keyed by session id in a process that may run for weeks, so an
 * ordinary Set is a slow leak. Dropping the whole set at the ceiling is safe
 * for both of them: forgetting a session costs one redundant `DELETE` or one
 * redundant cancel, never a missed stop, because the durable answer is always
 * in Postgres.
 */
const MAX_TRACKED_SESSIONS = 10_000;

function remember(set: Set<string>, key: string): void {
  if (set.size >= MAX_TRACKED_SESSIONS) set.clear();
  set.add(key);
}

/** Model ids we have already complained about, so the log stays readable. */
const warnedUnpriced = new Set<string>();
/** Sessions already stopped, so a racing step does not fire a second cancel. */
const stopped = new Set<string>();
/**
 * Sessions we have already confirmed are under budget.
 *
 * Only there to keep the "the cap was raised, lift the stop" DELETE to once
 * per session instead of once per model call.
 */
const knownUnderBudget = new Set<string>();

export interface BudgetVerdict {
  readonly exceeded: boolean;
  readonly scope?: BudgetScope;
  readonly limitUsd?: number;
  readonly spentUsd?: number;
  /** Overrides the money sentence when the stop is not about a number. */
  readonly reason?: string;
}

/**
 * Session cap first.
 *
 * When both are blown the session one is the more actionable message — it names
 * a conversation the user can see, where the daily one names an aggregate they
 * cannot. The daily cap still shows up on the next turn, because it does not
 * reset when the session does. That is the entire point of it.
 */
/**
 * A stored total that is not a number, which no comparison can be made against.
 *
 * `NaN >= 2` is false, so a poisoned `cost_usd` column did not read as "over
 * the cap" — it read as "under it", forever. That is how the NaN this package
 * used to compute from a half-written `EVESTACK_PRICING` override survived the
 * override being corrected: the bad number is in Postgres now, `cost + NaN` is
 * NaN on every subsequent step, and both the session and the principal-day
 * counters stayed silently unenforceable for the rest of the day.
 *
 * checked-pricing.ts stops this package producing such a number in the first
 * place and store.ts refuses to write one. This is the third lock, and the only
 * one that helps an install that already has a poisoned row: an unusable total
 * fails CLOSED, with a message that says which table to look at, rather than
 * quietly granting unlimited spend.
 *
 * It cannot break a working install, which is why it has no escape hatch — a
 * total that is a real number takes none of these branches, and there is no
 * deployment in which NaN or Infinity is the true amount of money spent.
 */
function unusableTotal(scope: BudgetScope, spentUsd: number): BudgetVerdict {
  const key = scope === "session" ? "the session's" : "this user's";
  return {
    exceeded: true,
    scope,
    limitUsd: 0,
    spentUsd: 0,
    reason:
      `Stopped because ${key} recorded spend is ${String(spentUsd)}, which cannot be compared ` +
      `against a cap. A non-finite cost was written into evestack.budget_usage — historically by ` +
      `an EVESTACK_PRICING override missing its "output" rate — and it poisons every later total ` +
      `it is added to. Fix the override, then reset the row: ` +
      // The predicate is `= 'NaN'::numeric`, and it has to be, because the
      // JavaScript idiom for the same question is a no-op in Postgres. `x <> x`
      // — which is how you find NaN in almost every other language, and what
      // this message used to print as `NOT (cost_usd = cost_usd)` — matches
      // nothing here: Postgres deliberately departs from IEEE 754 and treats
      // NaN as EQUAL to NaN, and as greater than every non-NaN value, so that
      // numerics can be sorted and indexed. Printing the JavaScript idiom would
      // have handed an already-stuck operator a statement that reports
      // "UPDATE 0" and leaves the row exactly as poisoned as it found it, which
      // is a worse failure than saying nothing. Only NaN is listed because only
      // NaN can be in the column: `numeric(16, 8)` has a declared scale, and
      // Postgres refuses an infinity into one (`numeric field overflow`), so
      // ±Infinity never became durable even before recordStep started refusing
      // it.
      `UPDATE evestack.budget_usage SET cost_usd = 0 WHERE cost_usd = 'NaN'::numeric.`,
  };
}

export function evaluate(
  config: BudgetConfig,
  totals: { readonly session: SpendTotals; readonly principalDay: SpendTotals },
): BudgetVerdict {
  // Ahead of both comparisons, in the same session-before-daily order and for
  // the same reason: the scope a user can act on is the one worth naming first.
  if (config.sessionUsd !== false && !Number.isFinite(totals.session.costUsd)) {
    return unusableTotal("session", totals.session.costUsd);
  }
  if (config.dailyUsd !== false && !Number.isFinite(totals.principalDay.costUsd)) {
    return unusableTotal("principal-day", totals.principalDay.costUsd);
  }
  if (config.sessionUsd !== false && totals.session.costUsd >= config.sessionUsd) {
    return {
      exceeded: true,
      scope: "session",
      limitUsd: config.sessionUsd,
      spentUsd: totals.session.costUsd,
    };
  }
  if (config.dailyUsd !== false && totals.principalDay.costUsd >= config.dailyUsd) {
    return {
      exceeded: true,
      scope: "principal-day",
      limitUsd: config.dailyUsd,
      spentUsd: totals.principalDay.costUsd,
    };
  }
  return { exceeded: false };
}

/**
 * Who to bill.
 *
 * `current` is the caller of the most recent request and `initiator` the one
 * who created the session; billing the current caller is what makes a shared
 * session charge whoever is actually driving it. With no auth configured every
 * caller collapses to one principal, and the daily cap becomes agent-wide —
 * which is a coherent default, not a bug, but it is worth knowing.
 */
export function principalOf(ctx: HookContext): string {
  return (
    ctx.session.auth.current?.principalId ??
    ctx.session.auth.initiator?.principalId ??
    "anonymous"
  );
}

export class BudgetExceededError extends Error {
  readonly code = "BUDGET_EXCEEDED";
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

function describe(verdict: BudgetVerdict): string {
  if (verdict.reason) return verdict.reason;
  const scope = verdict.scope === "session" ? "session budget" : "daily budget for this user";
  return (
    `Stopped by the evestack ${scope}: ${formatUsd(verdict.spentUsd ?? 0)} spent against a ` +
    `${formatUsd(verdict.limitUsd ?? 0)} cap. Raise EVESTACK_BUDGET_${
      verdict.scope === "session" ? "SESSION" : "DAILY"
    }_USD or wait for the window to roll over.`
  );
}

/**
 * Turns a stop row read at the START of a turn into a decision, or into nothing.
 *
 * Split out from the handler because the handler cannot be exercised without a
 * live session and a Postgres to read the stop from, and this is the part worth
 * pinning: which configurations let an already-stopped session buy another model
 * call. `observe` still buys one, deliberately — "record spend, stop nothing" is
 * the whole contract of that mode and a preflight that failed turns under it
 * would make measuring-before-enforcing impossible.
 *
 * The extra sentence is not decoration. The `step.completed` path's message ends
 * with "raise the cap or wait for the window", which reads as advice about a
 * turn that already ran; at the boundary nothing ran, and a user who sends three
 * messages and gets three identical errors needs to be told that explicitly or
 * they will keep sending them.
 *
 * `live` is the verdict from the totals and caps AS THEY ARE NOW, and leaving it
 * out is what the first version of this function did — which made the message
 * above a lie, because it advised raising the cap and then ignored the raise.
 * A stop row records that a cap was blown once; it does not expire when the cap
 * moves, `recordStop` never rewrites its `limit_usd` on conflict, and the only
 * `DELETE` that lifts one lives in `step.completed`. So a preflight that blocks
 * on the row's mere existence blocks on it forever: raising
 * EVESTACK_BUDGET_SESSION_USD could no longer heal the session, because no step
 * could complete to notice, and raising EVESTACK_BUDGET_DAILY_USD could not heal
 * the principal until the day key rolled over. That is not a softer version of
 * the documented "a cap raised under a session that already hit the old one
 * heals on the next step" — it is the opposite of it, and it bricks the session
 * for the 30 days the stop sweep keeps the row.
 *
 * So the stop is a reason to LOOK, and `live` is the answer. Under budget now
 * means the stop is stale and the turn runs (the caller lifts the row, so the
 * tool guard stops shadowing too). Over budget now means the turn never reaches
 * a model, which is the whole point of the preflight. `live` is optional so that
 * a caller with no totals to hand — and every test that only cares which
 * configurations preflight at all — gets the plain "a live stop stops the turn"
 * reading rather than a silent pass.
 */
export function preflightVerdict(
  config: BudgetConfig,
  stop: { readonly scope: BudgetScope; readonly reason: string } | null,
  live?: BudgetVerdict,
): BudgetVerdict | null {
  if (!stop) return null;
  if (!config.preflight) return null;
  if (config.mode === "observe") return null;
  if (live !== undefined && !live.exceeded) return null;
  return {
    exceeded: true,
    scope: stop.scope,
    reason: `${stop.reason} This turn was stopped before it called the model, so it cost nothing.`,
  };
}

/**
 * Sessions whose preflight block has already been recorded, bounded like the
 * two sets above.
 *
 * Enforcement never consults this — every turn that starts against a live stop
 * is failed, every time. It only keeps the `budget_events` row and the log line
 * to one per stop episode. A client that retries a rejected message in a loop
 * would otherwise write an unbounded number of rows into the one table this
 * package deliberately never sweeps, for no information beyond the first.
 */
const preflightBlocked = new Set<string>();

/**
 * Builds the hook to default-export from `agent/hooks/budget.ts`.
 *
 * Options override environment variables, and the environment supplies a
 * working default for every field — so `budgetHook()` with no arguments is a
 * complete configuration.
 */
export function budgetHook(options: BudgetOptions = {}): HookDefinition {
  const config = resolveConfig(options);

  return defineHook({
    events: {
      async "session.started"(_event, ctx) {
        if (isUncapped(config)) return;
        // Nothing to record yet — this is here so the first turn does not pay
        // for CREATE TABLE IF NOT EXISTS inside the step that has to decide
        // whether to stop, and so a broken database is announced at the start
        // of a session rather than in the middle of one.
        stopped.delete(ctx.session.id);
        knownUnderBudget.delete(ctx.session.id);
        preflightBlocked.delete(ctx.session.id);
        try {
          await ensureSchema(config);
        } catch (error) {
          console.warn(
            `[evestack:budget] spend store unavailable, budget not enforced this session: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          if (config.failClosed) throw error;
        }
      },

      /**
       * Enforcement BEFORE the model call, which is the only place the aggregate
       * can be held.
       *
       * `step.completed` is where spend is measured, and it necessarily fires
       * after the call it is measuring has been billed. That is a fine place to
       * decide that a turn has gone too far; it is a useless place to decide that
       * a turn should never have started. Until this handler existed, nothing
       * read the durable stop table at the start of anything — `stopped` is a
       * process-local flag cleared on `turn.cancelled` and `turn.failed` so the
       * NEXT turn can stop again, and `session.started` only created tables. So a
       * session that had already blown its cap answered every new message with
       * one complete uncapped model call before failing the turn again. Ten
       * follow-up messages were ten billed calls against a budget that was
       * already gone, and the aggregate grew without limit while every single
       * turn behaved exactly as documented.
       *
       * The stop this reads is written by `step.completed` and is durable, so
       * this also survives a restart — the old in-memory flag did not.
       *
       * The stop row is a reason to look, NOT the decision. It records that a cap
       * was blown once; nothing rewrites it when the cap moves — `recordStop`
       * keeps the first `limit_usd` on conflict — and the only DELETE that lifts
       * one runs in `step.completed`. So blocking on its bare existence would
       * have made "raise the cap and it heals on the next step", which this
       * package documents and which `clearStop` exists to deliver, unreachable:
       * no step can complete to notice the raise if the turn dies before the
       * first one. That is why the totals are re-read and re-evaluated against
       * the CURRENT caps here, and why a stale stop is lifted rather than
       * honoured. The cost is one extra primary-key lookup, and only on a turn
       * that is already stopped.
       *
       * Throwing is not a stylistic choice. A hook is observe-only: it cannot
       * deny a turn, and the cancel route cannot help here because cancellation
       * is cooperative and the turn has not yet reached a point where it is
       * checked. A throw is the one lever. eve 0.54 wraps a throw from
       * `turn.started` in `BoundaryHookError` (`context/hook-lifecycle.js`),
       * which `harness/tool-loop.js` turns into `step.failed` + `turn.failed`
       * carrying this message, then `session.waiting`, with `next: null` — the
       * turn is parked before any model call, and the session stays resumable.
       * Read out of `templates/default/node_modules/eve` at 0.54.3. Two limits on
       * that, both read in the same build: the parking is gated on
       * `mode === "conversation"`, so a `task`-mode run rethrows and the error
       * reaches the workflow driver instead (no worse than `mode: fail`, which
       * has always thrown from `step.completed` where nothing wraps it at all);
       * and older builds in the peer range have no `BoundaryHookError` wrapper,
       * which is what `EVESTACK_BUDGET_PREFLIGHT=0` is for.
       *
       * The honest cost: eve emits `turn.started` before `message.received`, and
       * the boundary-failure path persists the session history from before the
       * user's message was appended. So a message rejected here does not land in
       * the transcript. That is the trade — a message that is not in the history
       * against a model call that is on the invoice — and it is the same trade
       * eve itself makes for any failing `turn.started` handler.
       */
      async "turn.started"(event, ctx) {
        if (isUncapped(config)) return;
        if (!config.preflight) return;
        // Cheapest possible exit for the mode that is defined as stopping
        // nothing, taken before the query rather than after it: `observe` exists
        // to measure without enforcing, and a per-turn round trip to Postgres to
        // decide to do nothing is a cost that mode should not pay.
        if (config.mode === "observe") return;

        const principalId = principalOf(ctx);

        let day: string;
        let stop;
        let totals;
        try {
          // `dayKey` inside the try for the reason `step.completed` gives below:
          // it hands a configured string to `Intl`, and an escaped `RangeError`
          // here would be indistinguishable from the budget stopping the turn.
          day = dayKey(config);
          stop = await readStop(config, { sessionId: ctx.session.id, principalId, day });
          // The totals only when there is a stop to test them against, which is
          // why they are not read unconditionally: the overwhelmingly common
          // turn has no stop row, and it must keep costing exactly one
          // primary-key lookup. A turn that IS stopped can afford a second one —
          // it is about to be refused, and the alternative is refusing it on a
          // cap that was raised an hour ago.
          totals = stop
            ? await readTotals(config, { sessionId: ctx.session.id, principalId, day })
            : null;
        } catch (error) {
          // Same posture as every other store failure in this package, and it
          // matters more here than anywhere: this runs on the first event of
          // every turn, so failing closed by default would turn a Postgres blip
          // into an agent that cannot answer at all.
          console.error(
            `[evestack:budget] preflight could not read the stop state or the totals, the turn runs unchecked: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          if (config.failClosed) throw error;
          return;
        }

        if (!stop || !totals) return;

        /**
         * The same two-branch decision `step.completed` makes, against the same
         * caps, so the boundary cannot refuse a turn the step would have allowed.
         *
         * The unpriced branch is not duplication for its own sake. Without it,
         * an `EVESTACK_BUDGET_UNPRICED=stop` install would heal its own stop on
         * every single message — the totals are $0.00, so `evaluate` says "under
         * budget", the row is lifted, one full model call runs, and
         * `step.completed` writes the stop straight back. That is the exact
         * billed-call-per-message hole this handler exists to close, reappearing
         * through the one configuration that stops on something other than a
         * number.
         */
        const live: BudgetVerdict =
          config.unpricedModel === "stop" && !isPriced(config.model)
            ? { exceeded: true, scope: "session" }
            : evaluate(config, totals);

        const verdict = preflightVerdict(config, stop, live);
        if (!verdict) {
          // The cap moved, or the row was reset, and this stop is a leftover.
          // Lifting it HERE rather than leaving it to the coming
          // `step.completed` is what makes the raise take effect on this turn
          // instead of the next one: `guard.ts` reads the same row before every
          // model call, so a stop left in place would run the healing turn with
          // its tools still shadowed by refusals. The DELETE re-checks the
          // totals inside its own statement, so it cannot lift a stop another
          // session has just written — see clearStop in store.ts.
          preflightBlocked.delete(ctx.session.id);
          await clearStop(config, {
            sessionId: ctx.session.id,
            principalId,
            day,
            sessionUsd: config.sessionUsd,
            dailyUsd: config.dailyUsd,
          }).catch(() => undefined);
          return;
        }

        const message = describe(verdict);

        if (!preflightBlocked.has(ctx.session.id)) {
          remember(preflightBlocked, ctx.session.id);
          await recordBudgetEvent(config, {
            sessionId: ctx.session.id,
            turnId: event.data.turnId,
            principalId,
            scope: verdict.scope ?? "session",
            limitUsd: 0,
            spentUsd: 0,
            // Distinct from `turn-failed` on purpose. Both stop a turn, but that
            // one names a turn whose model call had already been paid for and
            // this one names a turn that never made one, and a dashboard that
            // cannot tell them apart cannot show that the preflight is working.
            action: "preflight-blocked",
            detail: { model: config.model, scope: verdict.scope ?? "session" },
          }).catch(() => undefined);
          console.warn(`[evestack:budget] ${message}`);
        }

        throw new BudgetExceededError(message);
      },

      async "step.completed"(event, ctx) {
        if (isUncapped(config)) return;

        const usage = event.data.usage;
        // A step with no reported usage is not free, it is unmeasured. There is
        // nothing to add and nothing to compare, so leave the counters alone
        // rather than writing a zero that reads as "this step cost nothing".
        if (!usage) return;

        const inputTokens = usage.inputTokens ?? 0;
        const outputTokens = usage.outputTokens ?? 0;
        const cacheReadTokens = usage.cacheReadTokens ?? 0;
        /**
         * Cache WRITES are billed, usually at a premium, and this hook was not
         * charging for them.
         *
         * `costUsd` takes five arguments and was being called with four, so
         * `cacheWriteTokens` fell to its `= 0` default on every step. eve
         * reports the number — its own `ZERO_TOKEN_USAGE` is
         * `{cacheReadTokens, cacheWriteTokens, inputTokens, outputTokens}` — and
         * pricing.ts:376 has always taken it. Only the call site dropped it.
         *
         * Cache reads and writes are PARTS of `inputTokens`, not additions to
         * it — `costUsd` subtracts both to get the non-cached remainder — so the
         * miss is the difference between the two rates, not a whole extra
         * charge. Measured against the shipped catalog, 1M input tokens of which
         * 400k were cache writes:
         *
         *   anthropic/claude-sonnet-5   charged $2.000, correct $2.200   (-10%)
         *   openai/gpt-5-mini           charged $0.250, correct $0.250   (none)
         *
         * Anthropic prices a write at 1.25x input; gpt-5-mini publishes no write
         * rate, so pricing.ts falls back to the input rate and the two buckets
         * cost the same. The bug therefore undercharges on Anthropic and is a
         * no-op on the default provider — which is exactly why it survived.
         *
         * It still matters: `cost` is what the cap is measured against, so an
         * Anthropic prompt-caching workload passes its limit before anything
         * trips.
         *
         * NOTE: `budget_steps` has no cache_write_tokens column, so the count is
         * still not stored per step — only its cost is now counted. Adding the
         * column means a migration against tables created with CREATE TABLE IF
         * NOT EXISTS, which is a bigger change than the money bug needs.
         */
        const cacheWriteTokens = usage.cacheWriteTokens ?? 0;

        const priced = isPriced(config.model);
        if (!priced && !warnedUnpriced.has(config.model)) {
          warnedUnpriced.add(config.model);
          console.warn(
            `[evestack:budget] no price for model "${config.model}" — every step costs $0.00 and ` +
              `the cap can never trip. Set EVESTACK_PRICING or EVESTACK_BUDGET_MODEL. ` +
              `Unpriced steps are counted in evestack.budget_usage.unpriced_steps.`,
          );
        }

        // Prefer a cost the provider actually reported. eve only attaches
        // `usage.costUsd` when the call went through Vercel's AI Gateway, so
        // this branch is dead for a self-hosted agent today — but when it is
        // live it beats our table, and it is one `??` to be ready for it.
        const cost =
          usage.costUsd ??
          costUsd(config.model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);

        const principalId = principalOf(ctx);

        // `dayKey` is inside the try for the same reason `guard.ts` keeps its own
        // call inside one: it hands a configured string to `Intl`, which throws
        // `RangeError` on a zone it does not know. Outside the try that throw left
        // the hook, and eve reads a thrown hook as a real turn failure — so a
        // typo'd EVESTACK_BUDGET_TIMEZONE failed every single turn, stamped
        // `MODEL_CALL_FAILED` because eve chooses that code, with
        // EVESTACK_BUDGET_FAIL_CLOSED never consulted. `resolveConfig` validates
        // the zone now, so this is the second lock on a door that should no
        // longer be reachable; a configuration error must not be able to present
        // itself as a model failure whichever way it arrives.
        let day: string;
        let totals;
        try {
          day = dayKey(config);
          totals = await recordStep(config, {
            sessionId: ctx.session.id,
            principalId,
            turnId: event.data.turnId,
            stepIndex: event.data.stepIndex,
            sequence: event.data.sequence,
            day,
            model: config.model,
            costUsd: cost,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            priced,
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          console.error(`[evestack:budget] failed to record spend: ${detail}`);
          if (config.failClosed) throw error;
          return;
        }

        // Fail-closed on an unpriced model. Spend cannot be measured, so a cap
        // cannot be honoured, and "$0.00 against a $2.00 cap" would be a lie
        // rather than a limit — hence its own sentence instead of the money one.
        const verdict: BudgetVerdict =
          !priced && config.unpricedModel === "stop"
            ? {
                exceeded: true,
                scope: "session",
                limitUsd: config.sessionUsd === false ? 0 : config.sessionUsd,
                spentUsd: totals.session.costUsd,
                reason:
                  `Stopped because "${config.model}" has no price, so spend cannot be measured ` +
                  `and no budget can be enforced against it. Add it to EVESTACK_PRICING, or set ` +
                  `EVESTACK_BUDGET_UNPRICED=warn to run unmetered.`,
              }
            : evaluate(config, totals);

        if (!verdict.exceeded) {
          // Raising the cap under a session that already hit the old one has
          // to actually give it its tools back. Once per session, not once per
          // step: the common case is a session that was never stopped.
          if (!knownUnderBudget.has(ctx.session.id)) {
            remember(knownUnderBudget, ctx.session.id);
            preflightBlocked.delete(ctx.session.id);
            // The caps travel with the delete, and that is the fix for a race
            // this used to lose. Two sessions belonging to one principal share
            // the principal-day row. Session A's `recordStep` returned a day
            // total under the cap; session B's next step pushed the shared total
            // over it and wrote the principal-day stop; A then reached this line
            // and deleted that stop unconditionally — removing, moments after it
            // was written, the exact row the guard exists to honour, on the word
            // of a total that was already stale when A read it. `clearStop` now
            // re-reads the stored totals inside the same statement, so the delete
            // only fires against numbers that are current at delete time.
            await clearStop(config, {
              sessionId: ctx.session.id,
              principalId,
              day,
              sessionUsd: config.sessionUsd,
              dailyUsd: config.dailyUsd,
            }).catch(() => undefined);
          }
          return;
        }
        knownUnderBudget.delete(ctx.session.id);
        if (config.mode === "observe") return;

        const message = describe(verdict);

        // Written before anything else stops anything. The guard reads this
        // table, and the guard is what protects the world from the step that
        // is already in flight — so it has to be true before the cancel, not
        // after it.
        await recordStop(config, {
          scope: verdict.scope ?? "session",
          scopeKey:
            verdict.scope === "principal-day"
              ? principalDayKey(principalId, day)
              : ctx.session.id,
          sessionId: ctx.session.id,
          reason: message,
          limitUsd: verdict.limitUsd ?? 0,
          spentUsd: verdict.spentUsd ?? 0,
        }).catch((error: unknown) => {
          console.error(
            `[evestack:budget] could not persist the stop, tools stay enabled: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });

        // One stop per session. Steps of the same turn can complete close
        // enough together that two hook invocations both read an over-budget
        // total; the second cancel would be harmless but the second
        // `budget_events` row would make the dashboard look like it tripped
        // twice.
        if (stopped.has(ctx.session.id)) return;
        remember(stopped, ctx.session.id);

        if (config.mode === "fail") {
          await recordBudgetEvent(config, {
            sessionId: ctx.session.id,
            turnId: event.data.turnId,
            principalId,
            scope: verdict.scope ?? "session",
            limitUsd: verdict.limitUsd ?? 0,
            spentUsd: verdict.spentUsd ?? 0,
            action: "turn-failed",
            detail: { model: config.model, stepIndex: event.data.stepIndex, day },
          }).catch(() => undefined);
          console.warn(`[evestack:budget] ${message}`);
          // eve treats a thrown hook as a real failure and surfaces it as
          // `turn.failed` carrying this message, which is the only way an
          // authored extension can put a reason on the event stream.
          throw new BudgetExceededError(message);
        }

        const result = await cancelTurn(config, {
          sessionId: ctx.session.id,
          turnId: event.data.turnId,
        });

        await recordBudgetEvent(config, {
          sessionId: ctx.session.id,
          turnId: event.data.turnId,
          principalId,
          scope: verdict.scope ?? "session",
          limitUsd: verdict.limitUsd ?? 0,
          spentUsd: verdict.spentUsd ?? 0,
          action: `cancel:${result.status}`,
          detail: {
            model: config.model,
            stepIndex: event.data.stepIndex,
            day,
            ...(result.detail ? { error: result.detail } : {}),
          },
        }).catch((error: unknown) => {
          console.error(
            `[evestack:budget] cancelled the turn but could not record why: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });

        console.warn(`[evestack:budget] ${message} (cancel ${result.status})`);
      },

      // Freeing the flag here rather than on `session.completed` is deliberate:
      // a cancelled turn parks the session, the user sends another message, and
      // the very next step must be able to stop it again.
      "turn.cancelled"(_event, ctx) {
        stopped.delete(ctx.session.id);
      },
      "turn.failed"(_event, ctx) {
        stopped.delete(ctx.session.id);
      },
    },
  });
}
