/**
 * The SQL this tool prints and will never run.
 *
 * `--fix` was considered and deliberately not built. `@workflow/world-postgres`
 * moved beta.31 -> beta.38 in two days; `_private_jobs` is a table graphile
 * marks private by name; and the correct action depends on facts this tool can
 * only infer (which run a job belongs to comes from base64 inside a payload).
 * An automated writer against that combination is a state corrupter waiting for
 * a schema bump. So: a human reads it, a human runs it, a human owns it.
 *
 * Everything below is shaped by that decision.
 *
 *   - Guarded. Every UPDATE repeats the conditions that made the job a finding,
 *     so a row that has moved since the scan is skipped rather than rewritten.
 *   - `attempts`, not `locked_at`. That is the entire point. On these rows
 *     locked_at is ALREADY NULL; the term of is_available that went false is
 *     `attempts < max_attempts`. Clearing the lock is the remediation everyone
 *     reaches for and it provably cannot work — graphile-crash-wedge.mjs walks
 *     three crash/clear cycles and shows the third one stop working.
 *   - Wrapped in an explicit transaction that the operator must commit, with
 *     the row count called out, because the failure mode of a copy-paste fix is
 *     touching more rows than intended.
 *   - Emitted only for jobs classified `process-death` AND blocking a live run.
 *     Nothing is printed for a job with a recorded last_error: that one failed
 *     for a reason, and resetting its attempts re-runs code that already failed.
 */

const RULE = "-- " + "-".repeat(74);

/**
 * graphile's job ids are `bigint`, which pg hands back as a string. They are
 * interpolated into SQL that a human is invited to paste into psql, so they are
 * validated rather than trusted: anything that is not a plain integer refuses to
 * render at all instead of emitting `where id = NaN` — or, worse, a comment line
 * carrying a value that could close it.
 */
function jobId(value) {
  const text = String(value);
  if (!/^\d+$/.test(text)) {
    throw new Error(
      `refusing to write remediation SQL for a non-numeric job id (${JSON.stringify(text)})`,
    );
  }
  return text;
}

export function remediationSql(jobs, { schema, generatedAt = new Date(), graphileVersion = null }) {
  if (jobs.length === 0) return null;

  const header = [
    RULE,
    "-- evestack doctor — remediation for graphile-worker jobs wedged by process death",
    RULE,
    "--",
    "-- READ THIS BEFORE RUNNING IT. evestack doctor is read-only and did not run it.",
    "--",
    `-- Generated ${generatedAt.toISOString()} against schema ${schema}` +
      `${graphileVersion ? `, graphile migration ${graphileVersion}` : ""}.`,
    "--",
    "-- WHY THIS TOUCHES attempts AND NOT locked_at",
    "--   is_available is a generated column:",
    "--     ((locked_at is null) and (attempts < max_attempts))",
    "--   and getJob spends an attempt at CLAIM time, not at failure time. On the rows",
    "--   below locked_at is already NULL. The term that went false is the second one,",
    "--   which is why clearing the lock, bumping run_at and pg_notify all do nothing.",
    "--",
    "-- BEFORE YOU RUN IT",
    "--   1. Re-run `evestack doctor` and confirm these job ids are still listed. The",
    "--      WHERE clauses below skip a row that has changed, so a stale script is a",
    "--      no-op rather than a corruption — but a no-op you did not expect is still",
    "--      a signal that the queue moved.",
    "--   2. Back up the table:",
    `--        pg_dump --data-only -t '${schema}._private_jobs' "$WORKFLOW_POSTGRES_URL" > jobs.sql`,
    "--   3. Prefer restarting the agent if you can afford it. @workflow/world's boot",
    "--      recovery enqueues a fresh, claimable job for every runnable run, which",
    "--      recovers the RUN without touching a beta schema at all. This SQL is for",
    "--      when a restart is not available to you.",
    "--",
    "-- WHAT IT DOES NOT COVER",
    "--   Jobs with a non-NULL last_error are excluded on purpose: those failed for a",
    "--   real reason and resetting their attempts re-runs code that already failed.",
    "--   Retired duplicates (a live sibling job exists for the same run) are excluded",
    "--   too: reviving one executes the same turn twice.",
    RULE,
    "",
    "begin;",
    "",
  ];

  const body = jobs.flatMap((job) => {
    const id = jobId(job.id);
    // Ids and run ids both land in a `--` comment, so a newline in either would
    // end the comment and leave the rest of the line as SQL. Neither can contain
    // one after this: the id is digits, and the run id is stripped to the
    // characters world-postgres actually generates.
    const runId = String(job.run_id ?? "").replace(/[^A-Za-z0-9_.:-]/g, "");
    const run = runId ? `run ${runId}` : "run unknown (payload could not be decoded)";
    const root = String(job.run?.root ?? "").replace(/[^A-Za-z0-9_.:-]/g, "");
    const session = root ? `, session ${root}` : "";
    return [
      `-- job ${id}: ${Number(job.attempts)}/${Number(job.max_attempts)} attempts spent, last_error NULL, ${run}${session}`,
      `update ${schema}._private_jobs`,
      "   set attempts  = 0,",
      "       locked_at = null,",
      "       locked_by = null,",
      "       run_at    = now()",
      ` where id = ${id}`,
      "   and attempts >= max_attempts   -- still dead?",
      "   and last_error is null;        -- still a process death, not a failure?",
      "",
    ];
  });

  const footer = [
    `-- Expect ${jobs.length} row${jobs.length === 1 ? "" : "s"} updated. If the count differs, ROLLBACK and`,
    "-- re-run `evestack doctor` — the queue moved under you.",
    "",
    "commit;   -- or: rollback;",
    "",
    "-- Workers poll on their own; this only saves the wait.",
    "select pg_notify('jobs:insert', '');",
    "",
  ];

  return [...header, ...body, ...footer].join("\n");
}
