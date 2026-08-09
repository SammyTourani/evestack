#!/usr/bin/env node
/**
 * Read-only forensic scan for the vercel/eve#535 signature in a real database.
 *
 * `graphile-crash-wedge.mjs` proves the mechanism in a throwaway schema. This
 * asks the different and more important question: **is it happening to you?**
 *
 * The signature of a permanently-dead graphile job is:
 *
 *   attempts >= max_attempts   →  is_available is false, forever
 *   locked_at is null          →  nothing to "unstick"; it looks idle
 *   last_error is null         →  no failJob ran, so process death, not failure
 *
 * The first two are what make it unclaimable. The third is what makes it
 * *invisible*: a job that exhausted its attempts through real failures has a
 * `last_error` you can find, whereas a job whose worker was killed mid-flight
 * has nothing at all. And graphile's public `jobs` view does not expose
 * `is_available`, so neither kind shows up as unhealthy in the obvious query.
 *
 * The report separates two things that are easy to conflate, and the
 * distinction decides whether you actually have a problem:
 *
 *   - a DEAD JOB, which may be a harmless leftover from a run that completed
 *     by some other path;
 *   - a STRANDED RUN — a run still marked pending/running whose every job is
 *     unavailable. That is the actual #535 symptom, and it is the number to
 *     report upstream.
 *
 * This script only ever SELECTs. It is safe to point at production.
 *
 * Usage:
 *   WORKFLOW_POSTGRES_URL=postgres://... node contract/runtime/repro/scan-wedged-jobs.mjs
 *   ... --schema=graphile_worker   graphile's schema (default: graphile_worker)
 *   ... --workflow=workflow        the workflow schema (default: workflow)
 *
 * Exit codes: 0 no stranded runs found
 *             1 at least one run is stranded behind an unavailable job
 *             2 could not run (no database, schema not present)
 */
const args = process.argv.slice(2);
const CONNECTION =
  process.env.WORKFLOW_POSTGRES_URL ??
  process.env.DATABASE_URL ??
  "postgres://evestack:evestack@localhost:5433/evestack";
const GW = args.find((a) => a.startsWith("--schema="))?.slice(9) ?? "graphile_worker";
const WF = args.find((a) => a.startsWith("--workflow="))?.slice(11) ?? "workflow";

const note = (d) => process.stdout.write(`       ${d}\n`);
const section = (t) => process.stdout.write(`\n${t} ${"\u2500".repeat(Math.max(0, 77 - t.length))}\n\n`);

function fmt(v) {
  if (v === null || v === undefined) return "NULL";
  if (v instanceof Date) return v.toISOString().replace("T", " ").slice(0, 19);
  return String(v);
}

function table(rows) {
  if (rows.length === 0) return void process.stdout.write("       (none)\n");
  const cols = Object.keys(rows[0]);
  const w = Object.fromEntries(
    cols.map((c) => [c, Math.max(c.length, ...rows.map((r) => fmt(r[c]).length))]),
  );
  const line = (cells) => `       ${cols.map((c, i) => cells[i].padEnd(w[c])).join(" | ")}\n`;
  process.stdout.write(line(cols));
  process.stdout.write(`       ${cols.map((c) => "-".repeat(w[c])).join("-+-")}\n`);
  for (const r of rows) process.stdout.write(line(cols.map((c) => fmt(r[c]))));
}

/**
 * world-postgres stores the workflow body base64-encoded inside the graphile
 * payload, so the runId a job belongs to has to be dug out rather than joined.
 */
const RUN_ID = `convert_from(decode(payload->>'data','base64'),'UTF8')::json->>'runId'`;

async function main() {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: CONNECTION });
  try {
    await client.connect();
  } catch (error) {
    process.stderr.write(`cannot reach Postgres: ${error.message}\n`);
    process.exit(2);
  }

  try {
    const { rows: present } = await client.query(
      `select
         (select count(*) from information_schema.tables
           where table_schema = $1 and table_name = '_private_jobs') as gw,
         (select count(*) from information_schema.tables
           where table_schema = $2 and table_name = 'workflow_runs') as wf`,
      [GW, WF],
    );
    if (Number(present[0].gw) === 0) {
      process.stderr.write(`no ${GW}._private_jobs table — is --schema right?\n`);
      process.exit(2);
    }
    const haveWorkflow = Number(present[0].wf) > 0;

    section("QUEUE HEALTH");
    const { rows: health } = await client.query(`
      select count(*) as jobs,
             count(*) filter (where is_available) as available,
             count(*) filter (where not is_available) as unavailable,
             count(*) filter (where locked_at is not null) as locked,
             count(*) filter (where attempts >= max_attempts) as attempts_exhausted
        from ${GW}._private_jobs`);
    table(health);

    section("DEAD JOBS — attempts exhausted, can never be claimed again");
    const { rows: dead } = await client.query(`
      select id, attempts, max_attempts, locked_at,
             case when last_error is null
                  then 'NULL  <- process death: failJob never ran'
                  else left(last_error, 40) end as last_error,
             case when key is null
                  then 'cleared  <- tombstoned by a same-key re-enqueue'
                  else 'set' end as job_key,
             created_at
        from ${GW}._private_jobs
       where attempts >= max_attempts
       order by id`);
    table(dead);
    if (dead.length > 0) {
      note("");
      note("last_error NULL means no failJob ran — the worker was killed mid-execution.");
      note("Those are the ones #535 is about; a real error means it failed the honest way.");
    }

    if (!haveWorkflow) {
      section("VERDICT");
      note(`no ${WF}.workflow_runs table, so stranded runs cannot be assessed`);
      note("dead jobs above are reported without knowing whether they stranded anything");
      await client.end();
      process.exit(0);
    }

    // The number that actually matters. A dead job is only a problem if the run
    // behind it has no other way forward.
    section("STRANDED RUNS — still pending/running, with no claimable job left");
    const { rows: stranded } = await client.query(`
      with j as (
        select is_available, ${RUN_ID} as run_id from ${GW}._private_jobs
      )
      select r.id as run_id, r.status, r.name,
             count(j.run_id) as jobs,
             count(*) filter (where j.is_available) as claimable,
             r.created_at
        from ${WF}.workflow_runs r
        join j on j.run_id = r.id
       where r.status in ('pending','running')
       group by r.id, r.status, r.name, r.created_at
      having count(*) filter (where j.is_available) = 0
       order by r.created_at`);
    table(stranded);

    // Context: runs that are pending/running but still have a claimable job are
    // fine — they are waiting on a worker, not wedged. Reporting those as stuck
    // is the easiest way to raise a false alarm.
    const { rows: summary } = await client.query(`
      with j as (
        select is_available, ${RUN_ID} as run_id from ${GW}._private_jobs
      ),
      per_run as (
        select r.id, count(j.run_id) as jobs,
               count(*) filter (where j.is_available) as claimable
          from ${WF}.workflow_runs r
          left join j on j.run_id = r.id
         where r.status in ('pending','running')
         group by r.id
      )
      select count(*) as runnable_runs,
             count(*) filter (where claimable > 0) as waiting_on_a_worker,
             count(*) filter (where jobs > 0 and claimable = 0) as stranded,
             count(*) filter (where jobs = 0) as no_job_at_all
        from per_run`);
    section("SUMMARY");
    table(summary);

    // Flooding, per vercel/workflow#3119. Only meaningful as a ratio, and only
    // loosely: graphile DELETES jobs on success, so duplicates that ran are
    // already gone and this undercounts what boot recovery actually created.
    const { rows: flood } = await client.query(`
      select count(*) as jobs,
             count(distinct ${RUN_ID}) as distinct_runs,
             round(count(*)::numeric / nullif(count(distinct ${RUN_ID}),0), 2) as jobs_per_run,
             count(*) filter (where payload->>'idempotencyKey' is null) as no_idempotency_key
        from ${GW}._private_jobs`);
    table(flood);
    note("");
    note("no_idempotency_key counts jobs enqueued without a stable key — the signature of");
    note("reenqueueActiveRuns, which uses a fresh messageId per boot (vercel/workflow#3119).");
    note("Treat jobs_per_run as a floor: graphile deletes jobs on success, so duplicates");
    note("that completed are no longer here to be counted.");

    section("VERDICT");
    if (stranded.length > 0) {
      process.stdout.write(
        `${stranded.length} run(s) are stranded behind jobs that can never be claimed.\n` +
          "This is the vercel/eve#535 symptom. Clearing locked_at will NOT help; the\n" +
          "unavailability comes from attempts >= max_attempts. Reset attempts instead.\n",
      );
    } else {
      process.stdout.write(
        "No stranded runs. Any dead jobs listed above are leftovers whose runs found\n" +
          "another way forward — worth knowing, but not currently costing you a run.\n",
      );
    }
    await client.end();
    process.exit(stranded.length > 0 ? 1 : 0);
  } catch (error) {
    process.stderr.write(`\nscan failed: ${error?.stack ?? error}\n`);
    await client.end().catch(() => {});
    process.exit(2);
  }
}

main();
