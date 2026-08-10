/**
 * `evestack doctor --sql` has to actually print SQL, and that SQL has to work.
 *
 * README and `doctor --help` both promise: read-only forensics, and "when
 * there is something to fix it prints the SQL". The read-only half is easy to
 * verify. The printing half had never once run. A healthy stack has nothing to
 * print, so printing nothing is correct there, and the state that makes it
 * print is genuinely hard to reach by hand: the cape-town stranger test killed
 * an agent mid-turn, produced a real stranded run, and still got
 *
 *     Nothing to remediate: no job is both dead and blocking a live run.
 *
 * because boot recovery had already enqueued a fresh claimable job and routed
 * around the dead row. So the claim sat unexercised, in the one command a
 * stranger reaches for when everything else has failed them.
 *
 * contract/runtime/fixtures/wedged-job.mjs builds the state deterministically
 * with three real SIGKILLs. This probe drives the command against it and then
 * does the thing that separates "it printed something" from "it printed a
 * remediation": it RUNS the SQL and requires the queue to be fixed afterwards,
 * judged by the graphile generated column and the graphile claim predicate,
 * not by re-reading the tool own report.
 *
 * Both negative controls matter as much as the positive one, because both are
 * states doctor must stay quiet about and both are far more common than the
 * one it speaks for:
 *
 *   - a dead job whose run already finished: a leftover, nothing to fix;
 *   - a dead job with a live sibling job for the same run: reviving it would
 *     execute the same turn twice. This is the exact state the stranger test
 *     hit, so a probe that only tested the happy path would have called the
 *     stranger observation a bug.
 *
 * Everything happens in throwaway schemas. Nothing in `workflow` or
 * `graphile_worker` is read or written.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWedgedJob, graphileEntry, sweep } from "../fixtures/wedged-job.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const CLI = join(REPO, "packages", "evestack-cli", "bin", "evestack.mjs");

/** The sentence the command prints when it has nothing to say. */
const NOTHING = "Nothing to remediate";

async function connect() {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.WORKFLOW_POSTGRES_URL });
  await client.connect();
  client.on("error", () => {});
  return client;
}

/** Run the real bin, not an imported function: `--sql` is a CLI contract. */
function doctor(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: REPO,
      stdio: ["ignore", "pipe", "pipe"],
      // Deliberately empty of WORKFLOW_POSTGRES_URL: every invocation below
      // passes --url, so a probe cannot pass by accidentally inheriting a
      // connection the command was supposed to resolve for itself.
      env: { ...process.env, WORKFLOW_POSTGRES_URL: "", DATABASE_URL: "" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** graphile own claim predicate, from the `j` CTE of dist/sql/getJob.js. */
async function claimableIds(client, schema) {
  const { rows } = await client.query(
    `select id from ${schema}._private_jobs where is_available = true and run_at <= now()`,
  );
  return rows.map((r) => String(r.id));
}

export default {
  id: "doctor/remediation-sql-is-printed-and-runnable",
  title: "a job that is dead and blocking a live run makes doctor --sql print SQL that fixes it",
  needs: ["postgres"],
  why:
    "The README promise is two halves: doctor is read-only, AND it prints the SQL when there is " +
    "something to fix. Only the first half was ever exercised. The second is unreachable by hand " +
    "because boot recovery routes around the dead row before anyone can look, so the branch that " +
    "emits remediation, and the SQL it emits, shipped unrun. If it is wrong, the person reading it " +
    "is already having their worst day and is being told to paste it into production.",

  async available() {
    if (!process.env.WORKFLOW_POSTGRES_URL) return ["WORKFLOW_POSTGRES_URL is not set"];
    if (graphileEntry() === null) {
      return ["cannot resolve graphile-worker through templates/default (run pnpm install)"];
    }
    try {
      const client = await connect();
      await client.end();
      return [];
    } catch (error) {
      return [`cannot reach Postgres: ${error.message}`];
    }
  },

  async run(t) {
    await sweep(process.env.WORKFLOW_POSTGRES_URL).catch(() => {});
    const client = await connect();
    const built = [];

    try {
      /* ── the state the command exists for ──────────────────────────────── */

      const wedge = await createWedgedJob({ url: process.env.WORKFLOW_POSTGRES_URL });
      built.push(wedge);

      t.note(
        `fixture ${wedge.graphileSchema}: job ${wedge.jobId}, run ${wedge.runId}, ` +
          `attempts spent at claim ${wedge.attemptsAtEachClaim.join("/")}, ` +
          `workflow_runs ${wedge.clonedFromReal ? "cloned from the real table" : "MINIMAL"}`,
      );

      // Anti-vacuity. Everything below is about a specific database state; if
      // the fixture did not reach it, every assertion after this is measuring
      // the wrong thing and must not be allowed to pass.
      const reached =
        wedge.jobId !== null &&
        wedge.claimableIds.length === 0 &&
        wedge.jobs.length === 1 &&
        wedge.jobs[0].last_error === null &&
        Number(wedge.jobs[0].attempts) >= Number(wedge.jobs[0].max_attempts);
      t.ok(reached, "the fixture produced one job that is dead, unclaimable and error-free", {
        expected: "1 job, attempts >= max_attempts, last_error NULL, nothing claimable",
        actual: JSON.stringify(wedge.jobs.map((j) => ({
          id: j.id,
          attempts: `${j.attempts}/${j.max_attempts}`,
          available: j.is_available,
          error: j.last_error === null ? null : "set",
        }))),
      });
      if (!reached) return;

      /* ── 1. it prints ───────────────────────────────────────────────── */

      const printed = await doctor([...wedge.doctorArgs, "--sql"]);

      t.ok(
        !printed.stderr.includes(NOTHING) && printed.stdout.trim().length > 0,
        "--sql prints remediation instead of the nothing-to-remediate line",
        { expected: "SQL on stdout", actual: `stdout ${printed.stdout.length}B, stderr: ${printed.stderr.trim().slice(0, 160)}` },
      );
      t.ok(printed.code === 1, "and exits 1, the documented code for at least one fault", {
        expected: "1",
        actual: String(printed.code),
      });

      const sql = printed.stdout;

      // The single most important line in the file. Clearing the lock is the
      // remediation every operator reaches for and it provably cannot work
      // here: locked_at on this row is already NULL. graphile-crash-wedge.mjs
      // walks three crash/clear cycles and shows the third one stop working.
      t.ok(/set attempts\s*=\s*0/.test(sql), "it resets attempts, which is the term that went false", {
        expected: "set attempts = 0",
        actual: sql.slice(0, 200),
      });
      t.ok(
        sql.includes(`update ${wedge.graphileSchema}._private_jobs`),
        "it names the schema it was pointed at rather than a hardcoded default",
        { expected: `update ${wedge.graphileSchema}._private_jobs`, actual: "not present" },
      );
      t.ok(
        new RegExp(`where id = ${wedge.jobId}\\b`).test(sql),
        "it names the job id the fixture wedged",
        { expected: `where id = ${wedge.jobId}`, actual: "not present" },
      );
      t.ok(
        sql.includes(wedge.runId),
        "it names the run the job is blocking, so the reader can check it themselves",
        { expected: wedge.runId, actual: "not present" },
      );
      t.ok(
        /\bbegin;/.test(sql) && /\bcommit;/.test(sql),
        "it is wrapped in a transaction the operator has to commit",
        { expected: "begin; ... commit;", actual: "one or both missing" },
      );
      t.ok(
        sql.includes("and attempts >= max_attempts") && sql.includes("and last_error is null"),
        "every UPDATE repeats the conditions that made the row a finding, so a moved row is skipped",
        { expected: "guarded WHERE", actual: "unguarded" },
      );

      /* ── 2. it is read-only ─────────────────────────────────────────────── */

      const afterPrinting = await claimableIds(client, wedge.graphileSchema);
      t.ok(
        afterPrinting.length === 0,
        "printing the SQL changed nothing: the job is still unclaimable",
        { expected: "no claimable job", actual: afterPrinting.join(", ") },
      );

      /* ── 3. the SQL is copy-pasteable, and it works ─────────────────────── */

      // The whole point of printing rather than fixing is that a human pastes
      // it. So paste it. Anything short of executing it leaves "it parses" and
      // "it repairs the queue" as two different claims, and only the second
      // one is the promise.
      let applyError = null;
      try {
        await client.query(sql);
      } catch (error) {
        applyError = error.message;
      }
      t.ok(applyError === null, "the emitted SQL runs against the database it was generated for", {
        expected: "no error",
        actual: String(applyError),
      });

      const afterApplying = await claimableIds(client, wedge.graphileSchema);
      t.ok(
        afterApplying.includes(String(wedge.jobId)),
        "and the job is claimable again, by the graphile claim predicate rather than by our say-so",
        { expected: `job ${wedge.jobId} claimable`, actual: afterApplying.join(", ") || "nothing claimable" },
      );

      // The closed loop: the tool that reported the fault now reports it gone.
      // Without this, "the SQL worked" rests on this probe reading the same
      // columns doctor reads, which is only half an independent check.
      const afterFix = await doctor([...wedge.doctorArgs, "--sql"]);
      t.ok(
        afterFix.stderr.includes(NOTHING) && afterFix.stdout.trim() === "",
        "re-running --sql on the repaired queue prints nothing, so the tool agrees it is fixed",
        { expected: NOTHING, actual: `code ${afterFix.code}, stdout ${afterFix.stdout.length}B` },
      );
      t.ok(afterFix.code === 0, "and exits 0: nothing is costing a run any more", {
        expected: "0",
        actual: String(afterFix.code),
      });

      /* ── 4. negative control: the run already finished ──────────────────── */

      const leftover = await createWedgedJob({
        url: process.env.WORKFLOW_POSTGRES_URL,
        runStatus: "completed",
      });
      built.push(leftover);

      const onLeftover = await doctor([...leftover.doctorArgs, "--sql"]);
      t.ok(
        onLeftover.stderr.includes(NOTHING) && onLeftover.stdout.trim() === "",
        "an identical dead job whose run already completed produces no SQL: it is a leftover",
        { expected: NOTHING, actual: onLeftover.stdout.slice(0, 200) || `code ${onLeftover.code}` },
      );

      /* ── 5. negative control: a live sibling job exists ─────────────────── */

      // This is the state the stranger test actually reached, and it is why the
      // command stayed silent for them. Reviving the dead row here would run
      // the same turn twice.
      const superseded = await createWedgedJob({
        url: process.env.WORKFLOW_POSTGRES_URL,
        withClaimableSibling: true,
      });
      built.push(superseded);

      t.ok(
        superseded.siblingJobId !== null,
        "the superseded fixture really does have a second, claimable job for the same run",
        { expected: "a live sibling", actual: JSON.stringify(superseded.claimableIds) },
      );

      const onSuperseded = await doctor([...superseded.doctorArgs, "--sql"]);
      t.ok(
        onSuperseded.stderr.includes(NOTHING) && onSuperseded.stdout.trim() === "",
        "a dead job with a live sibling produces no SQL: reviving it would run the turn twice",
        { expected: NOTHING, actual: onSuperseded.stdout.slice(0, 200) || `code ${onSuperseded.code}` },
      );

      /* ── 6. the human report says the same thing as --sql ───────────────── */

      // --sql and the default report are two renderings of one diagnosis. If
      // they can disagree, one of them is lying to somebody.
      const wedge2 = await createWedgedJob({ url: process.env.WORKFLOW_POSTGRES_URL });
      built.push(wedge2);
      const report = await doctor(wedge2.doctorArgs);
      t.ok(
        report.stdout.includes("blocking a live run"),
        "the human report names the same fault --sql refuses to be quiet about",
        { expected: "a wedged-jobs finding", actual: report.stdout.slice(0, 300) },
      );
      t.ok(
        report.stdout.includes("set attempts  = 0"),
        "and carries the same remediation inline, so the two renderings cannot drift",
        { expected: "the remediation SQL in the report body", actual: "absent" },
      );
    } finally {
      for (const fixture of built) await fixture.drop().catch(() => {});
      await client.end().catch(() => {});
    }
  },
};
