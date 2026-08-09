/**
 * The budget caps, read the way `@evestack/budget` reads them.
 *
 * The dashboard is deliberately not a dependency of that package — it is a
 * separate process that may be pointed at an agent it did not scaffold — so
 * these values are re-read here rather than imported. That is a copy, and a copy
 * of a parser is a thing that drifts, so two defences sit around it:
 * test/budget-env.test.mjs asserts this file's defaults against the literals in
 * packages/evestack-budget/src/config.ts, and it lives in ONE module rather than
 * being retyped at each call site.
 *
 * ── The bug this file was extracted to fix ───────────────────────────────────
 *
 * lib/alerts.ts read `EVESTACK_DAILY_BUDGET_USD`. No such variable exists. The
 * real one is `EVESTACK_BUDGET_DAILY_USD` — the other word order — and the
 * transposition appeared in exactly three lines, all inside alerts.ts, so
 * nothing else in the repository disagreed with it loudly enough to be noticed.
 *
 * The consequence was not a wrong number, which someone would have queried. It
 * was a monitor stuck at `unknown` on every install ever made, reporting "no cap
 * is configured, so there is nothing to compare it to" while `@evestack/budget`
 * was at that moment enforcing a $10/day cap by default. A check that cannot
 * fire is worse than a missing one, because the page counts it among the ones
 * that passed — the same defect this codebase already found once in
 * `failingSchedules()`, and warned about in the header of the module that then
 * carried it.
 */

/** Matches `envNumberOrFalse` in packages/evestack-budget/src/config.ts:98. */
export function parseCap(raw: string | undefined, fallback: number | false): number | false {
  if (raw === undefined || raw.trim() === "") return fallback;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "false" || trimmed === "off" || trimmed === "none") return false;
  const value = Number(trimmed.replace(/^\$/, ""));
  // A typo must fall back to the default rather than to "no cap": the safe
  // direction for a spend limit is the one that keeps limiting.
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** packages/evestack-budget/src/config.ts:94-95. Pinned by a test. */
export const DEFAULT_SESSION_USD = 2;
export const DEFAULT_DAILY_USD = 10;

export interface BudgetCaps {
  /** `false` means uncapped on that axis. */
  readonly sessionUsd: number | false;
  readonly dailyUsd: number | false;
  /** True when EVESTACK_BUDGET_DISABLED turned the whole hook off. */
  readonly disabled: boolean;
}

export function readBudgetCaps(env: Record<string, string | undefined>): BudgetCaps {
  const disabled = env.EVESTACK_BUDGET_DISABLED === "1" || env.EVESTACK_BUDGET_DISABLED === "true";
  return {
    disabled,
    sessionUsd: disabled ? false : parseCap(env.EVESTACK_BUDGET_SESSION_USD, DEFAULT_SESSION_USD),
    dailyUsd: disabled ? false : parseCap(env.EVESTACK_BUDGET_DAILY_USD, DEFAULT_DAILY_USD),
  };
}

/**
 * The number the "Spend today" monitor compares against, and what it means.
 *
 * Two different things could be meant by "the daily cap", and conflating them is
 * how the fix for the typo above would have introduced a second, quieter bug:
 *
 *   EVESTACK_BUDGET_DAILY_USD    per principal, per day. What the hook enforces.
 *   EVESTACK_ALERT_DAILY_SPEND_USD   the whole install, per day. Enforced by
 *                                nothing — it exists only to be alerted on.
 *
 * `alerts.ts` sums every priced turn on the install, so it measures the second.
 * Comparing that total to a per-principal cap is wrong the moment there are two
 * principals: the install crosses $10 while neither user is anywhere near their
 * own limit.
 *
 * So the install-wide variable wins when set, and the per-principal cap is used
 * as a fallback rather than left unset — because on the single-principal install
 * that self-hosting overwhelmingly means, they are the same number, and a
 * monitor that works out of the box beats one that waits to be configured. The
 * `scope` field is returned so the alert's own text can say which of the two it
 * just compared, instead of quietly implying the stricter one.
 */
export type CapScope = "install" | "per-principal";

export function dailySpendCap(env: Record<string, string | undefined>): {
  usd: number | null;
  scope: CapScope;
} {
  const raw = env.EVESTACK_ALERT_DAILY_SPEND_USD?.trim();

  if (raw !== undefined && raw !== "") {
    const word = raw.toLowerCase();
    // A deliberate "do not alert on spend". Must NOT fall through to the budget
    // cap, or the alert they just switched off comes straight back on.
    if (word === "false" || word === "off" || word === "none") {
      return { usd: null, scope: "install" };
    }
    const value = Number(word.replace(/^\$/, ""));
    if (Number.isFinite(value) && value >= 0) return { usd: value, scope: "install" };
    // Unparseable. Not silently uncapped — a typo in a threshold must fail
    // towards still watching, so this falls through to the per-principal cap
    // below rather than returning null. The alert's own detail names the scope,
    // so a reader sees which number it landed on.
  }

  const { dailyUsd } = readBudgetCaps(env);
  return { usd: dailyUsd === false ? null : dailyUsd, scope: "per-principal" };
}
