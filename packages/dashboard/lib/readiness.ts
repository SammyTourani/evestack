import { agentFetch } from "./agent-client";
import { getPool } from "./db";
import { resolveSinks } from "./alert-delivery";

export const READINESS_IDS = ["database", "agent", "model", "embeddings", "connections", "notifications"] as const;
export type ReadinessId = (typeof READINESS_IDS)[number];
export type ReadinessStatus = "verified" | "configured" | "unconfigured" | "unavailable" | "unknown";
export interface ReadinessCheck {
  id: ReadinessId;
  name: string;
  status: ReadinessStatus;
  /** Only an actual successful probe is ready. Configuration is not a probe. */
  ready: boolean;
  detail: string;
  action: string;
  href: string;
  checkedAt: string;
}

async function probeDatabase() {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '3000ms'");
    await client.query("SELECT 1 FROM workflow.workflow_runs LIMIT 1");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function checkReadiness(id: ReadinessId): Promise<ReadinessCheck> {
  let status: ReadinessStatus;
  let detail: string;
  let name: string;
  let action = "Check setup instructions";
  let href = "/settings";
  switch (id) {
    case "database":
      name = "Database";
      try {
        await probeDatabase();
        status = "verified";
        detail = "Workflow storage answered a read-only query. This does not verify a backup or every schema.";
      } catch {
        status = "unavailable";
        detail = "Workflow storage did not answer. In your agent project, run npx evestack doctor. Check Postgres access and npm run db:bootstrap before retrying.";
      }
      break;
    case "agent":
      name = "Agent";
      try {
        const response = await agentFetch("/eve/v1/health", { timeoutMs: 2500 });
        await response.body?.cancel();
        if (!response.ok) throw new Error("Health check failed");
        status = "verified";
        detail = "The agent health endpoint answered. A task still needs to verify its model and tools.";
      } catch {
        status = "unavailable";
        detail = "The agent health endpoint did not answer successfully. Check that the agent is running, then verify EVESTACK_AGENT_URL and the dashboard's agent credentials. Saved Postgres evidence remains available when storage is reachable.";
      }
      break;
    case "model":
      name = "Model";
      status = "unknown";
      detail = "The dashboard cannot verify the agent's provider credentials from its own environment. Run a task and inspect its reply and recorded model call, or run npx evestack tour in the agent project.";
      action = "Open a first task";
      href = "/chat?example=repository-brief";
      break;
    case "embeddings":
      name = "Embeddings";
      status = "unknown";
      detail = "Existing memories do not prove that the current embedding provider works. Verify a scoped remember and recall through the agent. Changing the model or dimensions requires a backed-up re-embedding migration.";
      action = "Inspect remembered facts";
      href = "/memory";
      break;
    case "connections":
      name = "Connected accounts";
      status = process.env.COMPOSIO_API_KEY?.trim() ? "configured" : "unconfigured";
      detail = status === "configured"
        ? "A Composio key is present on this dashboard. Check the account identity and grant in Connections; only a real task can verify repository access and agent tool configuration."
        : "Set COMPOSIO_API_KEY in the agent and dashboard environments, then restart both processes to enable hosted account authorization.";
      action = "Check a connection";
      href = "/connections";
      break;
    case "notifications": {
      name = "Notifications";
      const config = resolveSinks(process.env);
      status = config.sinks.length ? "configured" : process.env.EVESTACK_ALERT_WEBHOOK_URL?.trim() ? "unavailable" : "unconfigured";
      detail = status === "configured"
        ? "At least one valid delivery destination is configured. Send a test in Connections and verify receipt. A configuration check sends no notification."
        : status === "unavailable"
          ? "No configured delivery destination is valid. Check EVESTACK_ALERT_WEBHOOK_URL and restart the dashboard."
          : "Set EVESTACK_ALERT_WEBHOOK_URL to an operator-controlled destination and restart the dashboard, then test delivery.";
      action = "Test notification delivery";
      href = "/connections";
      break;
    }
  }
  return { id, name, status, ready: status === "verified", detail, action, href, checkedAt: new Date().toISOString() };
}

export async function readReadiness(id?: ReadinessId) {
  const checks = await Promise.all((id ? [id] : READINESS_IDS).map(checkReadiness));
  return { checkedAt: new Date().toISOString(), checks };
}
