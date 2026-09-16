// These dependency-free modules are also shipped by the CLI. Next bundles
// their code; no CLI process, project env reader or remediation module runs.
import {
  preflight,
  queueHealth,
  deadJobs,
  atRiskJobs,
  lockedJobs,
  strandedRuns,
  enqueueRatio,
  describeRuns,
} from "../../evestack-cli/src/queue.mjs";
import { buildFindings } from "../../evestack-cli/src/findings.mjs";
import { getPool } from "./db";

const LIMIT = 20;
export interface QueueFinding {
  id: string;
  severity: string;
  title: string;
  action: string;
  blind: boolean;
  detail: string[];
  evidence: Record<string, string>[];
}
export interface QueueDiagnosis {
  checkedAt: string;
  scope: string;
  readOnly: true;
  schema: string;
  workflowSchema: string;
  migration: string | null;
  counts: Record<string, number | boolean>;
  findings: QueueFinding[];
  coverage: {
    rowLimit: number;
    agent: "not_probed";
    candidates: Record<string, number>;
    possiblyTruncated: string[];
    displayTruncated: boolean;
  };
}

/** One transaction, no writes or live-agent calls. Missing/changed storage fails explicitly. */
export async function diagnoseQueue(): Promise<QueueDiagnosis> {
  const client = await getPool().connect();
  const deadline = Date.now() + 10000;
  const boundedClient = {
    async query(text: string, values?: unknown[]) {
      if (Date.now() >= deadline)
        throw new Error("Queue diagnosis exceeded its time limit.");
      // preflight deliberately tolerates an absent migration table. A savepoint
      // keeps that optional failed SELECT from aborting the surrounding snapshot.
      await client.query("SAVEPOINT diagnostic_read");
      try {
        const result = await client.query(text, values);
        await client.query("RELEASE SAVEPOINT diagnostic_read");
        return result;
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT diagnostic_read");
        await client.query("RELEASE SAVEPOINT diagnostic_read");
        throw error;
      }
    },
  };
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout='1500ms'");
    if (
      (await client.query("SHOW transaction_read_only")).rows[0]
        .transaction_read_only !== "on"
    )
      throw new Error("A read-only transaction could not be established.");
    const pre = await preflight(boundedClient, {
      schema: "graphile_worker",
      workflowSchema: "workflow",
    });
    if (!pre.hasPrivateJobs)
      throw new Error("The standard Graphile queue is unavailable.");
    const required = pre.missingColumns.filter(
      (name: string) => name !== "is_available",
    );
    if (required.length)
      throw new Error("The queue schema is not supported by this diagnostic.");
    const health = await queueHealth(boundedClient, pre);
    const dead = await deadJobs(boundedClient, pre, LIMIT);
    const atRisk = await atRiskJobs(boundedClient, pre, LIMIT);
    const locked = await lockedJobs(boundedClient, pre, LIMIT);
    const ratio = await enqueueRatio(boundedClient, pre);
    const runs = pre.hasWorkflowRuns
      ? await describeRuns(boundedClient, pre, [
          ...new Set(
            dead.map((job: { run_id?: string }) => job.run_id).filter(Boolean),
          ),
        ])
      : new Map();
    const stranded = pre.hasWorkflowRuns
      ? await strandedRuns(boundedClient, pre, LIMIT)
      : [];
    const findings = buildFindings({
      pre,
      health,
      dead,
      atRisk,
      locked,
      stranded,
      ratio,
      runs,
      sessions: null,
      probeLimit: 0,
      limit: LIMIT,
    });
    await client.query("COMMIT");
    let displayTruncated = findings.length > 25;
    const text = (value: unknown, limit = 1200) => {
      const raw = String(value ?? "").replace(/[\x00-\x1f\x7f]/g, " ");
      if (raw.length > limit) displayTruncated = true;
      return raw.slice(0, limit);
    };
    const visible = findings.slice(0, 25).map((finding: QueueFinding) => {
      if (finding.evidence.length > 10 || finding.detail.length > 10)
        displayTruncated = true;
      return {
        id: text(finding.id, 100),
        severity: text(finding.severity, 30),
        title: text(finding.title),
        action: text(finding.action),
        blind: finding.blind === true,
        detail: finding.detail.slice(0, 10).map((line) => text(line)),
        evidence: finding.evidence.slice(0, 10).map((row) => {
          if (Object.keys(row).length > 10) displayTruncated = true;
          return Object.fromEntries(
            Object.entries(row)
              .slice(0, 10)
              .map(([key, value]) => [text(key, 100), text(value, 500)]),
          );
        }),
      };
    });
    const candidates = {
      exhausted: dead.length,
      atRisk: atRisk.length,
      locked: locked.length,
      stranded: stranded.length,
    };
    return {
      checkedAt: new Date().toISOString(),
      readOnly: true,
      scope:
        "Installation queue snapshot. Shared with evestack doctor; task-specific live-agent, provider, sandbox and external receipt checks are not performed.",
      schema: pre.schema,
      workflowSchema: pre.workflowSchema,
      migration: pre.migration === null ? null : String(pre.migration),
      counts: health,
      findings: visible,
      coverage: {
        rowLimit: LIMIT,
        agent: "not_probed",
        candidates,
        possiblyTruncated: Object.entries(candidates)
          .filter(([, count]) => count >= LIMIT)
          .map(([name]) => name),
        displayTruncated,
      },
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
