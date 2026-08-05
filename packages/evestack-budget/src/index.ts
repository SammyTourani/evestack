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
 * most one step that was already in flight. It is not a hard limit. eve threads
 * no `abortSignal` into model calls, so nothing here — or anywhere — can kill a
 * generation mid-stream.
 */
export { budgetHook, evaluate, principalOf, BudgetExceededError, type BudgetVerdict } from "./hook.js";
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
export {
  costUsd,
  findPrice,
  formatUsd,
  isPriced,
  type ModelPrice,
} from "./pricing.js";
