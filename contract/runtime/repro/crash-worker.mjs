#!/usr/bin/env node
/**
 * The victim process for `graphile-crash-wedge.mjs`.
 *
 * Runs a real graphile-worker against a real Postgres, claims one job, prints a
 * line the parent can wait on, and then hangs forever holding the job. The
 * parent SIGKILLs it at that point.
 *
 * The hang is the whole point. We are not simulating a job that *throws* —
 * a throw calls `failJob`, which writes `last_error` and reschedules with
 * backoff, and that path works fine. We are simulating a job that is still
 * running when the process dies: no catch block runs, no `failJob` is issued,
 * and the row is left exactly as `getJob` wrote it at claim time.
 *
 * SIGKILL is uncatchable, so `noHandleSignals` is academic here — it is set
 * only to make it explicit that nothing in this process is trying to clean up.
 */
import { pathToFileURL } from "node:url";

const connectionString = process.argv[2];
const schema = process.argv[3];
// graphile-worker is a transitive dep of @workflow/world-postgres and is not
// resolvable from this directory under pnpm's strict layout, so the parent
// resolves it once and hands us the absolute entry point.
const graphileEntry = process.argv[4];

if (!connectionString || !schema || !graphileEntry) {
  process.stderr.write("usage: crash-worker.mjs <connectionString> <schema> <graphileWorkerEntry>\n");
  process.exit(2);
}

const { run } = await import(pathToFileURL(graphileEntry).href);

await run({
  connectionString,
  schema,
  concurrency: 1,
  // Poll fast: the parent is waiting on wall-clock time, and a 2s default
  // would make the repro feel flaky when it is not.
  pollInterval: 200,
  noHandleSignals: true,
  taskList: {
    crash_task: async (_payload, helpers) => {
      // Tell the parent we hold the job, and report what the row looked like at
      // claim time. `helpers.job.attempts` is post-increment: getJob does
      // `attempts = jobs.attempts + 1` in the same statement that takes the
      // lock, so a job being run for the first time already reads 1.
      process.stdout.write(`CLAIMED id=${helpers.job.id} attempts=${helpers.job.attempts}\n`);
      // Hold it forever. The parent kills us here.
      await new Promise(() => {});
    },
  },
});

// Never reached.
process.stdout.write("WORKER_EXITED\n");
