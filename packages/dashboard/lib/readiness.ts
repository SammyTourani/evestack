import { agentFetch } from "./agent-client";
import { query } from "./db";
import { readBudgetCaps } from "./budget-env";

export async function readReadiness() {
  const [database, agent] = await Promise.allSettled([
    query("SELECT 1 FROM workflow.workflow_runs LIMIT 1"),
    agentFetch("/eve/v1/health", { timeoutMs: 2500 }).then(async (response) => {
      await response.body?.cancel();
      if (!response.ok)
        throw new Error(`Agent health returned ${response.status}`);
    }),
  ]);
  return {
    checkedAt: new Date().toISOString(),
    checks: [
      {
        name: "Database",
        ready: database.status === "fulfilled",
        detail:
          database.status === "fulfilled"
            ? "Workflow storage is readable."
            : "Check Postgres and run npm run db:bootstrap in your agent project.",
      },
      {
        name: "Agent",
        ready: agent.status === "fulfilled",
        detail:
          agent.status === "fulfilled"
            ? "The agent health endpoint answered. A real task still needs to verify the model and its credentials."
            : "Start the agent and verify EVESTACK_AGENT_URL and its credentials on the dashboard.",
      },
      {
        name: "Connected accounts",
        ready: Boolean(process.env.COMPOSIO_API_KEY),
        detail: process.env.COMPOSIO_API_KEY
          ? "A Composio key is configured on this dashboard. Inspect account health in Connections."
          : "Set COMPOSIO_API_KEY in the agent and dashboard environments, then restart both processes to enable account connections.",
      },
      {
        name: "Notifications",
        ready: Boolean(process.env.EVESTACK_ALERT_WEBHOOK_URL),
        detail: process.env.EVESTACK_ALERT_WEBHOOK_URL
          ? "A delivery destination is configured. Inspect delivery status in Diagnostics → Health & incidents."
          : "Set EVESTACK_ALERT_WEBHOOK_URL to an operator-controlled destination, then restart the dashboard.",
      },
    ],
    budget: readBudgetCaps(process.env),
    budgetMode: process.env.EVESTACK_BUDGET_MODE ?? "fail",
    budgetFailClosed:
      process.env.EVESTACK_BUDGET_FAIL_CLOSED === "1" ||
      process.env.EVESTACK_BUDGET_FAIL_CLOSED === "true",
  };
}
