/**
 * Everything `evestack doctor` knows about the graphile-worker queue.
 *
 * The mechanism this reads for is reproduced with real SIGKILLs in
 * contract/runtime/repro/graphile-crash-wedge.mjs (36 assertions), and the
 * read-only shape of these queries follows
 * contract/runtime/repro/scan-wedged-jobs.mjs, which has already been run
 * against real data (186 job rows, 95 runs, 2 dead jobs, 0 stranded runs).
 * Both are ground truth; this file is the productised form of the second.
 *
 * The one fact everything here turns on:
 *
 *   is_available boolean generated always as
 *     ((locked_at is null) and (attempts < max_attempts)) stored
 *
 * and `getJob` does `attempts = jobs.attempts + 1` in the same statement that
 * takes the lock. So an attempt is spent at CLAIM time, not at failure time,
 * and three process DEATHS — not three failures — exhaust the `maxAttempts: 3`
 * that @workflow/world-postgres enqueues with. The term of `is_available` that
 * goes false is `attempts < max_attempts`, never `locked_at is null`, which is
 * why every instinctive remediation (clear the lock, bump run_at, pg_notify)
 * provably cannot work. That distinction is the whole finding, and it is why
 * this tool prints `set attempts = 0` and not `set locked_at = null`.
 */

/**
 * We read `_private_jobs`, whose name says plainly that graphile does not
 * consider it public API. That is a real cost and it is taken deliberately:
 * the public `jobs` view does not expose `is_available`, so through the
 * supported surface a permanently-dead job shows no error, no lock, and a
 * run_at in the past — it reads as healthy. There is no way to answer "why is
 * this job dead" from the stable view. Rather than pretend otherwise, the
 * preflight below checks for each column it wants and the report degrades
 * loudly when graphile moves.
 */
export const PRIVATE_JOBS = "_private_jobs";

/** Columns we would like on `_private_jobs`; presence is probed, not assumed. */
const WANTED_COLUMNS = [
  "id",
  "job_queue_id",
  "task_id",
  "payload",
  "priority",
  "run_at",
  "attempts",
  "max_attempts",
  "last_error",
  "created_at",
  "updated_at",
  "key",
  "locked_at",
  "locked_by",
  "is_available",
];

/**
 * Reproduces the generated column when graphile has not got one, so a schema
 * change downgrades this tool to "computing it myself" instead of to a crash.
 * The definition is copied from migration 000011 and re-verified by the repro
 * script against the installed package on every runtime run.
 */
export function availabilityExpression(columns) {
  return columns.has("is_available")
    ? { sql: "j.is_available", derived: false }
    : { sql: "(j.locked_at is null and j.attempts < j.max_attempts)", derived: true };
}

/**
 * Dig the workflow runId out of the graphile payload.
 *
 * world-postgres stores the workflow body base64-encoded inside the payload, so
 * there is no foreign key to join on — the run a job belongs to has to be
 * decoded. Two deliberate differences from the auditor script, both about being
 * safe to point at a stranger's database:
 *
 *   - the base64 shape is checked before `decode` runs, and
 *   - the runId is pulled with a regex rather than `::json ->> 'runId'`,
 *
 * because one malformed payload row would otherwise abort the entire diagnostic
 * query with a cast error and the operator would get nothing at all. Both make
 * this INFERENCE, not a join, and the report says so wherever a runId appears.
 */
export function runIdExpression(columns) {
  if (!columns.has("payload")) return "null::text";
  return `case
        when j.payload->>'data' ~ '^[A-Za-z0-9+/]+={0,2}$'
         and length(j.payload->>'data') % 4 = 0
        then substring(
               convert_from(decode(j.payload->>'data','base64'),'UTF8')
               from '"runId"[[:space:]]*:[[:space:]]*"([^"]+)"')
      end`;
}

/* -------------------------------------------------------------------------- */
/* preflight                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What is actually present. Every later query is shaped by this, so a database
 * with no graphile schema, or an eve deployment on a different world, produces
 * a report that says what it could not look at rather than a stack trace.
 */
export async function preflight(client, { schema, workflowSchema }) {
  const { rows: cols } = await client.query(
    `select column_name from information_schema.columns
      where table_schema = $1 and table_name = $2`,
    [schema, PRIVATE_JOBS],
  );
  const columns = new Set(cols.map((c) => c.column_name));

  const { rows: present } = await client.query(
    `select
       (select count(*) from information_schema.views
         where table_schema = $1 and table_name = 'jobs')            as jobs_view,
       (select count(*) from information_schema.columns
         where table_schema = $1 and table_name = 'jobs'
           and column_name = 'is_available')                          as view_exposes_availability,
       (select count(*) from information_schema.tables
         where table_schema = $2 and table_name = 'workflow_runs')    as workflow_runs`,
    [schema, workflowSchema],
  );

  let migration = null;
  try {
    const { rows } = await client.query(
      `select max(id) as id from ${schema}.migrations`,
    );
    migration = rows[0]?.id ?? null;
  } catch {
    // graphile's migrations table is not load-bearing here; its absence only
    // costs us a version number in the header.
  }

  return {
    schema,
    workflowSchema,
    columns,
    hasPrivateJobs: columns.size > 0,
    hasJobsView: Number(present[0].jobs_view) > 0,
    viewExposesAvailability: Number(present[0].view_exposes_availability) > 0,
    hasWorkflowRuns: Number(present[0].workflow_runs) > 0,
    missingColumns: WANTED_COLUMNS.filter((c) => !columns.has(c)),
    migration,
  };
}

/* -------------------------------------------------------------------------- */
/* queries                                                                     */
/* -------------------------------------------------------------------------- */

/** Counts only — one scan, no rows shipped, safe on a large queue. */
export async function queueHealth(client, pre) {
  const avail = availabilityExpression(pre.columns);
  const { rows } = await client.query(`
    select count(*)::int                                                     as jobs,
           count(*) filter (where ${avail.sql})::int                         as available,
           count(*) filter (where not ${avail.sql})::int                     as unavailable,
           count(*) filter (where j.locked_at is not null)::int              as locked,
           count(*) filter (where j.attempts >= j.max_attempts)::int         as attempts_exhausted,
           count(*) filter (where j.attempts >= j.max_attempts
                              and j.last_error is null)::int                 as exhausted_without_error,
           count(*) filter (where j.locked_at < now() - interval '4 hours')::int
                                                                             as lock_past_janitor_threshold
      from ${pre.schema}.${PRIVATE_JOBS} as j`);
  return { ...rows[0], availabilityDerived: avail.derived };
}

/**
 * Every job that can never be claimed again, with the two facts that decide
 * what to do about it: whether an error was ever recorded, and whether the run
 * it belongs to already has another job that CAN be claimed.
 *
 * That second fact is the one that keeps this tool honest. graphile
 * deliberately retires a held job when the same key is re-enqueued
 * (`set key = null, attempts = jobs.max_attempts ... where is_available is not
 * true`), and @workflow/world's boot recovery enqueues a fresh job per runnable
 * run on every restart. Both leave a dead row behind that is inert. Reviving
 * one would execute the same turn a second time, so "dead" alone is not a
 * reason to act — "dead and nothing else can run for this run" is.
 */
export async function deadJobs(client, pre, limit) {
  const avail = availabilityExpression(pre.columns);
  const runId = runIdExpression(pre.columns);
  const lastError = pre.columns.has("last_error") ? "j.last_error" : "null::text";
  const key = pre.columns.has("key") ? "j.key" : "null::text";

  // One scan builds both the dead rows and the per-run claimable counts they
  // are judged against; doing it as two queries would scan the table twice and
  // could disagree with itself if a worker moved in between.
  const { rows } = await client.query(
    `
    with j as (
      select j.id, j.attempts, j.max_attempts, j.locked_at, j.locked_by,
             j.run_at, j.created_at,
             ${lastError} as last_error,
             ${key}       as job_key,
             ${avail.sql} as avail,
             ${runId}     as run_id
        from ${pre.schema}.${PRIVATE_JOBS} as j
    ),
    sibling as (
      select run_id,
             count(*) filter (where avail)::int as claimable,
             min(id)  filter (where avail)      as claimable_id
        from j
       where run_id is not null
       group by run_id
    )
    select j.*,
           coalesce(sibling.claimable, 0) as sibling_claimable,
           sibling.claimable_id           as sibling_id
      from j
      left join sibling on sibling.run_id = j.run_id
     where j.attempts >= j.max_attempts
     order by j.created_at, j.id
     limit $1`,
    [limit],
  );
  return rows.map((row) => ({ ...row, kind: classifyDeadJob(row) }));
}

/**
 * Three outcomes that look identical in the queue and want opposite responses.
 * Getting this wrong is the tool's most expensive possible mistake: telling
 * someone to reset the attempt counter on a job that failed for a real reason
 * re-runs code that already failed, three times, on purpose.
 */
export function classifyDeadJob(row) {
  if (row.last_error !== null && row.last_error !== undefined) return "failed";
  if (Number(row.sibling_claimable) > 0) return "superseded";
  return "process-death";
}

/**
 * Jobs on their way to the same place. `attempts = max_attempts - 1` means one
 * more worker death is permanent, and there is no warning anywhere else in the
 * stack that a job is one crash from unrecoverable.
 */
export async function atRiskJobs(client, pre, limit) {
  const runId = runIdExpression(pre.columns);
  const { rows } = await client.query(
    `select j.id, j.attempts, j.max_attempts, j.locked_at, j.locked_by, j.run_at,
            ${runId} as run_id
       from ${pre.schema}.${PRIVATE_JOBS} as j
      where j.attempts >= j.max_attempts - 1
        and j.attempts < j.max_attempts
      order by j.attempts desc, j.id
      limit $1`,
    [limit],
  );
  return rows;
}

/**
 * Locks held right now, oldest first.
 *
 * A lock is not itself a fault — a worker doing real work holds one. It matters
 * because of what happens next: graphile's janitor only reclaims a lock after a
 * hardcoded `interval '4 hours'` (there is no `jobExpiry` option in 0.16.6 to
 * tune it down), so a job whose worker died is unclaimable for four hours with
 * no operator action, and the reclaim that finally happens spends an attempt.
 */
export async function lockedJobs(client, pre, limit) {
  const runId = runIdExpression(pre.columns);
  const { rows } = await client.query(
    `select j.id, j.attempts, j.max_attempts, j.locked_at, j.locked_by,
            extract(epoch from (now() - j.locked_at)) * 1000 as locked_for_ms,
            ${runId} as run_id
       from ${pre.schema}.${PRIVATE_JOBS} as j
      where j.locked_at is not null
      order by j.locked_at
      limit $1`,
    [limit],
  );
  return rows;
}

/**
 * Runs that are still pending or running with nothing claimable left. This is
 * the number that actually matters and the one worth reporting upstream — a
 * dead job may be a harmless leftover, but a run with no way forward is the
 * symptom itself.
 *
 * Deliberately not reported as stuck: a pending/running run that still has a
 * claimable job. It is waiting for a worker, not wedged, and flagging those is
 * the easiest way to raise a false alarm.
 */
export async function strandedRuns(client, pre, limit) {
  const avail = availabilityExpression(pre.columns);
  const runId = runIdExpression(pre.columns);
  const { rows } = await client.query(
    `
    with j as (
      select ${avail.sql} as avail, ${runId} as run_id
        from ${pre.schema}.${PRIVATE_JOBS} as j
    )
    select r.id as run_id, r.status, r.name, r.created_at,
           count(j.run_id)::int                        as jobs,
           count(*) filter (where j.avail)::int        as claimable
      from ${pre.workflowSchema}.workflow_runs r
      join j on j.run_id = r.id
     where r.status in ('pending','running')
     group by r.id, r.status, r.name, r.created_at
    having count(*) filter (where j.avail) = 0
     order by r.created_at
     limit $1`,
    [limit],
  );
  return rows;
}

/** The denominator for the stranded count: how many runnable runs are fine. */
export async function runnableRunSummary(client, pre) {
  const avail = availabilityExpression(pre.columns);
  const runId = runIdExpression(pre.columns);
  const { rows } = await client.query(`
    with j as (
      select ${avail.sql} as avail, ${runId} as run_id
        from ${pre.schema}.${PRIVATE_JOBS} as j
    ),
    per_run as (
      select r.id,
             count(j.run_id)::int                  as jobs,
             count(*) filter (where j.avail)::int  as claimable
        from ${pre.workflowSchema}.workflow_runs r
        left join j on j.run_id = r.id
       where r.status in ('pending','running')
       group by r.id
    )
    select count(*)::int                                        as runnable_runs,
           count(*) filter (where claimable > 0)::int           as waiting_on_a_worker,
           count(*) filter (where jobs > 0 and claimable = 0)::int as stranded,
           count(*) filter (where jobs = 0)::int                as no_job_at_all
      from per_run`);
  return rows[0];
}

/**
 * Duplicate work left behind by boot recovery (vercel/workflow#3119).
 *
 * Reported as a ratio and only as a floor: graphile DELETEs a job on success,
 * so every duplicate that actually ran is already gone and cannot be counted.
 * Saying "you have N duplicates" would be a number this query cannot support.
 */
export async function enqueueRatio(client, pre) {
  const runId = runIdExpression(pre.columns);
  const { rows } = await client.query(`
    with j as (
      select ${runId} as run_id from ${pre.schema}.${PRIVATE_JOBS} as j
    )
    select count(*)::int                                as jobs,
           count(distinct run_id)::int                  as distinct_runs,
           count(*) filter (where run_id is null)::int  as undecodable
      from j`);
  const row = rows[0];
  const ratio = row.distinct_runs > 0 ? row.jobs / row.distinct_runs : null;
  return { ...row, ratio };
}

/**
 * Map decoded runIds back to eve's own bookkeeping, so a dead job can be named
 * as the session a human recognises rather than as an integer.
 *
 * `$eve.root` is the session a turn belongs to; eve tags every run with it and
 * world-postgres persists the tags as JSONB, which is the same source of truth
 * the dashboard reads.
 */
export async function describeRuns(client, pre, runIds) {
  if (runIds.length === 0) return new Map();
  const { rows } = await client.query(
    `select id, status, name,
            attributes->>'$eve.root'  as root,
            attributes->>'$eve.type'  as type,
            attributes->>'$eve.title' as title,
            created_at, updated_at
       from ${pre.workflowSchema}.workflow_runs
      where id = any($1::text[])`,
    [runIds],
  );
  return new Map(rows.map((r) => [r.id, r]));
}
