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
import { findProjectEnv, projectEnv } from "./project.mjs";
import { remediationSql } from "./remediate.mjs";

/**
 * Where the connection string comes from, most explicit first.
 *
 * There used to be a `DEFAULT_CONNECTION` of
 * `postgres://evestack:evestack@localhost:5433/evestack` at the end of this
 * chain, and nothing anywhere read the project's env files. A scaffolded
 * project generates a random 24-character password, so that default could never
 * be right for the machine it was written for, and it failed in the most
 * confusing way available: `evestack doctor`, run in a project where `verify`
 * had printed "Everything works." seconds earlier, reported
 *
 *     Cannot reach Postgres at postgres://evestack:***@localhost:5433/evestack
 *       password authentication failed for user "evestack"
 *
 * about a database the agent, the dashboard, `status` and `verify` were all
 * connected to. The tell was the host: everything else said 127.0.0.1, from
 * .env.local, and only doctor said localhost, from a constant.
 *
 * So the guess is gone, and the project's own files take its place. The order
 * is the one `doctor --help` documents, extended at the bottom rather than
 * changed:
 *
 *   --url=…                  an operator pointing this at a database directly
 *   $WORKFLOW_POSTGRES_URL   a container, or `WORKFLOW_POSTGRES_URL=… doctor`
 *   $DATABASE_URL            the other name deployments use
 *   .env then .env.local     what `create` wrote, in eve's own load order
 *
 * `project` comes back so the caller can tell the two empty answers apart:
 * outside a project this command should refuse the way status, verify, open and
 * tour refuse, and inside one with no URL configured it should say that instead.
 */
export function resolveConnection(explicit, { from = process.cwd() } = {}) {
  if (explicit) return { connectionString: explicit, project: null };

  // `||` rather than `??`: an exported-but-empty WORKFLOW_POSTGRES_URL is a
  // variable nobody set, not a connection string of length zero.
  const fromEnvironment = process.env.WORKFLOW_POSTGRES_URL || process.env.DATABASE_URL;
  if (fromEnvironment) return { connectionString: fromEnvironment, project: null };

  // The same walk-up and the same merge every other project command does, so
  // that "which database" cannot mean one thing to `status` and another here.
  const found = findProjectEnv(from);
  if (!found) return { connectionString: null, project: null };

  const value = projectEnv(found);
  const configured = value("WORKFLOW_POSTGRES_URL") || value("DATABASE_URL");
  return { connectionString: configured ?? null, project: found.dir };
}

/**
 * Standing in a project that configures no database at all. Rare, and worth its
 * own sentence: the fix is a line in a file, not a container.
 */
export const NO_DATABASE_URL =
  "No database to look at.\n" +
  "  evestack doctor reads --url, then $WORKFLOW_POSTGRES_URL, then $DATABASE_URL,\n" +
  "  then WORKFLOW_POSTGRES_URL in this project's .env.local or .env. None is set.\n" +
  "  `evestack verify` checks the same line and says what it should look like.";

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
  const { connectionString } = resolveConnection(options.connectionString);
  if (!connectionString) throw new DoctorError(NO_DATABASE_URL);

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
