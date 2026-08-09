#!/usr/bin/env node
/**
 * Repro: a graphile-worker job killed mid-execution becomes PERMANENTLY
 * unclaimable, and clearing the lock — the one remediation everybody reaches
 * for — is what gets it there.
 *
 * Upstream: vercel/eve#535 (p1, open, zero human comments) reports that on
 * `@workflow/world-postgres` a turn interrupted by process death is never
 * resumed: the run stays `running` forever and its graphile job sits pending
 * and unclaimed. The reporter's step 5 is the part nobody has explained:
 *
 *   "Manually clearing the lock (locked_at=NULL, locked_by=NULL), refreshing
 *    run_at=now(), and even pg_notify('jobs:insert','') do NOT get the job
 *    claimed."
 *
 * ── The mechanism ────────────────────────────────────────────────────────────
 *
 * Four facts in the installed tree, each re-verified by this script before it
 * touches the database (see `verifyStaticFacts`):
 *
 *   1. graphile-worker 0.16.6 `_private_jobs` has
 *        is_available boolean generated always as
 *          (((locked_at is null) and (attempts < max_attempts))) stored not null
 *      and `getJob` selects `where jobs.is_available = true`.
 *
 *   2. `getJob` does `attempts = jobs.attempts + 1` in the same statement that
 *      takes the lock. attempts is incremented at CLAIM time, not at failure
 *      time. A job that is claimed and never completes has still spent an
 *      attempt.
 *
 *   3. `resetLockedAt` — the janitor that unsticks abandoned locks — uses a
 *      hardcoded `interval '4 hours'`. There is no `jobExpiry` option in this
 *      version to tune it down.
 *
 *   4. `@workflow/world-postgres` enqueues every message with `maxAttempts: 3`.
 *
 * Put together: process death leaves `attempts` incremented and `locked_at`
 * set, and because the process died rather than failed, `failJob` never runs,
 * so `last_error` stays NULL and there is no forensic trace at all.
 *
 * The lock blocks re-claim for four hours. So the operator clears it by hand.
 * That works — the job runs again, and dies again, and has now spent a second
 * attempt. Clear it again: third attempt. Clear it a third time and
 * `attempts (3) < max_attempts (3)` is false, `is_available` is false forever,
 * and clearing the lock now does exactly nothing. The remediation is the
 * mechanism. Three crash/restart cycles is the budget, and `world-postgres`
 * sets that budget to 3.
 *
 * ── Two routes to the same dead row ──────────────────────────────────────────
 *
 * The three-cycle route above is the one an operator walks by hand, and it is
 * what STEP 4 demonstrates. There is a second, faster route, demonstrated in
 * STEP 8: if a job is re-enqueued under a job key that a currently-held job
 * already owns, graphile *deliberately* retires the old row with
 * `set key = null, attempts = jobs.max_attempts ... where is_available is not
 * true`, and inserts a new one. That reaches the identical end state —
 * attempts = max_attempts, last_error NULL, permanently unavailable — after a
 * single crash.
 *
 * Both routes end at the same row, so the diagnosis does not depend on which
 * one a given report took. What is common to both, and what this script is
 * really pinning down, is that the term of `is_available` which has gone false
 * is `attempts < max_attempts` — not `locked_at is null`. That is why operating
 * on `locked_at` cannot work, no matter how many times it is tried.
 *
 * The reason this is so hard to see from the outside is fact 5, which this
 * script also demonstrates: graphile's public `jobs` VIEW does not expose
 * `is_available`. `select * from graphile_worker.jobs` shows a job with no
 * error, no lock, and a run_at in the past. It looks perfectly healthy. It is
 * dead.
 *
 * ── What this script does ────────────────────────────────────────────────────
 *
 * A pure graphile-worker test. No eve, no model, no cost. It enqueues one job
 * with maxAttempts=3, lets a real worker in a real child process claim it, and
 * SIGKILLs that process mid-execution — a genuine uncatchable process death,
 * not a thrown error. Three times, applying the reporter's exact remediation
 * between each. Then it proves the job is unclaimable by two independent means:
 * graphile's own claim predicate returns zero rows, and a live worker left
 * running does not touch it.
 *
 * Everything happens in a throwaway schema that is dropped on the way out, so
 * it is safe to run repeatedly against a database that has real work in it.
 *
 * Usage:
 *   WORKFLOW_POSTGRES_URL=postgres://... node contract/runtime/repro/graphile-crash-wedge.mjs
 *   ... --keep     leave the schemas behind for manual inspection
 *
 *   REPRO_ALSO_RESET_ATTEMPTS=1 ...
 *     Adds `attempts = 0` to the remediation — the fix that actually works.
 *     The script then goes RED and exits 1, which is the point: it proves these
 *     assertions are load-bearing rather than trivially true.
 *
 * Exit codes: 0 the mechanism reproduced exactly as described above
 *             1 it did not — the hypothesis is wrong, read the output
 *             2 could not run (no database, missing packages)
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");

/**
 * Locate an installed package directory.
 *
 * Two things make this less trivial than `require.resolve(name + "/package.json")`:
 * modern packages restrict their `exports` map and do not export `./package.json`,
 * and under pnpm's strict layout a transitive dependency is not reachable from
 * the repo root at all. So we resolve the package's *entry point* — which the
 * exports map does allow — and walk up until we find the package.json that
 * actually names it.
 *
 * The anchor chain mirrors the real dependency graph, and matches the
 * convention in contract/lib/eve.mjs of reading the package the template will
 * really load rather than a hoisted lookalike:
 *
 *   templates/default  →  @workflow/world-postgres  →  graphile-worker
 *                                                  →  @workflow/world
 */
function packageDirFrom(anchorManifest, name) {
  const require = createRequire(anchorManifest);
  let dir = dirname(require.resolve(name));
  while (dir !== dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const json = JSON.parse(readFileSync(manifest, "utf8"));
      if (json.name === name) return dir;
    }
    dir = dirname(dir);
  }
  throw new Error(`could not locate the package directory for ${name} from ${anchorManifest}`);
}

const TEMPLATE_MANIFEST = join(REPO, "templates", "default", "package.json");
if (!existsSync(TEMPLATE_MANIFEST)) {
  process.stderr.write(`expected ${TEMPLATE_MANIFEST} to exist — run this from an evestack checkout\n`);
  process.exit(2);
}

let WP_DIR;
let GW_DIR;
let WORLD_DIR;
try {
  WP_DIR = packageDirFrom(TEMPLATE_MANIFEST, "@workflow/world-postgres");
  GW_DIR = packageDirFrom(join(WP_DIR, "package.json"), "graphile-worker");
  WORLD_DIR = packageDirFrom(join(WP_DIR, "package.json"), "@workflow/world");
} catch (error) {
  process.stderr.write(
    `${error.message}\n\nRun \`pnpm install\` first — this repro reads the real packages, not mocks.\n`,
  );
  process.exit(2);
}

/** graphile-worker's ESM/CJS entry point, resolved once and reused by the child. */
const GW_ENTRY = createRequire(join(WP_DIR, "package.json")).resolve("graphile-worker");
const requireGraphile = createRequire(join(GW_DIR, "package.json"));

const KEEP = process.argv.includes("--keep");
/** See reporterRemediation: turns this run into a deliberate red run. */
const ALSO_RESET_ATTEMPTS = process.env.REPRO_ALSO_RESET_ATTEMPTS === "1";
const CONNECTION =
  process.env.WORKFLOW_POSTGRES_URL ??
  process.env.DATABASE_URL ??
  "postgres://evestack:evestack@localhost:5433/evestack";

/** Mirrors `maxAttempts: 3` in @workflow/world-postgres/dist/queue.js. */
const MAX_ATTEMPTS = 3;

/* -------------------------------------------------------------------------- */
/* reporting                                                                   */
/* -------------------------------------------------------------------------- */

const checks = [];
let failures = 0;

function ok(passed, detail, extra) {
  checks.push({ passed, detail, extra });
  if (!passed) failures++;
  const mark = passed ? "  ok  " : " FAIL ";
  process.stdout.write(`${mark} ${detail}\n`);
  if (extra) process.stdout.write(`       ${extra}\n`);
}

function note(detail) {
  process.stdout.write(`       ${detail}\n`);
}

function section(title) {
  process.stdout.write(`\n${title} ${"\u2500".repeat(Math.max(0, 77 - title.length))}\n\n`);
}

/** Print rows as an aligned table — this output is the evidence, so it has to
 *  be readable when pasted into an issue comment. */
function table(rows) {
  if (rows.length === 0) {
    process.stdout.write("       (0 rows)\n");
    return;
  }
  const cols = Object.keys(rows[0]);
  const width = Object.fromEntries(
    cols.map((c) => [c, Math.max(c.length, ...rows.map((r) => fmt(r[c]).length))]),
  );
  const line = (cells) => `       ${cols.map((c, i) => cells[i].padEnd(width[c])).join(" | ")}\n`;
  process.stdout.write(line(cols));
  process.stdout.write(`       ${cols.map((c) => "-".repeat(width[c])).join("-+-")}\n`);
  for (const r of rows) process.stdout.write(line(cols.map((c) => fmt(r[c]))));
}

function fmt(v) {
  if (v === null || v === undefined) return "NULL";
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/* -------------------------------------------------------------------------- */
/* step 1 — re-verify the static facts in the installed tree                    */
/* -------------------------------------------------------------------------- */

/**
 * Read the four claims straight out of node_modules rather than trusting a
 * changelog. If a dependency bump changes any of them this script should say so
 * loudly, because the whole argument rests on them.
 */
function verifyStaticFacts() {
  section("STEP 1 — the four facts, re-read from the installed packages");

  const gwDir = GW_DIR;
  const gwVersion = JSON.parse(readFileSync(join(gwDir, "package.json"), "utf8")).version;
  note(`graphile-worker ${gwVersion}`);
  note(`  ${gwDir.replace(`${REPO}/`, "")}`);

  // Fact 1 — the generated column. Migration 000011 creates the modern
  // `_private_jobs` table; note it also *rewrites* the legacy `jobs` table with
  // a weaker one-term definition, so we specifically want the compound one.
  const { migrations } = requireGraphile("./dist/generated/sql.js");
  const isAvailableDefs = [];
  for (const body of Object.values(migrations)) {
    for (const l of body.split("\n")) {
      if (l.includes("is_available boolean generated always as")) isAvailableDefs.push(l.trim());
    }
  }
  const compound = isAvailableDefs.find((d) => d.includes("attempts < max_attempts"));
  ok(
    Boolean(compound),
    "FACT 1  is_available is a stored generated column gated on attempts < max_attempts",
    compound ?? `only found: ${isAvailableDefs.join(" / ")}`,
  );

  // Fact 2 — attempts incremented at claim time.
  const getJobSrc = readFileSync(join(gwDir, "dist/sql/getJob.js"), "utf8");
  ok(
    getJobSrc.includes("attempts = jobs.attempts + 1"),
    "FACT 2  getJob increments attempts in the same statement that takes the lock",
    "attempts = jobs.attempts + 1,   (dist/sql/getJob.js)",
  );
  ok(
    getJobSrc.includes("where jobs.is_available = true"),
    "         ...and getJob only ever considers rows where is_available = true",
    "where jobs.is_available = true   (dist/sql/getJob.js)",
  );

  // Fact 3 — the janitor's hardcoded threshold, and the absence of jobExpiry.
  const resetSrc = readFileSync(join(gwDir, "dist/sql/resetLockedAt.js"), "utf8");
  ok(
    resetSrc.includes("interval '4 hours'"),
    "FACT 3  resetLockedAt reclaims abandoned locks on a hardcoded interval '4 hours'",
    "where locked_at < now() - interval '4 hours'   (dist/sql/resetLockedAt.js)",
  );
  // The janitor is scheduled often but acts rarely: the cadence and the
  // threshold are different numbers, and it is the threshold that strands a
  // crashed job. Worth stating precisely, because "the janitor runs every 8
  // minutes" invites the wrong conclusion.
  const configSrc = readFileSync(join(gwDir, "dist/config.js"), "utf8");
  ok(
    configSrc.includes("minResetLockedInterval: 8 * ") &&
      configSrc.includes("maxResetLockedInterval: 10 * "),
    "         ...and it is scheduled every 8-10 minutes, so the 4h threshold is the binding constraint",
    "a crash-interrupted job is therefore unclaimable for at least 4 hours with no operator action",
  );
  let jobExpiryFound = false;
  try {
    jobExpiryFound = readFileSync(join(gwDir, "dist/interfaces.d.ts"), "utf8").includes("jobExpiry");
  } catch {
    /* ignore */
  }
  ok(
    !jobExpiryFound,
    "         ...and there is no jobExpiry option in this version to tune it down",
  );

  // Fact 4 — world-postgres' attempt budget.
  const wpVersion = JSON.parse(readFileSync(join(WP_DIR, "package.json"), "utf8")).version;
  const queueSrc = readFileSync(join(WP_DIR, "dist/queue.js"), "utf8");
  note(`@workflow/world-postgres ${wpVersion}`);
  note(`  ${WP_DIR.replace(`${REPO}/`, "")}`);
  ok(
    queueSrc.includes(`maxAttempts: ${MAX_ATTEMPTS}`),
    `FACT 4  @workflow/world-postgres ${wpVersion} enqueues every message with maxAttempts: ${MAX_ATTEMPTS}`,
    "maxAttempts: 3,   (dist/queue.js, addGraphileJob)",
  );

  // Fact 5 — the public view hides the column that decides everything.
  const viewMigration = Object.entries(migrations).find(
    ([, b]) => b.includes("create view") && b.includes("_private_jobs"),
  );
  if (viewMigration) {
    const [name, body] = viewMigration;
    const start = body.indexOf("create view");
    const view = body.slice(start, body.indexOf(");", start));
    ok(
      !view.includes("is_available"),
      `FACT 5  the public "jobs" view (${name}) does NOT expose is_available`,
      "so a permanently-dead job is invisible to select * from graphile_worker.jobs",
    );
  }

  return { gwVersion, wpVersion };
}

/* -------------------------------------------------------------------------- */
/* database helpers                                                            */
/* -------------------------------------------------------------------------- */

async function connect() {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: CONNECTION });
  await client.connect();
  return client;
}

/** The full private row — including the column the public view hides. */
async function jobRow(client, schema) {
  const { rows } = await client.query(
    `select id, attempts, max_attempts, is_available, locked_at, locked_by, last_error, run_at
       from ${schema}._private_jobs order by id`,
  );
  return rows;
}

/**
 * graphile's own claim predicate, lifted verbatim from the `j` CTE of
 * dist/sql/getJob.js. If this returns no row, no worker on earth will pick the
 * job up — this is the deterministic form of "is it claimable", as opposed to
 * waiting and hoping.
 */
async function claimable(client, schema) {
  const { rows } = await client.query(
    `select jobs.id
       from ${schema}._private_jobs as jobs
      where jobs.is_available = true
        and run_at <= now()`,
  );
  return rows;
}

/**
 * Exactly what the reporter did in step 5 of the issue.
 *
 * With REPRO_ALSO_RESET_ATTEMPTS=1 it additionally resets `attempts`, which is
 * the remediation that actually works — and running the script that way is the
 * proof that the assertions below are load-bearing rather than vacuous. The
 * final "clearing the lock no longer revives it" check goes RED and the script
 * exits 1, because with attempts reset the job is genuinely revivable.
 *
 * That flag is also the practical workaround worth handing to anyone hitting
 * this: unsticking a job requires clearing `attempts`, not just `locked_at`.
 */
async function reporterRemediation(client, schema) {
  await client.query(
    `update ${schema}._private_jobs
        set locked_at = null, locked_by = null, run_at = now()
            ${ALSO_RESET_ATTEMPTS ? ", attempts = 0" : ""}`,
  );
  await client.query(`select pg_notify('jobs:insert', '')`);
}

/* -------------------------------------------------------------------------- */
/* the crash cycle                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Start a real worker, wait until it has claimed the job and is executing it,
 * then SIGKILL it. Returns what the worker saw at claim time.
 *
 * SIGKILL rather than SIGTERM deliberately: SIGTERM would let graphile release
 * the job gracefully, which is the working path. We need the process to stop
 * existing between the claim and the completion.
 */
function crashAWorkerMidJob(schema, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(HERE, "crash-worker.mjs"), CONNECTION, schema, GW_ENTRY],
      { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`worker never claimed the job within ${timeoutMs}ms. stderr: ${stderr}`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = stdout.match(/CLAIMED id=(\d+) attempts=(\d+)/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        // The handler is now suspended inside the task, holding the job.
        // Kill -9: no catch block, no failJob, no graceful release.
        child.kill("SIGKILL");
        child.on("exit", (code, signal) =>
          resolve({ id: match[1], attemptsAtClaim: Number(match[2]), code, signal }),
        );
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Run a worker for a fixed window and report whether it claimed anything. */
function watchForAClaim(schema, windowMs) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [join(HERE, "crash-worker.mjs"), CONNECTION, schema, GW_ENTRY],
      { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    setTimeout(() => {
      child.kill("SIGKILL");
      resolve(/CLAIMED/.test(stdout));
    }, windowMs);
  });
}

/* -------------------------------------------------------------------------- */
/* main                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  const versions = verifyStaticFacts();

  section("STEP 2 — set up an isolated schema");

  let client;
  try {
    client = await connect();
  } catch (error) {
    process.stderr.write(
      `\ncannot reach Postgres at ${CONNECTION.replace(/:[^:@/]*@/, ":***@")}\n` +
        `${error.message}\n\nSet WORKFLOW_POSTGRES_URL, or start one:\n` +
        `  docker compose up -d postgres\n`,
    );
    process.exit(2);
  }

  const schema = `gw_repro_${randomBytes(5).toString("hex")}`;
  let utils;

  try {
    // Sweep anything a previous aborted run left behind, so this is genuinely
    // safe to run over and over.
    const { rows: stale } = await client.query(
      `select nspname from pg_namespace where nspname like 'gw_repro_%'`,
    );
    for (const { nspname } of stale) {
      await client.query(`drop schema if exists ${nspname} cascade`);
    }
    if (stale.length > 0) note(`swept ${stale.length} schema(s) from a previous run`);

    const { makeWorkerUtils } = await import(pathToFileURL(GW_ENTRY).href);
    utils = await makeWorkerUtils({ connectionString: CONNECTION, schema });
    await utils.migrate();
    note(`graphile-worker ${versions.gwVersion} schema installed at ${schema}`);

    // ── STEP 3: enqueue one job, exactly as world-postgres would ────────────
    section("STEP 3 — enqueue one job with maxAttempts: 3, as world-postgres does");

    await utils.addJob("crash_task", { runId: "wrun_repro" }, { maxAttempts: MAX_ATTEMPTS });
    let rows = await jobRow(client, schema);
    table(rows);
    ok(
      rows.length === 1 && rows[0].attempts === 0 && rows[0].is_available === true,
      "a freshly enqueued job is available with attempts = 0",
    );

    // ── STEP 4: the crash / remediate loop ──────────────────────────────────
    section("STEP 4 — SIGKILL a worker mid-job, then apply the reporter's step-5 remediation");
    note("the remediation is: locked_at=NULL, locked_by=NULL, run_at=now(), pg_notify('jobs:insert','')");

    for (let cycle = 1; cycle <= MAX_ATTEMPTS; cycle++) {
      process.stdout.write(`\n--- crash cycle ${cycle} of ${MAX_ATTEMPTS} ---\n`);

      const crash = await crashAWorkerMidJob(schema);
      note(`worker claimed job ${crash.id} (attempts read ${crash.attemptsAtClaim} at claim time), killed with ${crash.signal}`);

      rows = await jobRow(client, schema);
      table(rows);
      const afterCrash = rows[0];

      ok(
        afterCrash.attempts === cycle,
        `after crash ${cycle}: attempts = ${cycle} — incremented at claim time, by the claim itself`,
      );
      ok(
        afterCrash.last_error === null,
        `after crash ${cycle}: last_error is still NULL — the process died, it did not fail, so failJob never ran`,
      );
      ok(
        afterCrash.locked_at !== null && afterCrash.is_available === false,
        `after crash ${cycle}: the job is still locked by a process that no longer exists, so is_available = false`,
      );

      // Now do what the reporter did.
      await reporterRemediation(client, schema);
      rows = await jobRow(client, schema);
      table(rows);
      const afterFix = rows[0];
      const stillClaimable = await claimable(client, schema);

      if (cycle < MAX_ATTEMPTS) {
        ok(
          afterFix.is_available === true && stillClaimable.length === 1,
          `remediation ${cycle}: clearing the lock DOES revive the job (attempts ${afterFix.attempts} < max ${afterFix.max_attempts})`,
          "this is why the remediation looks like it works — and why an operator repeats it",
        );
      } else {
        ok(
          afterFix.is_available === false && stillClaimable.length === 0,
          `remediation ${cycle}: clearing the lock NO LONGER revives the job — attempts ${afterFix.attempts} = max_attempts ${afterFix.max_attempts}`,
          "locked_at is NULL, run_at is now(), pg_notify fired — and is_available is still false. This is the reporter's step 5.",
        );
      }
    }

    // ── STEP 5: prove it is dead, two independent ways ──────────────────────
    section("STEP 5 — prove the job is permanently unclaimable");

    const finalRows = await jobRow(client, schema);
    table(finalRows);
    const dead = finalRows[0];

    ok(
      dead.locked_at === null && dead.last_error === null && dead.attempts === dead.max_attempts,
      "the wedged row: locked_at NULL, last_error NULL, run_at in the past, attempts = max_attempts",
    );

    const canClaim = await claimable(client, schema);
    ok(
      canClaim.length === 0,
      "graphile's own claim predicate (the `j` CTE from getJob.js) returns 0 rows",
    );

    note("now running a real worker for 6s against this schema to corroborate...");
    const claimedByLiveWorker = await watchForAClaim(schema, 6000);
    ok(
      claimedByLiveWorker === false,
      "a live worker polling every 200ms for 6s does not claim it",
    );

    // ── STEP 5b: rule out the other ways a job can sit unclaimed ────────────
    //
    // "Pending and unclaimed" has more than one possible cause, and attributing
    // it to the wrong one in public would be worse than saying nothing. Two
    // alternatives could produce the identical symptom without is_available
    // being false at all:
    //
    //   (a) the job's task identifier is not in the worker's registered task
    //       list — getJob filters on `task_id = any($2::int[])`, so an
    //       unregistered task is never claimed no matter how available it is;
    //   (b) the job belongs to a named queue whose _private_job_queues row is
    //       locked by a dead worker, which blocks the whole queue.
    //
    // Both are ruled out here rather than waved away.
    section("STEP 5b — ruling out the other causes of 'pending and unclaimed'");

    const wpQueueSrc = readFileSync(join(WP_DIR, "dist/queue.js"), "utf8");
    ok(
      wpQueueSrc.includes("taskList[getJobQueueName()] = createTaskHandler") &&
        wpQueueSrc.includes("utils.addJob(getJobQueueName()"),
      "(a) ruled out: world-postgres enqueues and registers using the SAME getJobQueueName()",
      "so the task identifier always matches a registered handler — this is not a naming mismatch",
    );

    const { rows: queueCheck } = await client.query(
      `select id, job_queue_id from ${schema}._private_jobs`,
    );
    table(queueCheck);
    ok(
      queueCheck.every((r) => r.job_queue_id === null),
      "(b) ruled out: the job has no job_queue_id, so no queue-level lock can be blocking it",
      "world-postgres passes no queueName, so per-queue locking is not in play",
    );
    note("that leaves is_available = false as the only remaining explanation, which is what we measured");

    // ── STEP 6: the 4-hour janitor does not help either ─────────────────────
    section("STEP 6 — does resetLockedAt (the 4-hour janitor) rescue it?");
    note("backdating locked_at by 5 hours so the janitor is guaranteed to act on it");

    await client.query(
      `update ${schema}._private_jobs set locked_at = now() - interval '5 hours', locked_by = 'ghost'`,
    );
    // The statement below is resetLockedAt.js verbatim, schema substituted.
    await client.query(`
      with j as (
        update ${schema}._private_jobs as jobs
        set locked_at = null, locked_by = null, run_at = greatest(run_at, now())
        where locked_at < now() - interval '4 hours'
      )
      update ${schema}._private_job_queues as job_queues
      set locked_at = null, locked_by = null
      where locked_at < now() - interval '4 hours'
    `);
    const afterJanitor = await jobRow(client, schema);
    table(afterJanitor);
    ok(
      afterJanitor[0].is_available === false && (await claimable(client, schema)).length === 0,
      "the janitor clears the lock and the job is STILL unavailable — the second term of is_available is the one that is false",
    );

    // ── STEP 7: what the operator actually sees ─────────────────────────────
    section("STEP 7 — what an operator sees through the public jobs view");

    const { rows: viewCols } = await client.query(
      `select column_name from information_schema.columns
        where table_schema = $1 and table_name = 'jobs' order by ordinal_position`,
      [schema],
    );
    const names = viewCols.map((c) => c.column_name);
    ok(
      !names.includes("is_available"),
      "the public jobs view does not expose is_available",
      `columns: ${names.join(", ")}`,
    );
    const { rows: asSeen } = await client.query(
      `select id, task_identifier, attempts, max_attempts, last_error, locked_at, locked_by, run_at
         from ${schema}.jobs`,
    );
    table(asSeen);
    note("no error, no lock, run_at in the past. It looks like a job that is about to run. It will never run.");

    // ── STEP 8: does add_job with the same key rescue or tombstone? ─────────
    section("STEP 8 — re-enqueueing with the SAME job key while a job is held");
    note("this is what a stable idempotency key does after a crash; observing rather than assuming");

    const schema2 = `${schema}_b`;
    await client.query(`create schema ${schema2}`);
    const utils2 = await makeWorkerUtils({ connectionString: CONNECTION, schema: schema2 });
    await utils2.migrate();
    await utils2.addJob("crash_task", { n: 1 }, { maxAttempts: MAX_ATTEMPTS, jobKey: "stable-key" });
    const crash2 = await crashAWorkerMidJob(schema2);
    note(`worker claimed job ${crash2.id} and was killed`);
    table(await jobRow(client, schema2));

    await utils2.addJob("crash_task", { n: 2 }, { maxAttempts: MAX_ATTEMPTS, jobKey: "stable-key" });
    const afterReenqueue = await jobRow(client, schema2);
    table(afterReenqueue);
    const tombstoned = afterReenqueue.find((r) => r.attempts === r.max_attempts);
    ok(
      afterReenqueue.length === 2 && Boolean(tombstoned),
      "re-enqueueing the same key while the old job is held creates a NEW job and tombstones the old one at attempts = max_attempts",
      "graphile does this deliberately (add_job: `set key = null, attempts = jobs.max_attempts ... where is_available is not true`)",
    );
    await utils2.release();

    // ── STEP 9: reenqueueActiveRuns — flood, and does it rescue? ────────────
    section("STEP 9 — reenqueueActiveRuns: fresh job key per boot");

    const worldVersion = JSON.parse(readFileSync(join(WORLD_DIR, "package.json"), "utf8")).version;
    const recoverySrc = readFileSync(join(WORLD_DIR, "dist/recovery.js"), "utf8");
    const queueSrc = readFileSync(join(WP_DIR, "dist/queue.js"), "utf8");

    ok(
      recoverySrc.includes("await enqueue(queueName, { runId: run.runId })"),
      `@workflow/world ${worldVersion} reenqueueActiveRuns enqueues with NO idempotency key`,
      "enqueue(queueName, { runId: run.runId })  — dist/recovery.js",
    );
    ok(
      queueSrc.includes("jobKey: opts?.idempotencyKey ?? messageId") &&
        queueSrc.includes("MessageId.parse(`msg_${generateMessageId()}`)"),
      "so world-postgres falls back to jobKey = messageId, and messageId is freshly generated per enqueue",
      "jobKey: opts?.idempotencyKey ?? messageId   with   messageId = msg_${generateMessageId()}",
    );
    ok(
      recoverySrc.includes("for (const status of ['pending', 'running'])"),
      "and it does this for EVERY pending and EVERY running run, on every boot",
    );

    // Demonstrate the consequence empirically: fresh keys never collide, so
    // each boot adds rows rather than replacing them.
    const schema3 = `${schema}_c`;
    await client.query(`create schema ${schema3}`);
    const utils3 = await makeWorkerUtils({ connectionString: CONNECTION, schema: schema3 });
    await utils3.migrate();
    for (let boot = 1; boot <= 5; boot++) {
      await utils3.addJob(
        "crash_task",
        { runId: "wrun_same" },
        { maxAttempts: MAX_ATTEMPTS, jobKey: `msg_${randomBytes(8).toString("hex")}` },
      );
    }
    const { rows: flood } = await client.query(
      `select count(*)::int as jobs_for_one_run from ${schema3}._private_jobs`,
    );
    table(flood);
    ok(
      flood[0].jobs_for_one_run === 5,
      "5 simulated boots of ONE runnable run produce 5 distinct jobs — fresh keys never dedupe",
      "this is the mechanism behind vercel/workflow#3119 (521 jobs for 20 runnable runs)",
    );
    await utils3.release();

    // ── STEP 10: does boot recovery actually rescue the wedged RUN? ─────────
    //
    // This is the part it would be easy to get wrong, and getting it wrong in
    // public would be bad. The wedged JOB is dead — that is settled above. But
    // reenqueueActiveRuns does not try to revive that row; it enqueues a fresh
    // one for the same runId under a brand-new key. A fresh row starts at
    // attempts = 0, so it should be perfectly claimable. Test it rather than
    // assume it: enqueue a fresh-key job into the schema that holds the wedged
    // job, and see whether a worker picks it up.
    section("STEP 10 — does boot recovery rescue the RUN, even though the job stays dead?");

    await utils.addJob(
      "crash_task",
      { runId: "wrun_repro" },
      { maxAttempts: MAX_ATTEMPTS, jobKey: `msg_${randomBytes(8).toString("hex")}` },
    );
    const bothRows = await jobRow(client, schema);
    table(bothRows);
    ok(
      bothRows.length === 2 && bothRows.some((r) => r.is_available === true),
      "boot recovery's fresh-key enqueue lands a NEW, claimable job alongside the dead one",
    );

    const rescued = await watchForAClaim(schema, 6000);
    ok(
      rescued === true,
      "a worker DOES claim the new job — so restarting the world does give the run a way forward",
      "the wedged row is still dead; recovery routes around it rather than fixing it",
    );

    note("");
    note("So, precisely: reenqueueActiveRuns does NOT revive the wedged job — nothing does —");
    note("but it does create a fresh claimable job for the same run on every boot. The run is");
    note("therefore only permanently stuck while the world is NOT restarted. The cost of that");
    note("recovery is the flooding above: a new row per run per boot, forever.");

    // ── STEP 11: control — is it the crashing, or the attempt budget? ───────
    //
    // Without this the repro proves too little: "SIGKILL a worker three times
    // and the job dies" is consistent with crashes being inherently fatal. Run
    // the identical crash loop against graphile's DEFAULT maxAttempts of 25 and
    // the job survives all three, which isolates `maxAttempts: 3` — a
    // world-postgres choice, not a graphile default — as the necessary
    // condition. It also shows the attempt budget is being spent on crashes
    // that were never retries in any meaningful sense.
    section("STEP 11 — control: the same three crashes at graphile's DEFAULT maxAttempts (25)");

    const schema4 = `${schema}_d`;
    await client.query(`create schema ${schema4}`);
    const utils4 = await makeWorkerUtils({ connectionString: CONNECTION, schema: schema4 });
    await utils4.migrate();
    await utils4.addJob("crash_task", { runId: "wrun_control" }, { maxAttempts: 25 });

    for (let cycle = 1; cycle <= MAX_ATTEMPTS; cycle++) {
      await crashAWorkerMidJob(schema4);
      await reporterRemediation(client, schema4);
    }
    const controlRows = await jobRow(client, schema4);
    table(controlRows);
    ok(
      controlRows[0].attempts === MAX_ATTEMPTS &&
        controlRows[0].is_available === true &&
        (await claimable(client, schema4)).length === 1,
      "after the identical three crashes, a maxAttempts=25 job is still available and claimable",
      "same crashes, same remediation, different outcome — the budget is the variable, not the crash",
    );
    await utils4.release();

    // ── verdict ─────────────────────────────────────────────────────────────
    section("VERDICT");
    if (failures === 0) {
      process.stdout.write(
        "REPRODUCED.\n\n" +
          "  Crash/restart cycles exhaust maxAttempts=3 at CLAIM time, because getJob\n" +
          "  increments attempts in the statement that takes the lock. is_available then\n" +
          "  becomes permanently false, and clearing locked_at cannot revive the job: the\n" +
          "  term that has gone false is `attempts < max_attempts`, not `locked_at is null`.\n" +
          "  That is exactly the reporter's step 5 in vercel/eve#535.\n\n" +
          "  last_error stays NULL throughout, because the process died rather than failed\n" +
          "  and failJob never ran — so there is no forensic trace. And graphile's public\n" +
          "  `jobs` view does not expose is_available, so the dead row reads as healthy.\n\n" +
          "  Two routes reach this state: three manual clear-and-retry cycles (STEP 4), and\n" +
          "  a single crash followed by a same-key re-enqueue, which graphile deliberately\n" +
          "  tombstones at attempts = max_attempts (STEP 8).\n\n" +
          "  NOT claimed: that boot recovery leaves the RUN stuck. STEP 10 shows the\n" +
          "  opposite — reenqueueActiveRuns creates a fresh-key job that a worker does\n" +
          "  claim. It routes around the dead row rather than repairing it, and pays for\n" +
          "  that with a new row per run per boot (STEP 9).\n",
      );
    } else {
      process.stdout.write(
        `NOT REPRODUCED AS DESCRIBED — ${failures} check(s) failed. Read the output above\n` +
          "before publishing anything. The hypothesis may be wrong.\n",
      );
    }
  } finally {
    if (utils) await utils.release().catch(() => {});
    if (client) {
      if (!KEEP) {
        for (const s of [schema, `${schema}_b`, `${schema}_c`, `${schema}_d`]) {
          await client.query(`drop schema if exists ${s} cascade`).catch(() => {});
        }
        process.stdout.write(`\ncleaned up ${schema}, ${schema}_b, ${schema}_c, ${schema}_d\n`);
      } else {
        process.stdout.write(`\n--keep: left ${schema}, ${schema}_b, ${schema}_c, ${schema}_d in place\n`);
      }
      await client.end().catch(() => {});
    }
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`\nrepro crashed: ${error?.stack ?? error}\n`);
  process.exit(2);
});
