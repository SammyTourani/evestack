/**
 * @evestack/budget — dollar caps for a self-hosted eve agent.
 *
 * Two pieces, wired in two files:
 *
 *   agent/hooks/budget.ts   →  export default budgetHook()
 *   agent/tools/budget.ts   →  export default budgetGuard()
 *
 * The hook accumulates spend and asks the runtime to stop. The guard shadows
 * named tools once the budget is gone, so a step that is already in flight
 * cannot act on the world while the cancel lands.
 *
 * The honest claim, which the README repeats: this pauses at the cap, plus at
 * most one step that was already in flight — ONCE, not once per message. It is
 * not a hard limit. eve threads no `abortSignal` into model calls, so nothing
 * here — or anywhere — can kill a generation mid-stream.
 *
 * That "once" is the correction, and it used to be false. Spend was evaluated
 * only in `step.completed`, which runs after the model call it measures has been
 * billed, and no code path read the stop table before a turn began. So the
 * sentence above was true of every individual turn and false of the aggregate:
 * each new message into an already-stopped session bought another full model
 * call before failing again. The hook now also runs on `turn.started` and fails
 * the turn there, before the first call — `EVESTACK_BUDGET_PREFLIGHT=0` restores
 * the old behaviour for a client that cannot take a `turn.failed` at the
 * boundary.
 */
export {
  budgetHook,
  evaluate,
  preflightVerdict,
  principalOf,
  BudgetExceededError,
  type BudgetVerdict,
} from "./hook.js";
export { budgetGuard } from "./guard.js";
export {
  dayKey,
  isUncapped,
  resolveConfig,
  type BudgetConfig,
  type BudgetOptions,
} from "./config.js";
export { cancelTurn, type CancelResult, type CancelStatus } from "./cancel.js";
export {
  clearStop,
  ensureSchema,
  principalDayKey,
  principalDaySpend,
  readStop,
  readTotals,
  recentBudgetEvents,
  recordBudgetEvent,
  recordStep,
  recordStop,
  resetSession,
  type BudgetEventInput,
  type BudgetEventRow,
  type BudgetScope,
  type RecordedSpend,
  type SpendTotals,
  type StepSpend,
} from "./store.js";
/**
 * From the CHECKED wrapper, not from `./pricing.js` itself.
 *
 * `pricing.ts` is a build-time copy of `packages/dashboard/lib/pricing.ts` and
 * is gitignored here, so the validation a price table needs cannot live in it.
 * Re-exporting the wrapper is what makes `import { costUsd } from "@evestack/budget"`
 * the version that refuses to answer NaN — see the header of checked-pricing.ts
 * for the two defects and the two locks.
 *
 * The `@evestack/budget/pricing` subpath still resolves to the raw table, which
 * is the copy the dashboard's own SQL-only routes are the real consumer of. A
 * direct importer of that subpath gets the unchecked lookup; nothing in this
 * repository imports it.
 */
export {
  costUsd,
  findPrice,
  formatUsd,
  isPriced,
  type ModelPrice,
} from "./checked-pricing.js";
