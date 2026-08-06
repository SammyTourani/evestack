/**
 * `evestack doctor` — why is this durable job dead?
 *
 * The orchestration only. Every query lives in queue.mjs, every judgement in
 * findings.mjs, every byte of remediation in remediate.mjs, so the part that
 * talks to a stranger's production database is small enough to read in one go.
 *
 * The order below is the order of an actual diagnosis: find out what is even
 * present, count the queue, then look only at rows that could be a problem, and
 * only then ask eve what its sessions think they are doing.
 */
import { connect, describeServer, safeIdentifier, DoctorError, redact } from "./db.mjs";
import {
  preflight,
  queueHealth,
  deadJobs,
  atRiskJobs,
  lockedJobs,
  strandedRuns,
  runnableRunSummary,
  enqueueRatio,
  describeRuns,
} from "./queue.mjs";
import {
  quietSessions,
  inspectSessions,
  agentBaseUrl,
  IDLE_BEFORE_SUSPECT_MS,
  MAX_PROBES,
} from "./sessions.mjs";
import { buildFindings, exitCodeFor, partitionDeadJobs } from "./findings.mjs";
import { remediationSql } from "./remediate.mjs";

export const DEFAULT_CONNECTION = "postgres://evestack:evestack@localhost:5433/evestack";

export function resolveConnection(explicit) {
  return (
    explicit ??
    process.env.WORKFLOW_POSTGRES_URL ??
    process.env.DATABASE_URL ??
    DEFAULT_CONNECTION
  );
}

/**
 * Runs the whole diagnosis and returns a plain object. Rendering happens
 * elsewhere so that `--json` and the human report are the same diagnosis rather
 * than two code paths that can disagree about what was found.
 */
export async function diagnose(options = {}) {
  const schema = safeIdentifier(options.schema ?? "graphile_worker", "--schema");
  const workflowSchema = safeIdentifier(options.workflow ?? "workflow", "--workflow");
  const limit = Math.max(1, Math.min(Number(options.limit ?? 50), 1000));
  const idleMs = Number(options.idleMs ?? IDLE_BEFORE_SUSPECT_MS);
  const probeLimit = Math.max(0, Math.min(Number(options.probes ?? MAX_PROBES), 100));
  const connectionString = resolveConnection(options.connectionString);

  const { client, readOnly, timeoutMs } = await connect({
    connectionString,
    timeoutMs: Number(options.timeoutMs ?? 15_000),
  });

  try {
    const server = await describeServer(client);
    const pre = await preflight(client, { schema, workflowSchema });

    const report = {
      generatedAt: new Date(),
      connection: {
        target: redact(connectionString),
        database: server.database ?? null,
        user: server.user ?? null,
        serverVersion: server.version ?? null,
        // Reported rather than assumed: a pooler in transaction mode silently
        // drops session-level SET, which downgrades the guarantee from "the
        // server will refuse a write" to "this tool only sends SELECTs".
        readOnlyEnforced: readOnly,
        statementTimeoutMs: timeoutMs,
      },
      schemas: {
        graphile: schema,
        workflow: workflowSchema,
        graphileMigration: pre.migration,
        privateJobsPresent: pre.hasPrivateJobs,
        publicJobsViewPresent: pre.hasJobsView,
        publicViewExposesAvailability: pre.viewExposesAvailability,
        workflowRunsPresent: pre.hasWorkflowRuns,
        missingColumns: pre.missingColumns,
      },
      limits: { limit, idleMs, probeLimit },
      health: null,
      dead: [],
      atRisk: [],
      locked: [],
      stranded: [],
      runSummary: null,
      ratio: null,
      sessions: null,
      findings: [],
      remediation: null,
      exitCode: 0,
    };

    // Nothing below can run without the private jobs table, and guessing which
    // schema someone meant would be worse than saying so.
    if (!pre.hasPrivateJobs) {
      throw new DoctorError(
        `No ${schema}._private_jobs table in ${server.database ?? "this database"}.\n` +
          `  If graphile-worker lives in another schema, pass --schema=<name>.\n` +
          `  If this deployment does not use @workflow/world-postgres, there is no\n` +
          `  durable job queue here for the doctor to look at.`,
      );
    }

    report.health = await queueHealth(client, pre);
    report.dead = await deadJobs(client, pre, limit);
    report.atRisk = await atRiskJobs(client, pre, limit);
    report.locked = await lockedJobs(client, pre, limit);
    report.ratio = await enqueueRatio(client, pre);

    let runs = new Map();
    if (pre.hasWorkflowRuns) {
      // Correlation is bounded by the dead-job list, not by the queue: this is
      // the only place the two schemas are joined and it stays small on purpose.
      const runIds = [...new Set(report.dead.map((j) => j.run_id).filter(Boolean))];
      runs = await describeRuns(client, pre, runIds);
      report.stranded = await strandedRuns(client, pre, limit);
      report.runSummary = await runnableRunSummary(client, pre);
    }
    report.runs = runs;

    /* -- sessions ---------------------------------------------------------- */

    if (pre.hasWorkflowRuns && probeLimit > 0) {
      const { candidates, unchecked } = await quietSessions(client, {
        workflowSchema,
        idleMs,
        limit: probeLimit,
      });
      const baseUrl = agentBaseUrl(options.agentUrl);
      const probe =
        candidates.length === 0
          ? { entries: [], agentReachable: true, agentError: null, probed: 0 }
          : await inspectSessions(candidates, { baseUrl, timeoutMs });
      report.sessions = { ...probe, candidates, unchecked, idleMs, agentUrl: baseUrl };
    }

    /* -- judgement --------------------------------------------------------- */

    report.findings = buildFindings({
      pre,
      health: report.health,
      dead: report.dead,
      atRisk: report.atRisk,
      locked: report.locked,
      stranded: report.stranded,
      ratio: report.ratio,
      runs,
      sessions: report.sessions,
      limit,
    });

    // Remediation is only ever offered for the one case that has a safe answer:
    // a job killed mid-execution whose run is still expecting it.
    const parts = partitionDeadJobs(report.dead, runs);
    report.remediation = remediationSql(parts.wedging, {
      schema,
      generatedAt: report.generatedAt,
      graphileVersion: pre.migration,
    });
    report.exitCode = exitCodeFor(report.findings);
    return report;
  } finally {
    await client.end().catch(() => {});
  }
}
