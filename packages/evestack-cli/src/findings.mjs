/**
 * Raw query results in, findings out. Pure — no database, no clock beyond what
 * is passed in — because this is where the tool decides what to tell a person
 * at 3am, and that decision should be covered by tests rather than by care.
 *
 * Two rules hold everywhere below.
 *
 * ONE ACTIONABLE SENTENCE. Every finding carries exactly one `action`: what to
 * do, not what was observed. Evidence goes in the table underneath.
 *
 * NEVER PROMOTE AN INFERENCE TO A FACT. Three things here are inferred and each
 * says so in the finding text: the runId (decoded out of a base64 payload, not
 * joined), the tombstone (a NULL job key, which a job enqueued without a key
 * would also have), and anything at all when the runId could not be decoded.
 */
import { duration, firstLine } from "./format.mjs";

export const CRITICAL = "critical";
export const WARNING = "warning";
export const INFO = "info";

/**
 * graphile's janitor reclaims an abandoned lock only after this, hardcoded in
 * resetLockedAt.js; there is no `jobExpiry` option in 0.16.6 to tune it down.
 * It is scheduled every 8-10 minutes, so the threshold — not the cadence — is
 * what leaves a crashed job unclaimable.
 */
export const JANITOR_THRESHOLD_MS = 4 * 60 * 60 * 1000;

const finding = (id, severity, title, action, evidence = [], detail = []) => ({
  id,
  severity,
  title,
  action,
  evidence,
  detail,
});

/** A run that eve still expects to make progress. */
const RUNNABLE = new Set(["pending", "running"]);

/**
 * Split the DB-visible dead-job kinds by what the run behind them is doing.
 * `superseded` and `failed` are already decided by the queue alone; only
 * `process-death` needs the run to know whether it cost anybody anything.
 */
export function partitionDeadJobs(dead, runs) {
  const out = { wedging: [], leftover: [], unknownRun: [], superseded: [], failed: [] };
  for (const job of dead) {
    if (job.kind === "failed") {
      out.failed.push(job);
      continue;
    }
    if (job.kind === "superseded") {
      out.superseded.push(job);
      continue;
    }
    const run = job.run_id ? runs.get(job.run_id) : undefined;
    if (!run) out.unknownRun.push(job);
    else if (RUNNABLE.has(run.status)) out.wedging.push({ ...job, run });
    else out.leftover.push({ ...job, run });
  }
  return out;
}

export function buildFindings(input) {
  const {
    pre,
    health,
    dead = [],
    atRisk = [],
    locked = [],
    stranded = [],
    ratio = null,
    runs = new Map(),
    sessions = null,
    limit,
  } = input;

  const findings = [];
  const parts = partitionDeadJobs(dead, runs);

  /* ---------------------------------------------------------------------- */
  /* the queue                                                              */
  /* ---------------------------------------------------------------------- */

  if (stranded.length > 0) {
    findings.push(
      finding(
        "stranded-runs",
        CRITICAL,
        `${stranded.length} run${stranded.length === 1 ? " is" : "s are"} stranded behind a job that can never be claimed`,
        // Deliberately does not promise the SQL covers every run listed here: a
        // run whose only job failed for a real reason is stranded too, and that
        // one is not safe to revive. The per-job findings say which is which.
        "Restart the agent to let boot recovery enqueue a fresh claimable job for each of these runs, or work through the per-job findings below — only jobs killed by process death are safe to revive.",
        stranded.map((r) => ({
          run: r.run_id,
          status: r.status,
          name: r.name,
          jobs: r.jobs,
          claimable: r.claimable,
          created: r.created_at,
        })),
        [
          "Verified in contract/runtime/repro/graphile-crash-wedge.mjs STEP 10: boot recovery does",
          "not repair the dead row, it routes around it — and pays a new row per run per boot.",
        ],
      ),
    );
  }

  if (parts.wedging.length > 0) {
    findings.push(
      finding(
        "wedged-jobs",
        CRITICAL,
        `${parts.wedging.length} job${parts.wedging.length === 1 ? "" : "s"} died of process death and ${parts.wedging.length === 1 ? "is" : "are"} blocking a live run`,
        "Clear `attempts`, not `locked_at` — locked_at on these rows is already NULL and was never the term of is_available that went false — using the SQL printed below.",
        parts.wedging.map((j) => ({
          job: j.id,
          attempts: `${j.attempts}/${j.max_attempts}`,
          last_error: "NULL",
          run: j.run_id ?? "?",
          run_status: j.run.status,
          session: j.run.root ?? j.run.id,
        })),
        [
          "last_error NULL means failJob never ran: the worker process was killed mid-execution",
          "rather than failing. graphile spends an attempt at CLAIM time (getJob does",
          "`attempts = jobs.attempts + 1` in the statement that takes the lock), so three process",
          "deaths exhaust the maxAttempts: 3 that @workflow/world-postgres enqueues with.",
        ],
      ),
    );
  }

  if (parts.unknownRun.length > 0) {
    findings.push(
      finding(
        "wedged-jobs-unattributed",
        WARNING,
        `${parts.unknownRun.length} job${parts.unknownRun.length === 1 ? "" : "s"} died of process death and could not be matched to a run`,
        pre.hasWorkflowRuns
          ? "Check by hand whether each of these runs still needs to make progress before reviving anything — a dead job whose run finished by another path is inert, and reviving it would run the work again."
          : `No ${pre.workflowSchema}.workflow_runs table was found, so run the doctor with --workflow=<schema> pointed at eve's schema before acting on these.`,
        parts.unknownRun.map((j) => ({
          job: j.id,
          attempts: `${j.attempts}/${j.max_attempts}`,
          run: j.run_id ?? "could not decode",
          created: j.created_at,
        })),
        [
          "The runId is decoded out of the base64 workflow body inside the graphile payload, not",
          "joined — world-postgres stores no foreign key. A payload this tool cannot decode is",
          "reported as undecodable rather than guessed at.",
        ],
      ),
    );
  }

  if (parts.superseded.length > 0) {
    findings.push(
      finding(
        "superseded-jobs",
        INFO,
        `${parts.superseded.length} dead job${parts.superseded.length === 1 ? " is a retired leftover" : "s are retired leftovers"}, not ${parts.superseded.length === 1 ? "a fault" : "faults"}`,
        "Leave these alone: the run they belong to already has a claimable job, so reviving one would execute the same turn a second time.",
        parts.superseded.map((j) => ({
          job: j.id,
          attempts: `${j.attempts}/${j.max_attempts}`,
          job_key: j.job_key === null ? "NULL (retired)" : "set",
          run: j.run_id ?? "?",
          live_job: j.sibling_id,
        })),
        [
          "graphile retires a held job when the same key is re-enqueued (`set key = null,",
          "attempts = jobs.max_attempts ... where is_available is not true`) — reproduced in",
          "graphile-crash-wedge.mjs STEP 8. A NULL key alone does not prove that happened: a job",
          "enqueued with no jobKey also has one. The live sibling is what makes this safe to say.",
        ],
      ),
    );
  }

  if (parts.leftover.length > 0) {
    findings.push(
      finding(
        "leftover-jobs",
        INFO,
        `${parts.leftover.length} dead job${parts.leftover.length === 1 ? " belongs to a run that has" : "s belong to runs that have"} already finished`,
        "No action: these cost nothing and reviving them would re-run work that has already completed.",
        parts.leftover.map((j) => ({
          job: j.id,
          attempts: `${j.attempts}/${j.max_attempts}`,
          run: j.run_id ?? "?",
          run_status: j.run.status,
        })),
      ),
    );
  }

  if (parts.failed.length > 0) {
    findings.push(
      finding(
        "failed-jobs",
        WARNING,
        `${parts.failed.length} job${parts.failed.length === 1 ? " exhausted its" : "s exhausted their"} attempts with a real error`,
        "Fix the cause and re-enqueue: these are NOT the process-death case, and resetting `attempts` would only re-run code that has already failed on purpose.",
        parts.failed.map((j) => ({
          job: j.id,
          attempts: `${j.attempts}/${j.max_attempts}`,
          run: j.run_id ?? "?",
          last_error: firstLine(j.last_error),
        })),
        [
          "A recorded last_error means failJob ran, which means the handler threw and graphile",
          "did exactly what it was told to. No remediation SQL is printed for these.",
        ],
      ),
    );
  }

  /* ---------------------------------------------------------------------- */
  /* jobs on their way there                                                */
  /* ---------------------------------------------------------------------- */

  const staleLocks = locked.filter((j) => Number(j.locked_for_ms) >= JANITOR_THRESHOLD_MS);
  if (staleLocks.length > 0) {
    findings.push(
      finding(
        "stale-locks",
        WARNING,
        `${staleLocks.length} job${staleLocks.length === 1 ? " has" : "s have"} been locked for longer than graphile's 4-hour reclaim threshold`,
        "Confirm the named workers are actually gone, then let the janitor reclaim them rather than clearing locked_at by hand — every reclaim spends one more attempt, and the attempts are what run out.",
        staleLocks.map((j) => ({
          job: j.id,
          locked_for: duration(j.locked_for_ms),
          locked_by: j.locked_by,
          attempts: `${j.attempts}/${j.max_attempts}`,
          crashes_left: Math.max(0, j.max_attempts - j.attempts - 1),
        })),
        [
          "resetLockedAt uses a hardcoded `interval '4 hours'` and runs every 8-10 minutes, so the",
          "threshold is the binding constraint: a crash-interrupted job is unclaimable for at least",
          "four hours with no operator action, and the operator's instinct to clear the lock is",
          "what spends the attempt budget that eventually kills it.",
        ],
      ),
    );
  }

  const oneCrashLeft = atRisk.filter((j) => j.max_attempts - j.attempts === 1);
  if (oneCrashLeft.length > 0) {
    findings.push(
      finding(
        "one-attempt-left",
        WARNING,
        `${oneCrashLeft.length} job${oneCrashLeft.length === 1 ? " is" : "s are"} one worker death away from being permanently unclaimable`,
        "Stop clearing locks on these and stop restarting workers while they are held — the next claim is their last, and nothing anywhere else in the stack warns that a job has one attempt left.",
        oneCrashLeft.map((j) => ({
          job: j.id,
          attempts: `${j.attempts}/${j.max_attempts}`,
          locked: j.locked_at === null ? "no" : "yes",
          run: j.run_id ?? "?",
        })),
      ),
    );
  }

  /* ---------------------------------------------------------------------- */
  /* accumulation                                                           */
  /* ---------------------------------------------------------------------- */

  // Only worth raising as a ratio, and only above a floor: on a small or nearly
  // empty queue the ratio is noise, and a diagnostic that cries wolf gets muted.
  if (ratio && ratio.jobs >= 10 && ratio.ratio !== null && ratio.ratio >= 3) {
    findings.push(
      finding(
        "enqueue-flooding",
        WARNING,
        `${ratio.jobs} jobs are queued for ${ratio.distinct_runs} distinct runs (${ratio.ratio.toFixed(1)}x)`,
        "Restart the agent less often while runs are outstanding, or expect the table to keep growing: boot recovery enqueues a fresh job per runnable run on every boot under a new key, so nothing ever dedupes them.",
        [
          {
            jobs: ratio.jobs,
            distinct_runs: ratio.distinct_runs,
            jobs_per_run: ratio.ratio.toFixed(2),
            undecodable_payloads: ratio.undecodable,
          },
        ],
        [
          "Treat the ratio as a FLOOR, not a count: graphile DELETEs a job on success, so every",
          "duplicate that actually ran is already gone and cannot be counted here. Mechanism is",
          "vercel/workflow#3119, reproduced in graphile-crash-wedge.mjs STEP 9.",
        ],
      ),
    );
  }

  /* ---------------------------------------------------------------------- */
  /* sessions                                                               */
  /* ---------------------------------------------------------------------- */

  if (sessions) {
    const wedged = sessions.entries.filter((e) => e.health === "wedged");
    if (wedged.length > 0) {
      findings.push(
        finding(
          "wedged-sessions",
          CRITICAL,
          `${wedged.length} session${wedged.length === 1 ? "" : "s"} started a turn that never finished`,
          "Restart the agent to let boot recovery re-enqueue these runs, or cancel the turn — eve has no path that notices or retries a turn whose process died mid-flight.",
          wedged.map((e) => ({
            session: e.sessionId,
            title: e.title ?? "-",
            idle: duration(e.idleMs),
            trigger: e.trigger ?? "-",
          })),
        ),
      );
    }

    if (!sessions.agentReachable) {
      findings.push(
        finding(
          "sessions-unclassified",
          WARNING,
          `${sessions.candidates.length} session${sessions.candidates.length === 1 ? " has" : "s have"} been quiet for over ${duration(sessions.idleMs)}, and ${sessions.candidates.length === 1 ? "it cannot be classified" : "none of them can be classified"}`,
          `Start the agent, or pass --agent-url, and re-run — do not treat a quiet session as stuck on the strength of SQL alone.`,
          sessions.candidates.slice(0, 10).map((c) => ({
            session: c.sessionId,
            title: c.title ?? "-",
            idle: duration(c.idleMs),
          })),
          [
            "idle, awaiting-human and wedged are indistinguishable in the workflow tables: eve",
            "leaves a session's run row `running` and its stream `waiting` for the life of the",
            "session. packages/dashboard/lib/fleet.ts guessed from SQL alone in its first version",
            "and reported 22 healthy sessions as wedged. Reason unreachable: " +
              (sessions.agentError?.message ?? "unknown"),
          ],
        ),
      );
    }
  }

  /* ---------------------------------------------------------------------- */
  /* what the tool could not see                                            */
  /* ---------------------------------------------------------------------- */

  if (health?.availabilityDerived) {
    findings.push(
      finding(
        "availability-derived",
        WARNING,
        "graphile's `is_available` column is missing, so availability was computed rather than read",
        "Check the graphile-worker version before trusting any availability number in this report: the definition used here — (locked_at is null and attempts < max_attempts) — is copied from migration 000011 and may no longer match.",
      ),
    );
  }

  if (dead.length >= limit) {
    findings.push(
      finding(
        "truncated",
        INFO,
        `The dead-job list hit the --limit of ${limit}`,
        `Re-run with --limit=${limit * 4} to see the rest; every count in the QUEUE section above is complete, only the listed rows are capped.`,
      ),
    );
  }

  return findings;
}

/** Exit 1 only for something that is costing a run right now. A dead job whose
 *  run found another way forward is worth knowing and is not an incident. */
export function exitCodeFor(findings) {
  return findings.some((f) => f.severity === CRITICAL) ? 1 : 0;
}
