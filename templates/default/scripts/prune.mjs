#!/usr/bin/env node
/**
 * `npm run db:prune` — the opt-in maintenance command for eve's `workflow` schema.
 *
 *   npm run db:prune -- --older-than=90d              # dry run. Always start here.
 *   npm run db:prune -- --older-than=90d --apply      # asks, then deletes
 *   npm run db:prune -- --older-than=90d --apply --yes    # for cron
 *
 * Nothing here runs on its own, and nothing here is scheduled for you. The
 * reasoning — what a session is made of, which rows eve still needs, why there
 * are no foreign keys to lean on, and the measurements behind all of it — is in
 * scripts/retention.mjs beside the SQL it explains, and in docs/operations.mdx.
 * Read one of them before you type `--apply`.
 *
 * Two properties this file is responsible for, as opposed to the SQL:
 *
 *   DRY RUN IS THE DEFAULT and `--older-than` has none. A prune whose window you
 *   did not state is a prune you did not decide on.
 *
 *   `--apply` CONFIRMS. On a TTY it prints the counts and waits for `yes`; off a
 *   TTY it refuses without `--yes`, because a destructive command that reads
 *   stdin from a cron job either hangs forever or answers itself. `evestack
 *   tour` has the same rule for the same reason.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { C, connectPostgres, envValue, readEnvFile, redact } from "./checks.mjs";
import { FACTS_PRESENT_SQL, orphanedFactsSql, parseWindow, previewSql, pruneSql } from "./retention.mjs";

const USAGE = `
${C.bold}  npm run db:prune${C.reset} — delete old eve sessions from Postgres.

  ${C.bold}--older-than=<window>${C.reset}   required. 30d, 12h, 6mo, 1y. No default, on purpose.
  ${C.bold}--apply${C.reset}                 actually delete. Without it this only reports.
  ${C.bold}--yes${C.reset}                   skip the confirmation. Required with --apply off a TTY.
  ${C.bold}--batch=<n>${C.reset}             sessions per transaction (default 200).
  ${C.bold}--keep-facts${C.reset}            leave orphaned evestack.fact_* rows behind.

  A session is pruned whole or not at all, and only when every run in it —
  the session, its turns, its subagents and eve's own timeout companion — is
  finished and has not moved inside the window. Anything still 'running',
  including an open session, protects its whole family.

  ${C.dim}Not deleted: evestack.approvals (the audit trail), evestack.memories,${C.reset}
  ${C.dim}graphile_worker.* and workflow_drizzle.*. See docs/operations.mdx.${C.reset}
`;

function fail(lines) {
  console.error(`\n${C.red}${C.bold}  Cannot prune.${C.reset}\n`);
  for (const line of lines) console.error(`  ${line}`);
  console.error();
  process.exit(1);
}

function flag(argv, name) {
  const exact = `--${name}`;
  const prefix = `${exact}=`;
  const hit = argv.find((a) => a === exact || a.startsWith(prefix));
  if (hit === undefined) return undefined;
  return hit === exact ? true : hit.slice(prefix.length);
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
  console.log(USAGE);
  process.exit(argv.length === 0 ? 1 : 0);
}

const unknown = argv.filter(
  (a) => !/^--(older-than|apply|yes|batch|keep-facts|help)(=|$)/.test(a) && a !== "-h",
);
if (unknown.length > 0) {
  fail([`Unrecognised: ${unknown.join(" ")}`, "", `Run ${C.bold}npm run db:prune -- --help${C.reset}.`]);
}

let window;
try {
  window = parseWindow(flag(argv, "older-than"));
} catch (error) {
  fail([error.message]);
}

const apply = flag(argv, "apply") === true;
const assumeYes = flag(argv, "yes") === true;
const keepFacts = flag(argv, "keep-facts") === true;

const batchRaw = flag(argv, "batch");
const batch = batchRaw === undefined || batchRaw === true ? 200 : Number(batchRaw);
if (!Number.isInteger(batch) || batch < 1) {
  fail([`--batch must be a positive whole number of sessions; got "${batchRaw}".`]);
}

// Same resolution order as every other script here: a real export wins over the
// file, and an absent .env.local is not an error (containers and CI export it).
const url = envValue(readEnvFile(), "WORKFLOW_POSTGRES_URL");
if (!url) {
  fail([
    "WORKFLOW_POSTGRES_URL is not set, so there is no Postgres to prune.",
    "",
    "  Without it eve keeps sessions in an on-disk world under .eve/.workflow-data,",
    "  which this command does not manage — delete that directory to reset it.",
  ]);
}

const probe = await connectPostgres(url, 5000);
if (!probe.ok) {
  fail([
    `Postgres is not answering. ${C.dim}${redact(url)}${C.reset}`,
    `${C.dim}${probe.error}${C.reset}`,
    "",
    "    docker compose up -d postgres",
  ]);
}
const db = probe.client;

try {
  const [{ present }] = (
    await db.query("SELECT to_regclass('workflow.workflow_runs') IS NOT NULL AS present")
  ).rows;
  if (!present) {
    fail([
      "There is no workflow.workflow_runs table in this database.",
      "",
      `    ${C.bold}npm run db:bootstrap${C.reset}`,
    ]);
  }

  const [preview] = (await db.query(previewSql(), [window, batch])).rows;
  const sessions = Number(preview.sessions);

  console.log(`\n${C.bold}  Sessions with no activity for ${window}${C.reset}  ${C.dim}${redact(url)}${C.reset}\n`);
  if (sessions === 0) {
    console.log(`  ${C.green}Nothing to prune.${C.reset}`);
    console.log(
      `  ${C.dim}A session is only eligible once every run in it is finished. If you expected${C.reset}\n` +
        `  ${C.dim}rows here, look for runs stuck in 'running' — docs/troubleshooting.mdx has the${C.reset}\n` +
        `  ${C.dim}query and the repair for a row whose status disagrees with its payload.${C.reset}\n`,
    );
    process.exit(0);
  }

  const rows = [
    ["sessions", preview.sessions],
    ["runs", preview.runs],
    ["events", preview.events],
    ["steps", preview.steps],
    ["hooks", preview.hooks],
    ["waits", preview.waits],
    ["stream chunks", preview.stream_chunks],
  ];
  for (const [label, value] of rows) {
    console.log(`    ${label.padEnd(16)}${String(value).padStart(9)}`);
  }
  console.log(`\n  ${C.dim}oldest ${preview.oldest} · newest ${preview.newest} (UTC)${C.reset}`);
  if (sessions === batch) {
    console.log(
      `  ${C.dim}Capped at --batch=${batch}; there may be more. Re-run until it reports nothing.${C.reset}`,
    );
  }

  if (!apply) {
    console.log(
      `\n  ${C.bold}Dry run — nothing was deleted.${C.reset}\n` +
        `  Add ${C.bold}--apply${C.reset} to delete these sessions and everything under them.\n`,
    );
    process.exit(0);
  }

  if (!assumeYes) {
    if (!stdin.isTTY || !stdout.isTTY) {
      fail([
        "--apply needs a confirmation and there is no terminal to ask.",
        "",
        `  Add ${C.bold}--yes${C.reset} if you mean it. This deletes conversation history permanently;`,
        "  there is no undo and no tombstone. Take a pg_dump first.",
      ]);
    }
    const rl = createInterface({ input: stdin, output: stdout });
    const answer = await rl.question(
      `\n  ${C.red}${C.bold}This permanently deletes ${sessions} session(s) and ${preview.runs} run(s).${C.reset}\n` +
        `  ${C.dim}There is no undo. Type ${C.reset}${C.bold}yes${C.reset}${C.dim} to continue: ${C.reset}`,
    );
    rl.close();
    if (answer.trim().toLowerCase() !== "yes") {
      console.log(`\n  Nothing was deleted.\n`);
      process.exit(0);
    }
  }

  // One batch per statement, one statement per transaction — the loop is here
  // rather than in SQL so a first prune over a long backlog commits as it goes
  // instead of holding locks for all of it. Same shape as the dashboard's
  // pruneSpans() around evestack.prune_spans.
  const total = { sessions: 0, runs: 0, events: 0, steps: 0, hooks: 0, waits: 0, stream_chunks: 0 };
  for (;;) {
    const [done] = (await db.query(pruneSql(), [window, batch])).rows;
    for (const key of Object.keys(total)) total[key] += Number(done[key] ?? 0);
    if (Number(done.sessions) < batch) break;
    process.stdout.write(`  ${C.dim}… ${total.sessions} sessions${C.reset}\r`);
  }

  console.log(
    `\n  ${C.green}${C.bold}Deleted${C.reset} ${total.sessions} session(s): ` +
      `${total.runs} runs, ${total.events} events, ${total.steps} steps, ` +
      `${total.hooks} hooks, ${total.waits} waits, ${total.stream_chunks} stream chunks.`,
  );

  if (!keepFacts) {
    const [{ present: factsPresent }] = (await db.query(FACTS_PRESENT_SQL)).rows;
    if (factsPresent) {
      const [facts] = (await db.query(orphanedFactsSql())).rows;
      console.log(
        `  ${C.dim}Derived rows removed with them: ${facts.fact_turns} evestack.fact_turn, ` +
          `${facts.fact_tool_calls} evestack.fact_tool_call.${C.reset}`,
      );
    }
  }

  console.log(
    `\n  ${C.dim}Postgres does not return the space to the filesystem on its own. A plain${C.reset}\n` +
      `  ${C.dim}autovacuum makes it reusable; VACUUM FULL (which takes an exclusive lock and${C.reset}\n` +
      `  ${C.dim}needs room for a second copy) is what actually shrinks the files.${C.reset}\n`,
  );
} finally {
  await db.end().catch(() => {});
}
