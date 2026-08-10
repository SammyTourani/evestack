#!/usr/bin/env node
/**
 * Promote a real session to an eval, then RUN the file it generated.
 *
 * The dashboard /evals page generates a draft `.eval.ts` from a real session
 * durable event log and offers it as a download. Nothing in this repository
 * had ever executed one. The unit tests in
 * packages/dashboard/test/promote-eval.test.mjs check the generator against
 * hand-written event fixtures, which is the right place for that, and it
 * leaves the interesting question open: is the thing it emits a file the eve
 * eval loader will actually take, and does the assertion it writes pass or
 * fail for the right reason?
 *
 * This lives beside negative-control.mjs rather than in probes/ on purpose.
 * Running an eval makes model calls, and contract/runtime/ is deterministic by
 * charter: a check that is right three times in four gets muted, and a muted
 * check is worse than an absent one. So this is a command a human or a nightly
 * job runs, not a probe.
 *
 * It is free on the Ollama path, which removes the usual excuse.
 *
 * USE
 *
 *   node contract/runtime/promote-and-run-eval.mjs \\
 *     --project=/path/to/my-agent \\
 *     --dashboard=http://127.0.0.1:4000 --user=evestack --password=... \\
 *     [--session=wrun_...] [--keep] [--generate-only]
 *
 * With no --session it takes the session the dashboard would rank first: the
 * one that went most wrong. That ordering is the product own (see
 * packages/dashboard/app/evals/grade.ts), and picking the worst session is the
 * point: a promoted happy path proves the plumbing, a promoted failure proves
 * the thing the feature is sold on.
 *
 * Exit codes: 0 the eval ran and passed - 1 the eval ran and failed (which for
 * a promoted regression is the CORRECT outcome, and the report says so) - 2
 * could not get far enough to find out.
 */
import { spawn } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback = null) =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const PROJECT = resolve(flag("project", process.cwd()));
const DASHBOARD = (flag("dashboard", "http://127.0.0.1:4000") ?? "").replace(/\/$/, "");
const USER = flag("user", process.env.EVESTACK_AUTH_USER);
const PASSWORD = flag("password", process.env.EVESTACK_AUTH_PASSWORD);
const AGENT = (flag("agent", "http://127.0.0.1:2000") ?? "").replace(/\/$/, "");
const SESSION = flag("session");
const KEEP = args.includes("--keep");
const GENERATE_ONLY = args.includes("--generate-only");

const out = (s) => process.stdout.write(s);
const section = (t) => out(`\n${t} ${"\u2500".repeat(Math.max(0, 74 - t.length))}\n\n`);
const die = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(2);
};

function auth() {
  if (!USER || !PASSWORD) die("--user and --password are required (or EVESTACK_AUTH_USER/PASSWORD)");
  return `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`;
}

/**
 * The session the /evals page would put at the top.
 *
 * Reproduces app/evals/grade.ts ranking in SQL rather than importing it: that
 * module is a .ts file inside a Next app, and this script has to run from an
 * installed project directory where the dashboard source is not present. The
 * ordering is denial, then failure, then happy path, which is the same reason
 * the page uses.
 */
async function worstSession(connectionString) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query(`
      select f.session_id,
             count(*) filter (where f.outcome in ('failed', 'no_model_call'))::int as bad,
             count(*)::int as turns,
             max(f.created_at) as last_at
        from evestack.fact_turn f
       group by f.session_id
      having count(*) > 0
       order by bad desc, last_at desc
       limit 1`);
    return rows[0] ?? null;
  } finally {
    await client.end().catch(() => {});
  }
}

function run(command, commandArgs, cwd) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, commandArgs, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c;
      process.stdout.write(c);
    });
    child.stderr.on("data", (c) => {
      stderr += c;
      process.stderr.write(c);
    });
    child.on("error", (error) => resolvePromise({ code: 2, stdout, stderr: String(error) }));
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

async function main() {
  if (!existsSync(join(PROJECT, "package.json"))) die(`no package.json in ${PROJECT}`);
  if (!existsSync(join(PROJECT, "evals"))) die(`no evals/ directory in ${PROJECT}`);

  let sessionId = SESSION;
  let ranking = null;
  if (!sessionId) {
    const url = process.env.WORKFLOW_POSTGRES_URL ?? process.env.DATABASE_URL;
    if (!url) die("pass --session=wrun_... or set WORKFLOW_POSTGRES_URL so one can be chosen");
    ranking = await worstSession(url);
    if (!ranking) die("no sessions with recorded turns to promote");
    sessionId = ranking.session_id;
  }

  section("PROMOTE");
  out(`session   ${sessionId}\n`);
  if (ranking) {
    out(`ranked    ${ranking.bad} failed of ${ranking.turns} turns`);
    out(ranking.bad > 0 ? "  <- this session went wrong\n" : "  <- happy path, nothing went wrong\n");
  }

  const response = await fetch(
    `${DASHBOARD}/api/evals/promote/${encodeURIComponent(sessionId)}?format=json`,
    { headers: { authorization: auth() } },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    die(`promote returned ${response.status}: ${body.slice(0, 400)}`);
  }
  const generated = await response.json();
  if (typeof generated.filename !== "string" || typeof generated.source !== "string") {
    die(`promote returned an unexpected body: ${JSON.stringify(generated).slice(0, 400)}`);
  }

  out(`filename  ${generated.filename}\n`);
  out(`source    ${generated.source.length} bytes\n`);
  for (const warning of generated.warnings ?? []) out(`warning   ${warning}\n`);

  // What the draft actually asserts. Worth printing before running it: a
  // promoted regression is SUPPOSED to be red, and reading the exit code
  // without reading this is how a correct red gets filed as a broken test.
  const replaysDenial = /respondAll\("deny"\)/.test(generated.source);
  const assertsSuccess = /\.succeeded\(\)/.test(generated.source);
  const sends = (generated.source.match(/await t\.send\(/g) ?? []).length;
  out(`\ndraft asserts: ${sends} turn(s) sent`);
  out(replaysDenial ? ", replays a denial" : "");
  out(assertsSuccess ? ", asserts succeeded()" : "");
  out("\n");
  if (sends === 0) die("the draft sends no messages: there is nothing to run");

  const destination = join(PROJECT, "evals", generated.filename);
  const preexisting = existsSync(destination);
  if (preexisting) die(`${destination} already exists; refusing to overwrite it`);
  writeFileSync(destination, generated.source);
  out(`\nwrote     ${destination}\n`);

  try {
    if (GENERATE_ONLY) {
      section("SOURCE");
      out(generated.source);
      return 0;
    }

    // eve derives an eval name from its path under evals/, so the name is the
    // filename with the suffix removed. Passing the wrong one is a silent
    // no-op that reports success, which is the failure this whole tier exists
    // to catch, so it is asserted rather than assumed below.
    const name = generated.filename.replace(/\.eval\.ts$/, "");

    section(`RUN  npx eve eval ${name} --url ${AGENT}`);
    const result = await run("npx", ["eve", "eval", name, "--url", `${AGENT}/`], PROJECT);

    section("VERDICT");
    const combined = `${result.stdout}\n${result.stderr}`;
    // A run that matched no eval exits 0 having done nothing. That reads
    // exactly like a pass in a log and in CI.
    const ranSomething = /\b1 eval\b|EVALS 1|\b1\/1\b|gate/i.test(combined);
    if (!ranSomething) {
      out("eve reported no eval by that name. This is NOT a pass: nothing was evaluated.\n");
      out(`name tried: ${name}\n`);
      return 2;
    }
    if (result.code === 0) {
      out("the promoted draft ran and passed.\n");
      return 0;
    }
    out(`the promoted draft ran and FAILED (exit ${result.code}).\n`);
    if (ranking && ranking.bad > 0) {
      out("That is the documented outcome for a promoted regression: the draft still\n");
      out("asserts succeeded(), so it stays red until the bug is fixed. Read the gate\n");
      out("above and decide which of the two is wrong.\n");
    }
    if (replaysDenial) {
      out("\nThe draft replays a denial. templates/default/evals/deny-survives.eval.ts is\n");
      out("the hand-hardened version of this same file: it replaced the generated\n");
      out("succeeded() with notEvent(\"session.failed\"), because a model that asks a\n");
      out("follow-up after a denial parks the turn again and succeeded() then flakes.\n");
    }
    return 1;
  } finally {
    if (KEEP) {
      out(`\n--keep: left ${destination} in place\n`);
    } else if (!preexisting) {
      rmSync(destination, { force: true });
      out(`\nremoved   ${destination}\n`);
    }
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`\npromote-and-run failed: ${error?.stack ?? error}\n`);
    process.exitCode = 2;
  },
);
