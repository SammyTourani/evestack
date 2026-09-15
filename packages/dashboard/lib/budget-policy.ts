import {
  validateBudgetPolicy,
  type BudgetConsumer,
  type BudgetSetting,
} from "@evestack/budget/settings";
import { readBudgetCaps } from "./budget-env";
import { isMissingTable, query } from "./db";

export async function readBudgetPolicy() {
  let settings: BudgetSetting | null = null;
  let consumers: BudgetConsumer[] = [];
  let sharedSchema = true;
  try {
    settings = await query<BudgetSetting>(
      "SELECT revision,policy,updated_at FROM evestack.budget_settings WHERE singleton",
    ).then((rows) => rows[0] ?? null);
  } catch (error) {
    // An older installation has no shared controls. Other failures must not
    // silently turn saved controls into an environment-default report.
    if (!isMissingTable(error)) throw error;
    sharedSchema = false;
  }
  if (sharedSchema)
    consumers = await query<BudgetConsumer>(
      "SELECT id,revision,observed,updated_at FROM evestack.budget_consumers ORDER BY updated_at DESC LIMIT 20",
    );
  let timeZone = process.env.EVESTACK_BUDGET_TIMEZONE?.trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone });
  } catch {
    timeZone = "UTC";
  }
  const mode = process.env.EVESTACK_BUDGET_MODE;
  const limits = settings
    ? validateBudgetPolicy(settings.policy)
    : {
        ...readBudgetCaps(process.env),
        timeZone,
        mode: mode === "cancel" || mode === "observe" ? mode : "fail",
      };
  return {
    limits,
    configuration: {
      source: settings ? "saved" : "environment",
      revision: settings?.revision ?? 0,
      updatedAt: settings?.updated_at ?? null,
      consumers,
      // A process observation is historical evidence, not proof that every
      // process (or this particular task) is enforcing the policy right now.
      explanation: settings
        ? "Saved policy applies to opted-in agents. Compare their last observed revisions; a running model call can still incur charges."
        : "Dashboard environment defaults. Custom agents may use different settings; enforcement has not been confirmed for this task.",
    },
  };
}
