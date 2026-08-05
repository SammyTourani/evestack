import { defineHook } from "eve/hooks";
import type { HookContext, HookDefinition } from "eve/hooks";
import { cancelTurn } from "./cancel.js";
import { dayKey, isUncapped, resolveConfig, type BudgetConfig, type BudgetOptions } from "./config.js";
import { costUsd, formatUsd, isPriced } from "./pricing.js";
import {
  clearStop,
  ensureSchema,
  principalDayKey,
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
export function evaluate(
  config: BudgetConfig,
  totals: { readonly session: SpendTotals; readonly principalDay: SpendTotals },
): BudgetVerdict {
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
        const cost = usage.costUsd ?? costUsd(config.model, inputTokens, outputTokens, cacheReadTokens);

        const principalId = principalOf(ctx);
        const day = dayKey(config);

        let totals;
        try {
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
            await clearStop(config, { sessionId: ctx.session.id, principalId, day }).catch(
              () => undefined,
            );
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
