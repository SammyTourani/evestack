#!/usr/bin/env node
/**
 * A job that is BOTH dead AND blocking a live run.
 *
 * WHY THIS EXISTS
 *
 * `evestack doctor` prints remediation SQL in exactly one situation, and it is
 * deliberately narrow (see packages/evestack-cli/src/remediate.mjs):
 *
 *     a job classified `process-death`  AND  belonging to a run that is still
 *     pending/running  AND  with no claimable sibling job for that run.
 *
 * Every other dead job is a leftover, a duplicate, or an honest failure, and
 * reviving any of those is worse than doing nothing. That narrowness is right,
 * and it is why the "prints the SQL" half of the doctor claim had never once
 * been executed. The cape-town stranger test tried: it killed an agent
 * mid-turn, got a genuinely stranded run, and `doctor --sql` still printed
 * "Nothing to remediate: no job is both dead and blocking a live run", because
 * boot recovery had already enqueued a fresh claimable job and routed around
 * the dead one. Reaching this state by hand against a live agent is a race you
 * lose.
 *
 * So this file constructs it deterministically, in throwaway schemas, and
 * hands back the two schema names to point `doctor --schema/--workflow` at.
 *
 * WHAT IS REAL HERE AND WHAT IS STAGED
 *
 * Real: the graphile schema (installed by the graphile-worker `migrate()`, so
 * `is_available` is the real generated column and not a re-declaration of it);
 * the job row (inserted by `addJob`); the three attempts (spent by `getJob`,
 * at claim time); the process deaths (three real SIGKILLs of a real worker
 * holding the job, see repro/crash-worker.mjs); and the `workflow_runs` table,
 * cloned with `LIKE workflow.workflow_runs INCLUDING ALL` when a real one is
 * present, so the column types are the ones eve uses, not the ones this file invents.
 *
 * Staged: only the association. The payload carries a base64 body naming a run
 * id, which is how @workflow/world-postgres stores it and the only way doctor
 * can tie a job to a run: there is no foreign key to use instead.
 *
 * Nothing here fakes the wedge itself. `attempts` is never written by this
 * file; it reaches `max_attempts` the way the bug does it, one claim at a
 * time, with the locked_at-clearing remediation from the upstream report in
 * between. The mechanism is proved at length in repro/graphile-crash-wedge.mjs
 * (36 assertions); this is the smallest thing that puts a diagnostic tool in
 * front of the end state.
 *
 * USE
 *
 *   import { createWedgedJob } from "../fixtures/wedged-job.mjs";
 *   const wedge = await createWedgedJob();
 *   //  wedge.graphileSchema, wedge.workflowSchema, wedge.jobId, wedge.runId
 *   await wedge.drop();
 *
 * As a command, for working on `doctor` by hand:
 *
 *   node contract/runtime/fixtures/wedged-job.mjs          build, print, drop
 *   node contract/runtime/fixtures/wedged-job.mjs --keep    build and leave it
 *   node contract/runtime/fixtures/wedged-job.mjs --drop    sweep leftovers
 *   ... --completed-run   negative control: dead job, run already finished
 *   ... --sibling         negative control: a live job exists for the same run
 *
 * Exit codes: 0 built and verified, 1 built but not in the state doctor needs,
 * 2 could not build it at all.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");

/** Schemas this fixture owns. Anything matching is fair game to sweep. */
export const SCHEMA_PREFIX = "wedge_fx_";

/** Mirrors `maxAttempts: 3` in @workflow/world-postgres/dist/queue.js. */
export const MAX_ATTEMPTS = 3;

export function connectionString() {
  return (
    process.env.WORKFLOW_POSTGRES_URL ??
    process.env.DATABASE_URL ??
    "postgres://evestack:evestack@localhost:5433/evestack"
  );
}

/**
 * Locate an installed package directory. Same shape as
 * repro/graphile-crash-wedge.mjs: modern packages do not export
 * `./package.json`, and under pnpm a transitive dependency is not reachable
 * from the repo root, so resolve the entry point and walk up to the manifest
 * that actually names the package.
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

/**
 * The graphile-worker entry point, resolved through the same chain the
 * template really loads it by. Returns null rather than throwing, so a probe
 * `available()` can report the reason instead of crashing the runner.
 */
export function graphileEntry() {
  const templateManifest = join(REPO, "templates", "default", "package.json");
  if (!existsSync(templateManifest)) return null;
  try {
    const wp = packageDirFrom(templateManifest, "@workflow/world-postgres");
    return createRequire(join(wp, "package.json")).resolve("graphile-worker");
  } catch {
    return null;
  }
}

async function connect(url) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  // Without this a dead socket becomes an uncaughtException, which in a probe
  // runner kills the process and takes every other probe result with it. Same
  // reasoning as probes/04-schedule-duration.probe.mjs.
  client.on("error", () => {});
  return client;
}

/**
 * Start a real worker, wait until it has claimed the job, SIGKILL it.
 *
 * SIGKILL, not SIGTERM: SIGTERM lets graphile release the job cleanly, which
 * is the path that works. We need the process to stop existing between the
 * claim and the completion, so `failJob` never runs and `last_error` stays
 * NULL. That NULL is what separates process death from an honest failure, and
 * it is the field the doctor classifier keys on.
 */
function crashAWorkerMidJob({ url, schema, entry, timeoutMs = 30_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(HERE, "..", "repro", "crash-worker.mjs"), url, schema, entry],
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
        child.kill("SIGKILL");
        child.on("exit", () => resolve({ id: match[1], attemptsAtClaim: Number(match[2]) }));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * The remediation the vercel/eve#535 reporter tried, and the one every
 * operator reaches for. It works twice and then stops working, which is the
 * whole finding: so it is also, unmodified, the honest way to spend three
 * attempts.
 */
async function clearTheLock(client, schema) {
  await client.query(
    `update ${schema}._private_jobs set locked_at = null, locked_by = null, run_at = now()`,
  );
}

/**
 * How @workflow/world-postgres stores the workflow body: base64 JSON under
 * `payload.data`. doctor cannot join a job to a run, so it decodes this, and
 * it only decodes strings that look like base64 (see `runIdExpression` in
 * packages/evestack-cli/src/queue.mjs). Standard base64 with padding and no
 * line breaks satisfies that predicate.
 */
export function encodeRunPayload(runId) {
  const body = JSON.stringify({ runId, messageId: `msg_${randomBytes(8).toString("hex")}` });
  return { data: Buffer.from(body, "utf8").toString("base64") };
}

/**
 * @param {object} [options]
 * @param {string} [options.url]         Postgres connection string.
 * @param {"running"|"pending"|"completed"} [options.runStatus]
 *        The status of the run. `completed` builds a NEGATIVE control: the
 *        same dead job, belonging to a run that no longer needs it, which
 *        doctor must call a leftover and print nothing for.
 * @param {boolean} [options.withClaimableSibling]
 *        Enqueue a second, live job for the same run. That is what an agent
 *        restart leaves behind, it is why the stranger test could not reach
 *        this path, and doctor must classify the dead row `superseded` and
 *        print nothing for it. The other negative control.
 */
export async function createWedgedJob(options = {}) {
  const url = options.url ?? connectionString();
  const runStatus = options.runStatus ?? "running";
  const withClaimableSibling = options.withClaimableSibling ?? false;

  const entry = graphileEntry();
  if (entry === null) {
    throw new Error(
      "could not resolve graphile-worker through templates/default: run `pnpm install` first. " +
        "This fixture installs the real graphile schema rather than a lookalike.",
    );
  }

  const suffix = randomBytes(5).toString("hex");
  const graphileSchema = `${SCHEMA_PREFIX}gw_${suffix}`;
  const workflowSchema = `${SCHEMA_PREFIX}wf_${suffix}`;
  const runId = `wrun_fx${suffix.toUpperCase()}`;

  const client = await connect(url);
  let utils = null;

  const drop = async () => {
    const c = await connect(url).catch(() => null);
    if (c === null) return;
    await c.query(`drop schema if exists ${graphileSchema} cascade`).catch(() => {});
    await c.query(`drop schema if exists ${workflowSchema} cascade`).catch(() => {});
    await c.end().catch(() => {});
  };

  try {
    const { makeWorkerUtils } = await import(pathToFileURL(entry).href);
    utils = await makeWorkerUtils({ connectionString: url, schema: graphileSchema });
    await utils.migrate();

    /* -- the run ---------------------------------------------------------- */

    await client.query(`create schema ${workflowSchema}`);
    // Clone the real table when one is present, so the fixture cannot pass on
    // a column type it invented for itself. Which shape was used is reported;
    // a hand-rolled table that quietly differed from production is exactly the
    // failure contract/README.md warns about under "Adding one".
    const { rows: real } = await client.query(
      `select count(*)::int as n from information_schema.tables
        where table_schema = 'workflow' and table_name = 'workflow_runs'`,
    );
    const clonedFromReal = real[0].n > 0;
    const attributes = JSON.stringify({ "$eve.root": `${runId}_root`, "$eve.type": "turn" });

    if (clonedFromReal) {
      await client.query(
        `create table ${workflowSchema}.workflow_runs
           (like workflow.workflow_runs including all)`,
      );
      await client.query(
        `insert into ${workflowSchema}.workflow_runs
           (id, deployment_id, status, name, attributes, created_at, updated_at, started_at)
         values ($1, 'fixture', $2::workflow.status, 'fixture.turn', $3::jsonb,
                 now() - interval '20 minutes', now() - interval '20 minutes',
                 now() - interval '20 minutes')`,
        [runId, runStatus, attributes],
      );
    } else {
      await client.query(`
        create table ${workflowSchema}.workflow_runs (
          id            varchar     primary key,
          deployment_id varchar     not null,
          status        varchar     not null,
          name          varchar     not null,
          attributes    jsonb       not null default '{}'::jsonb,
          created_at    timestamp   not null default now(),
          updated_at    timestamp   not null default now(),
          started_at    timestamp,
          completed_at  timestamp
        )`);
      await client.query(
        `insert into ${workflowSchema}.workflow_runs
           (id, deployment_id, status, name, attributes, created_at, updated_at, started_at)
         values ($1, 'fixture', $2, 'fixture.turn', $3::jsonb,
                 now() - interval '20 minutes', now() - interval '20 minutes',
                 now() - interval '20 minutes')`,
        [runId, runStatus, attributes],
      );
    }

    /* -- the job ---------------------------------------------------------- */

    await utils.addJob("crash_task", encodeRunPayload(runId), { maxAttempts: MAX_ATTEMPTS });

    // Three real process deaths. The lock is cleared between them exactly as
    // the upstream reporter did it: that is what lets the next worker claim
    // the job, and claiming is what spends the attempt.
    const claims = [];
    for (let cycle = 0; cycle < MAX_ATTEMPTS; cycle++) {
      claims.push(await crashAWorkerMidJob({ url, schema: graphileSchema, entry }));
      await clearTheLock(client, graphileSchema);
    }

    // The sibling goes in AFTER the wedge, so it cannot be claimed during the
    // crash cycles and steal one of the three attempts.
    if (withClaimableSibling) {
      await utils.addJob("crash_task", encodeRunPayload(runId), { maxAttempts: MAX_ATTEMPTS });
    }

    /* -- what was actually built ------------------------------------------ */

    // Read the graphile generated column rather than recomputing the
    // predicate here. A fixture that asserts its own arithmetic proves nothing
    // about the database it is meant to be describing.
    const { rows: jobs } = await client.query(
      `select id, attempts, max_attempts, is_available, locked_at, last_error, key,
              payload->>'data' as payload_data
         from ${graphileSchema}._private_jobs
        order by id`,
    );
    const dead = jobs.filter((j) => j.is_available === false);
    const live = jobs.filter((j) => j.is_available === true);

    // The graphile claim predicate, lifted from the `j` CTE of getJob.js. If
    // this excludes the row, no worker anywhere will take it.
    const { rows: claimable } = await client.query(
      `select id from ${graphileSchema}._private_jobs
        where is_available = true and run_at <= now()`,
    );

    return {
      graphileSchema,
      workflowSchema,
      runId,
      runStatus,
      clonedFromReal,
      jobId: dead[0]?.id ?? null,
      siblingJobId: live[0]?.id ?? null,
      jobs,
      claimableIds: claimable.map((r) => r.id),
      attemptsAtEachClaim: claims.map((c) => c.attemptsAtClaim),
      /** The exact arguments a human should run against what was just built. */
      doctorArgs: [
        "doctor",
        `--schema=${graphileSchema}`,
        `--workflow=${workflowSchema}`,
        `--url=${url}`,
        // Session probing talks HTTP to an agent that knows nothing about
        // these schemas. Off, so the fixture describes the queue and only the
        // queue.
        "--probes=0",
      ],
      drop,
    };
  } catch (error) {
    await drop();
    throw error;
  } finally {
    if (utils) await utils.release().catch(() => {});
    await client.end().catch(() => {});
  }
}

/** Remove anything a previous aborted run left behind. Returns how many. */
export async function sweep(url = connectionString()) {
  const client = await connect(url);
  try {
    const { rows } = await client.query(`select nspname from pg_namespace where nspname like $1`, [
      `${SCHEMA_PREFIX}%`,
    ]);
    for (const { nspname } of rows) {
      await client.query(`drop schema if exists ${nspname} cascade`);
    }
    return rows.length;
  } finally {
    await client.end().catch(() => {});
  }
}

/* -------------------------------------------------------------------------- */
/* cli                                                                         */
/* -------------------------------------------------------------------------- */

async function cli() {
  const argv = process.argv.slice(2);
  const url = connectionString();
  const write = (s) => process.stdout.write(s);

  if (argv.includes("--drop")) {
    const n = await sweep(url);
    write(`swept ${n} fixture schema(s)\n`);
    return 0;
  }

  const keep = argv.includes("--keep");
  const swept = await sweep(url);
  if (swept > 0) write(`swept ${swept} schema(s) from a previous run\n`);

  const wedge = await createWedgedJob({
    url,
    runStatus: argv.includes("--completed-run") ? "completed" : "running",
    withClaimableSibling: argv.includes("--sibling"),
  });

  const shape = wedge.clonedFromReal
    ? "cloned from the real workflow.workflow_runs"
    : "MINIMAL: no real workflow.workflow_runs to clone";
  write(`\ngraphile schema   ${wedge.graphileSchema}\n`);
  write(`workflow schema   ${wedge.workflowSchema}   (${shape})\n`);
  write(`run               ${wedge.runId}  status=${wedge.runStatus}\n`);
  write(`attempts at claim ${wedge.attemptsAtEachClaim.join(", ")}  (one spent per CLAIM)\n`);
  write("\njobs\n");
  for (const j of wedge.jobs) {
    write(
      `  id=${j.id} attempts=${j.attempts}/${j.max_attempts} is_available=${j.is_available} ` +
        `locked_at=${j.locked_at === null ? "NULL" : j.locked_at.toISOString()} ` +
        `last_error=${j.last_error === null ? "NULL" : "set"} ` +
        `key=${j.key === null ? "NULL" : "set"}\n`,
    );
  }
  const claimable = wedge.claimableIds.length === 0 ? "(none)" : wedge.claimableIds.join(", ");
  write(`claimable now     ${claimable}\n`);

  const wedged =
    wedge.jobId !== null &&
    wedge.claimableIds.length === 0 &&
    wedge.jobs.some((j) => j.last_error === null && Number(j.attempts) >= Number(j.max_attempts));

  const flags = wedge.doctorArgs.slice(1).join(" ");
  write("\nrun doctor against it:\n");
  write(`  node packages/evestack-cli/bin/evestack.mjs doctor ${flags} --sql\n`);
  write(`  node packages/evestack-cli/bin/evestack.mjs doctor ${flags}\n`);

  if (keep) {
    write("\n--keep: left both schemas in place. Remove them with:\n");
    write("  node contract/runtime/fixtures/wedged-job.mjs --drop\n");
  } else {
    await wedge.drop();
    write("\ndropped both schemas (--keep to leave them)\n");
  }

  if (!wedged) {
    process.stderr.write("\nthe fixture did NOT reach the state doctor needs: see the rows above\n");
    return 1;
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  cli().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`\ncould not build the fixture: ${error?.stack ?? error}\n`);
      process.exitCode = 2;
    },
  );
}
