/**
 * `create-evestack attach` — wrap an EXISTING self-hosted eve project with
 * evestack's control plane.
 *
 * `create-evestack` only helps someone who has not started yet. The person who
 * most needs a dashboard is the one already running eve with no idea what their
 * agent did last night, and telling them to start over is not an answer.
 *
 * Three rules hold this command together, in this order:
 *
 *   1. Additive. evestack is a distribution of eve, not a fork, so attaching
 *      adds files and env keys and never rewrites the project's own code — with
 *      exactly one exception (`agent/agent.ts`), which is asked for, printed,
 *      and written as a conditional spread that is a no-op until the matching
 *      env var exists.
 *   2. Plan, then act. Everything is printed before anything is written, and a
 *      file the user wrote is never overwritten — it is skipped and reported.
 *   3. Reversible. Every write ends up in an undo list, and following that list
 *      returns the project to plain eve.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { projectNameFor } from "./create.mjs";
import {
  C, DASHBOARD_IMAGE, detectPm, dim, freePort, makePrompter, ok, packageVersion,
  REPO, say, shellQuote, step, templateDir, warn, writeSecretFile,
} from "./shared.mjs";

/**
 * The eve release this evestack is tested against.
 *
 * Read out of the template's own package.json rather than typed here. Hand-typed
 * it went stale immediately and silently: the template moved to ^0.30.8 while
 * this still said 0.30.6, so `attach` congratulated a 0.30.6 project for being
 * "the version evestack certifies" and told a 0.30.8 one it was ahead of us.
 * One number, one source, and the comment cannot drift from it either.
 *
 * The fallback is only reachable if the template is missing or its eve range is
 * unparseable — in which case the version report is the least of the problems,
 * and a stale number still beats a crash.
 */
const CERTIFIED_EVE_FALLBACK = "0.30.8";
const CERTIFIED_EVE = readCertifiedEve();

function readCertifiedEve() {
  const dir = templateDir({ optional: true });
  if (!dir) return CERTIFIED_EVE_FALLBACK;
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return minVersion(pkg.dependencies?.eve ?? pkg.devDependencies?.eve) ?? CERTIFIED_EVE_FALLBACK;
  } catch {
    return CERTIFIED_EVE_FALLBACK;
  }
}
/**
 * The floor for anything reachable from a network. Below 0.30.2, eve's
 * `localDev()` matched an unanchored /^127\./ against the attacker-controlled
 * Host header, so `127.evil.com` obtained an unauthenticated principal. Fixed
 * upstream in 0.30.0 and confirmed on 0.30.2; see the README.
 */
const MIN_EVE = "0.30.2";
const OTEL_RANGE = "^2.1.3";
/**
 * A dist-tag, not a version range, and deliberately so: npm's `latest` for
 * @workflow/world-postgres is the 4.x line, eve needs 5.0.0-beta, and the
 * runtime rejects a mismatched protocol version outright.
 */
const WORLD_TAG = "beta";
/**
 * The dashboard's ingest URL, on the port this attach actually picked.
 *
 * This was a constant naming 4000, written into the user's env file, while
 * `create` had already learned to probe. On a machine already running one
 * evestack dashboard that URL is the OTHER project's dashboard — whose
 * EVESTACK_INGEST_TOKEN is a different generated value — so every span POST is a
 * 401, and @vercel/otel reports a 401 as a successful export. The symptom is a
 * Traces tab that stays empty on both projects.
 */
function dashboardIngest(port) {
  return `http://localhost:${port}/api/ingest/v1/traces`;
}

const COMPOSE_NAMES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];
const AGENT_ENTRIES = ["agent.ts", "agent.tsx", "agent.mts", "agent.js", "agent.mjs"];
const INSTRUMENTATION_ENTRIES = [
  "instrumentation.ts", "instrumentation.tsx", "instrumentation.mts",
  "instrumentation.js", "instrumentation.mjs",
];

const BLOCK_START = "# --- evestack attach ---------------------------------------------------------";
const BLOCK_END = "# --- end evestack attach -----------------------------------------------------";

/**
 * The flags `attach` has, and why an unknown one stops it.
 *
 * Same parser as `create` had and the same bug: unknown flags were filtered out
 * and the value behind them survived as a positional, so `attach --port 5000`
 * would attach to a directory called `5000` — i.e. refuse with "No such
 * directory", which is a confusing sentence about a path the user never typed.
 */
const ATTACH_FLAGS = new Map([
  ["--yes", "yes"], ["-y", "yes"],
  ["--dry-run", "dryRun"], ["-n", "dryRun"],
  ["--help", "help"], ["-h", "help"],
  ["--version", "version"], ["-V", "version"],
]);

export const ATTACH_USAGE = `evestack attach — add the control plane to an eve project you already have

  npx create-evestack attach [dir] [--yes] [--dry-run]
  evestack attach [dir] [--yes] [--dry-run]

Additive. It writes a Postgres compose file, the env keys the dashboard and
durable sessions need, an instrumentation file if you want traces, and nothing
else. Files you wrote are never overwritten — they are skipped and reported —
and everything it does write is printed as an undo list at the end.

Options
  --yes, -y       skip the confirmation. Required when stdin is not a terminal
  --dry-run, -n   print the plan and write nothing
  --help, -h      this
  --version, -V   print create-evestack's version

The plan is printed before anything is written, so the honest way to look before
you leap is \`--dry-run\`. [dir] defaults to the current directory.
`;

export function parseAttachArgs(argv) {
  const parsed = { positional: [], yes: false, dryRun: false, help: false, version: false, error: null };
  let endOfFlags = false;
  for (const arg of argv) {
    if (endOfFlags || !arg.startsWith("-") || arg === "-") {
      parsed.positional.push(arg);
      continue;
    }
    if (arg === "--") {
      endOfFlags = true;
      continue;
    }
    const key = ATTACH_FLAGS.get(arg.split("=")[0]);
    if (!key || arg.includes("=")) {
      parsed.error =
        `Unknown option ${JSON.stringify(arg)} — nothing was written.\n` +
        "  attach takes one directory and:\n" +
        "    --yes, -y      skip the confirmation\n" +
        "    --dry-run, -n  print the plan and write nothing\n" +
        "    --help, -h     the full usage\n" +
        "    --version, -V  print the version";
      return parsed;
    }
    parsed[key] = true;
  }
  if (parsed.positional.length > 1) {
    parsed.error =
      `attach takes one directory, and got ${parsed.positional.length}: ` +
      `${parsed.positional.map((p) => JSON.stringify(p)).join(", ")}.\n` +
      "  Nothing was written.";
  }
  return parsed;
}

export async function attach(argv) {
  // Help and version before detection, because detection is not free: through
  // `npx create-evestack attach --help` this command used to inspect a real
  // project, print a plan and then ask "Write these changes? (Y/n)" with the
  // default at yes. index.mjs answers --help before it imports this file at all;
  // this is the same answer for `evestack attach --help`, which arrives here
  // directly.
  const args = parseAttachArgs(argv);
  if (args.help) {
    say(ATTACH_USAGE);
    return 0;
  }
  if (args.version) {
    say(packageVersion());
    return 0;
  }
  if (args.error) {
    console.error(`\n${C.red}${args.error}${C.reset}\n`);
    return 1;
  }
  const { yes, dryRun } = args;

  const name = args.positional[0] ?? ".";
  const target = isAbsolute(name) ? name : resolve(process.cwd(), name);

  say();
  say(`${C.cyan}${C.bold}  evestack attach${C.reset} ${C.dim}— add the control plane to an eve project you already have${C.reset}`);
  say();

  const project = detectEveProject(target);
  step(`Attaching ${C.bold}${target}${C.reset}`);
  reportEveVersion(project);

  const pm = detectPm(target);
  const env = readEnvFiles(target);
  const envFileName = chooseEnvFile(target);

  // Questions first: everything asked here changes what the plan says, and a
  // plan the user then has to re-read after answering more questions is not a
  // plan. The only prompt after this point is the confirmation.
  const existingInstrumentation = firstExisting(target, "agent", INSTRUMENTATION_ENTRIES);
  const interactive = !(yes || dryRun) && process.stdin.isTTY;
  const prompt = await makePrompter(!interactive);
  let wantTraces = false;
  if (!existingInstrumentation) {
    say();
    dim("Trace export sends prompt bodies and tool arguments to the dashboard.");
    dim("It also disables eve's local `.eve/traces` spool — eve installs no writer");
    dim("of its own alongside authored instrumentation, so `eve traces` stops working.");
    dim("The dashboard's session, cost and approval views work either way.");
    wantTraces = await prompt.confirm("Export traces to the dashboard?", true);
    // The prompter answers with the default when nobody is at the keyboard, and
    // a default silently taken is worth one line of output.
    if (!interactive) dim("Taking the default: yes. Delete agent/instrumentation.ts to change your mind.");
  }

  // Resolved before the plan is built so the plan can name the ports it will
  // publish on rather than promising 5433 and using something else.
  //
  // All three are now probed. Postgres always was; the dashboard was the constant
  // 4000 and the agent the constant 2000, which on a machine already running one
  // evestack project meant the printed `docker run` failed on "port is already
  // allocated" — and, worse, that the agent's EVESTACK_DASHBOARD_URL pointed at
  // the OTHER project's dashboard, whose ingest token is a different generated
  // value, so every span was a 401 that @vercel/otel reports as a success.
  const port = await freePort(5433);
  const dashboardPort = await freePort(4000);
  // The agent's port is a PREDICTION, and the only honest one available: `eve
  // dev` takes 2000 and silently auto-increments when it is busy, and an attached
  // project runs its own dev script, so nothing here can pin it. If the project
  // records a port, that is the answer; otherwise the first free port from 2000 is
  // where eve will land, on the same reasoning eve uses. printSummary says to
  // check eve's startup log either way.
  const agentPort = recordedPort(env.get("EVESTACK_AGENT_PORT")) ?? (await freePort(2000));
  const plan = buildPlan({
    target, project, env, envFileName, pm, wantTraces, existingInstrumentation,
    port, dashboardPort, agentPort,
  });
  printPlan(plan);
  prompt.close();

  if (plan.adds.length === 0 && plan.changes.length === 0) {
    say();
    say(`  ${C.dim}Nothing to write — this project already has everything attach adds.${C.reset}`);
    say();
    return;
  }

  if (dryRun) {
    say();
    say(`  ${C.dim}--dry-run: nothing was written.${C.reset}`);
    say();
    return;
  }

  // A confirmation that defaults to yes when nobody is there to answer is not a
  // confirmation. `create-evestack` may assume consent from a non-TTY because it
  // only ever creates a new empty directory; this command touches a project the
  // user already has, so it asks for --yes in writing.
  if (!yes && !process.stdin.isTTY) {
    say();
    console.error(
      `${C.red}Refusing to change an existing project without confirmation.${C.reset}\n` +
        `  stdin is not a terminal, so there is nobody to ask. Re-run with --yes if the plan above is what you want.`,
    );
    process.exit(1);
  }
  if (!yes) {
    const proceed = await confirmPlan();
    if (!proceed) {
      say();
      say(`  ${C.dim}Nothing written.${C.reset}`);
      say();
      return;
    }
  }

  say();
  step("Writing");
  // Rule 3 of this file's header is "every write ends up in an undo list", and
  // printSummary — which prints that list — only ran after every write had
  // succeeded. So the one case where the list matters most, a run that stopped
  // half way through on a read-only .gitignore or a root-owned file, printed a
  // few checkmarks and a bare error message: files changed, and no record of
  // which. Each write is now individually accounted for.
  const written = [];
  for (const action of [...plan.adds, ...plan.changes]) {
    try {
      action.write();
    } catch (error) {
      printPartialSummary(written, action, error);
      return 1;
    }
    written.push(action);
    ok(`${action.path} ${C.dim}${action.what}${C.reset}`);
  }

  printSummary(plan);
  return 0;
}

// ---------------------------------------------------------------------------
// detection
// ---------------------------------------------------------------------------

/**
 * Refuse anything that is not an eve project, and say which check failed.
 *
 * "This doesn't look like an eve project" is useless to the person who has one
 * and mistyped a path. Every branch below names the exact file it wanted.
 */
function detectEveProject(target) {
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    throw new Error(
      `No such directory: ${target}\n` +
        `  Pass the path to an existing eve project, or run this from inside one.`,
    );
  }

  const pkgPath = join(target, "package.json");
  if (!existsSync(pkgPath)) {
    throw new Error(
      `${pkgPath} does not exist.\n` +
        `  attach wraps an eve project you already have. To start a new one:\n` +
        `    npx create-evestack my-agent`,
    );
  }

  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch (error) {
    throw new Error(`${pkgPath} is not valid JSON — ${error.message}`);
  }

  const range = pkg.dependencies?.eve ?? pkg.devDependencies?.eve;
  if (!range) {
    throw new Error(
      `${pkgPath} lists no "eve" dependency.\n` +
        `  This is a Node project, but not an eve one, and attach has nothing to attach to.\n` +
        `  To start an eve project here:  npx eve init .\n` +
        `  To start a new evestack one:   npx create-evestack my-agent`,
    );
  }

  const agentDir = join(target, "agent");
  if (!existsSync(agentDir)) {
    throw new Error(
      `${agentDir} does not exist.\n` +
        `  eve discovers everything from that directory — an eve project always has one.\n` +
        `  If the agent lives elsewhere, run attach from that directory instead.`,
    );
  }

  const agentEntry = firstExisting(target, "agent", AGENT_ENTRIES);
  if (!agentEntry) {
    throw new Error(
      `${join(agentDir, "agent.ts")} does not exist.\n` +
        `  eve's root agent lives there, and attach needs it to wire durable sessions.\n` +
        `  Found in agent/: ${readdirNames(agentDir).join(", ") || "(nothing)"}`,
    );
  }

  const installedPath = join(target, "node_modules", "eve", "package.json");
  let installed = null;
  if (existsSync(installedPath)) {
    try {
      installed = JSON.parse(readFileSync(installedPath, "utf8")).version ?? null;
    } catch {
      installed = null;
    }
  }

  return { target, pkg, pkgPath, range, installed, agentEntry };
}

function reportEveVersion({ range, installed }) {
  const found = installed ?? minVersion(range);
  const source = installed ? "installed" : `from package.json — "${range}"`;
  if (!found) {
    warn(`eve ${range} — could not read a version number out of that range.`);
    return;
  }
  const cmp = compareVersions(found, CERTIFIED_EVE);
  if (compareVersions(found, MIN_EVE) < 0) {
    warn(`eve ${found} (${source}) — older than ${MIN_EVE}.`);
    dim("Below 0.30.2 eve's localDev() matched an unanchored /^127\\./ against the Host");
    dim("header, so `127.evil.com` got an unauthenticated principal. Upgrade before");
    dim("anything but your own laptop can reach this agent.");
  } else if (cmp < 0) {
    warn(`eve ${found} (${source}) — evestack certifies ${CERTIFIED_EVE}. Older is untested, not unsupported.`);
  } else if (cmp > 0) {
    ok(`eve ${found} (${source}) — newer than the ${CERTIFIED_EVE} evestack certifies.`);
  } else {
    ok(`eve ${found} (${source}) — the version evestack certifies.`);
  }
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

function buildPlan({
  target, project, env, envFileName, pm, wantTraces, existingInstrumentation,
  port, dashboardPort, agentPort,
}) {
  const plan = {
    target, pm, envFileName, port, dashboardPort, agentPort,
    adds: [], changes: [], skips: [], manual: [], notes: [], alerts: [],
    dbUrl: null, composeFile: null, reusedCompose: null, ingestToken: null,
  };
  const add = (path, what, undo, write) => plan.adds.push({ path, what, undo, write });
  const change = (path, what, undo, write) => plan.changes.push({ path, what, undo, write });

  const agentPath = join(target, "agent", project.agentEntry);
  const agentSrc = readFileSync(agentPath, "utf8");
  const existingUrl = env.get("WORKFLOW_POSTGRES_URL");
  const envAdditions = [];

  // ---- Postgres ------------------------------------------------------------
  if (existingUrl) {
    // Their database, their credentials, their backups. Point the dashboard at
    // it and add nothing — a second Postgres would split the session history in
    // half and neither half would be complete.
    plan.dbUrl = existingUrl;
    plan.notes.push(`Using the WORKFLOW_POSTGRES_URL already in ${envFileName} — no Postgres added.`);
  } else {
    // A Postgres this attach already wrote on a previous run, if there is one.
    //
    // THIS IS THE FRESH-CLONE CASE, and it is not exotic: attach gitignores the
    // env file it writes and leaves the compose file to be committed, so a `git
    // clone` of an attached project has the compose file and no env file. That
    // makes existingUrl falsy, which used to mean "generate a new password" — and
    // the new password went into a SECOND compose file while the first was
    // skipped, both with the same project name and the same volume. Postgres only
    // applies POSTGRES_PASSWORD when the volume is initialised, so the user got
    // `password authentication failed for user evestack` with nothing anywhere
    // connecting it to the second file.
    const previous = findEvestackPostgres(target);
    // Reuse a password already in play rather than invent one that cannot work.
    //
    // The order is where Postgres will actually read it from: a literal in an
    // existing compose file wins, because that file has no `env_file:` for the
    // env file to feed; otherwise POSTGRES_PASSWORD in the env file is what the
    // container gets, whether attach put it there on an earlier run or the
    // project already had one. Generating a fresh value while either of those is
    // sitting there produces a URL that cannot authenticate against the container
    // it names — which is the same failure this branch exists to prevent.
    // EVESTACK_DB_PASSWORD is in the chain because a `create` scaffold keeps the
    // password under that name, in the .env its compose file interpolates from —
    // so attaching to a scaffolded project whose .env.local was lost reuses the
    // value the container already has instead of inventing one it will refuse.
    const knownPassword =
      previous?.password ?? env.get("POSTGRES_PASSWORD") ?? env.get("EVESTACK_DB_PASSWORD") ?? null;
    const password = knownPassword ?? randomBytes(18).toString("base64url");
    const dbPort = previous?.port ?? port;
    // 127.0.0.1, never "localhost": the port is published on the loopback IPv4
    // address only, and a resolver that answers localhost with ::1 first turns
    // a working stack into ECONNREFUSED.
    plan.dbUrl = `postgres://evestack:${password}@127.0.0.1:${dbPort}/evestack`;

    const existingCompose = COMPOSE_NAMES.find((n) => existsSync(join(target, n)));
    if (previous && previous.port === null) {
      // The URL below has to name the port that file publishes, and this one does
      // not publish it in the shape attach writes — so the port in it is this
      // run's guess rather than a reading.
      plan.alerts.push(
        `Could not read a published port out of ${previous.file}, so WORKFLOW_POSTGRES_URL ` +
          `assumes ${dbPort}. Check the \`ports:\` line in that file and fix the URL in ` +
          `${envFileName} if it says something else.`,
      );
    }
    if (previous) {
      // Point at it, do not write a second one.
      plan.reusedCompose = previous.file;
      plan.skips.push([previous.file, "evestack already put a Postgres here — reusing it, not adding a second"]);
      if (previous.password) {
        plan.notes.push(
          `Recovered this project's database password from ${previous.file}, so the volume it ` +
            `already initialised still opens.`,
        );
        // The rotation advice has to name the file the CONTAINER reads, and for a
        // file in this old shape that is the compose file itself, not the env
        // file: it passes POSTGRES_PASSWORD straight through `environment:`, so
        // changing the env file alone would leave the container on the old value.
        plan.alerts.push(
          `${previous.file} carries the database password in plain text, which is how older ` +
            `versions of attach wrote it — so it is in your git history. To rotate: delete that ` +
            `file and re-run attach (it writes one that reads the password from ${envFileName} ` +
            `instead), then \`docker compose${composeFlag(previous.file)} down -v\` to drop the ` +
            `volume — which deletes the sessions in it — and bring it up again.`,
        );
      } else if (knownPassword) {
        plan.notes.push(
          `Reusing the POSTGRES_PASSWORD already in ${envFileName} — that is the value ` +
            `${previous.file} feeds the container, so the volume it initialised still opens.`,
        );
      } else {
        // The password is in an env file that is no longer here, which is exactly
        // what a fresh clone looks like. A new one works on a machine that has
        // never run this project and cannot work on the machine that has.
        plan.alerts.push(
          `${previous.file} defines this project's Postgres but nothing here holds its password ` +
            `— ${envFileName} is missing or has no WORKFLOW_POSTGRES_URL, which is what a fresh ` +
            `clone looks like. A new password is being generated. Postgres only applies a ` +
            `password when its data volume is FIRST created, so if that volume still exists on ` +
            `this machine you will get "password authentication failed for user evestack": ` +
            `either put the old password back in ${envFileName}, or run ` +
            `\`docker compose${composeFlag(previous.file)} down -v\` to start the database empty ` +
            `(that deletes the sessions in it).`,
        );
      }
    } else if (!existingCompose) {
      plan.composeFile = "docker-compose.yml";
    } else if (!existsSync(join(target, "docker-compose.evestack.yml"))) {
      // Never merged into theirs. Compose merges by service name, so a fragment
      // dropped into a file that already defines `postgres` would silently
      // rewrite the image and ports of a service they own. A separate file with
      // its own project name runs alongside instead.
      plan.composeFile = "docker-compose.evestack.yml";
      plan.skips.push([existingCompose, "you already have it — evestack does not overwrite compose files"]);
    } else {
      plan.skips.push([existingCompose, "you already have it, and docker-compose.evestack.yml too"]);
    }

    if (plan.composeFile) {
      // projectNameFor, imported from the scaffolder, not a local derivation
      // from package.json's name.
      //
      // composeProjectName() hashed nothing: `evestack-${pkg.name}`, so two
      // projects both called "my-agent" — the create-evestack DEFAULT name — got
      // one Compose project name and one volume, and the second `docker compose
      // up -d postgres` recreated the first's container. Both agents then read
      // one database. `create` fixed exactly this by hashing the absolute path
      // and exported the function to be reused; the comment this file generates
      // three hundred lines down claimed the opposite was already true.
      const projectName = projectNameFor(target);
      add(
        plan.composeFile,
        `Postgres 17 (pgvector) on 127.0.0.1:${port}`,
        `docker compose${composeFlag(plan.composeFile)} down -v, then rm ${plan.composeFile}`,
        () => writeFileSync(join(target, plan.composeFile), composeFragment({
          projectName, envFileName, port, file: plan.composeFile,
        })),
      );
      if (knownPassword) {
        plan.notes.push(
          `Reusing the POSTGRES_PASSWORD already in ${envFileName} rather than generating a ` +
            `second one — the compose file below reads it from there.`,
        );
      }
      envAdditions.push(
        ["", ""],
        ["", `# Durable sessions — the Postgres in ${plan.composeFile}`],
        ["WORKFLOW_POSTGRES_URL", plan.dbUrl],
        ["", "# Read by the Postgres container itself, through `env_file:` in"],
        ["", `# ${plan.composeFile}. It lives here rather than in that file because the`],
        ["", "# compose file is meant to be committed and this password must not be."],
        ["POSTGRES_PASSWORD", password],
        ["", "# world-postgres defaults to concurrency 50 against a pool of 10 and warns"],
        ["", "# about it on every boot. Matching them silences it."],
        ["WORKFLOW_POSTGRES_MAX_POOL_SIZE", "20"],
        ["WORKFLOW_POSTGRES_WORKER_CONCURRENCY", "20"],
      );
    } else if (plan.reusedCompose) {
      envAdditions.push(
        ["", ""],
        ["", `# Durable sessions — the Postgres in ${plan.reusedCompose}`],
        ["WORKFLOW_POSTGRES_URL", plan.dbUrl],
        ["POSTGRES_PASSWORD", password],
        ["WORKFLOW_POSTGRES_MAX_POOL_SIZE", "20"],
        ["WORKFLOW_POSTGRES_WORKER_CONCURRENCY", "20"],
      );
    } else {
      plan.manual.push([
        "Add Postgres yourself",
        `Both compose files exist. The service block evestack would have written is printed below;\n` +
          `    add it, then put WORKFLOW_POSTGRES_URL and POSTGRES_PASSWORD in ${envFileName}.`,
      ]);
    }
  }

  // ---- the workflow world --------------------------------------------------
  // eve reads the world from agent.ts and from nowhere else: there is no env
  // var for it, so a project on the local on-disk world cannot be moved to
  // Postgres without touching that file. See eve's agent-config docs.
  if (/world-postgres/.test(agentSrc)) {
    plan.notes.push("agent.ts already selects @workflow/world-postgres.");
  } else if (canInjectWorld(agentSrc)) {
    change(
      `agent/${project.agentEntry}`,
      "select the Postgres workflow world",
      `delete the "evestack attach" block in agent/${project.agentEntry}`,
      () => writeFileSync(agentPath, injectWorld(agentSrc)),
    );
  } else {
    plan.manual.push([
      `agent/${project.agentEntry}`,
      "Could not find a plain `defineAgent({` to extend — the snippet to paste is printed below.",
    ]);
  }

  // ---- instrumentation -----------------------------------------------------
  //
  // THE TOKEN THE PROJECT ALREADY HAS WINS, and this is read before the branches
  // below because every one of them ends in a `docker run` that has to name it.
  //
  // What used to happen: the token was minted inside the `wantTraces` branch and
  // nowhere else, so a second attach against a project that already had one
  // disagreed with itself two ways. Both reproduced against a temp project:
  //
  //   instrumentation.ts deleted and attach re-run — the branch mints a NEW
  //   token; the env block that would carry it is dropped by the `!env.has(key)`
  //   filter at the env section below, so .env.local keeps the OLD value while
  //   the printed `docker run` gets the new one. printSummary then states, in
  //   writing, "That token is the same one written to .env.local". It was not.
  //
  //   instrumentation.ts present and something else left to write — the branch
  //   never runs, plan.ingestToken stays null, and dashboardRunCommand omits
  //   `-e EVESTACK_INGEST_TOKEN` entirely while the agent's env file has one.
  //
  // Either way the two halves hold different values, and the dashboard's
  // ingestAuthorized() (packages/dashboard/lib/auth.ts:337) falls back to session
  // auth when the token does not match — which an OTLP exporter cannot satisfy.
  // @vercel/otel treats the resulting 401 as a successful export, so the only
  // symptom is a Traces tab that stays empty forever.
  const existingToken = env.get("EVESTACK_INGEST_TOKEN");
  if (existingToken) plan.ingestToken = existingToken;

  if (existingInstrumentation) {
    plan.skips.push([`agent/${existingInstrumentation}`, "you already have one — evestack does not overwrite it"]);
  } else if (wantTraces) {
    // Read NOW, not inside the write.
    //
    // instrumentationFile() calls templateDir(), which on a missing template
    // calls process.exit(1) — from inside a write, half way through the loop that
    // is supposed to end in an undo list. Reading it here means a broken install
    // is a refusal before anything is written, and the closure below only has a
    // string to put on disk.
    const instrumentation = instrumentationFile();
    add(
      "agent/instrumentation.ts",
      "trace export to the dashboard",
      "rm agent/instrumentation.ts",
      () => writeFileSync(join(target, "agent", "instrumentation.ts"), instrumentation),
    );
    // Minted only when the project has none, because there is no working
    // alternative to having one: the dashboard's ingest route takes this shared
    // secret or a session cookie, and an OTLP exporter cannot hold a session.
    // Unset on both sides, every span POST is a 401 — which @vercel/otel reports
    // to the agent as a successful export, so the only symptom is a permanently
    // empty Traces tab.
    //
    // Unlike `create-evestack`, attach writes no compose file for the dashboard,
    // so nothing carries this value across for you: the dashboard is started from
    // a clone with its own .env.local. printSummary() therefore echoes the line to
    // paste, which is the one manual step this secret costs.
    plan.ingestToken ??= randomBytes(32).toString("hex");
    envAdditions.push(
      ["", ""],
      ["", "# Dashboard trace export — the dashboard's own ingest route, not OTLP 4318"],
      ["EVESTACK_DASHBOARD_URL", dashboardIngest(dashboardPort)],
    );
    if (existingToken) {
      // The value is already in the file, so the block gets no key — and it must
      // not get the three explanatory comment lines either. `pending` above drops
      // keys the env file already has but keeps every comment, so pushing them
      // would append a paragraph about a variable that is not underneath it.
      plan.notes.push(
        `Reusing the EVESTACK_INGEST_TOKEN already in ${envFileName} — the dashboard command ` +
          `below carries that value, not a fresh one the agent would never send.`,
      );
    } else {
      envAdditions.push(
        ["", "# The exporter sends this as the `x-evestack-ingest-token` header. The"],
        ["", "# dashboard needs the SAME value in its own EVESTACK_INGEST_TOKEN, or it"],
        ["", "# 401s every span while the rest of the dashboard keeps working."],
        ["EVESTACK_INGEST_TOKEN", plan.ingestToken],
      );
    }
  } else {
    plan.notes.push("Skipping trace export — the dashboard still reads sessions, cost and approvals from Postgres.");
  }

  // Generated unconditionally, unlike the ingest token: trace export is optional
  // and this is not. The dashboard fails closed — with EVESTACK_AUTH_USER or
  // EVESTACK_AUTH_PASSWORD unset the setup printed below would hand you a
  // dashboard nobody can sign in to.
  //
  // The MECHANISM, because this comment used to state it wrongly. It said "503
  // on every route, including the sign-in page". FOUR path/method combinations
  // are exceptions, not two routes, because proxy.ts gates the sign-in tier on
  // the method rather than the path. Measured by importing
  // packages/dashboard/proxy.ts with both variables deleted from process.env:
  // `GET /signin`, `GET /api/auth/session`, `GET /api/auth/signout` and
  // `GET /api/health` pass the gate; `GET /`, `/sessions`, `/api/health/detail`,
  // `POST /signin`, `POST /api/auth/session`, `POST /api/auth/signout` and
  // `POST /api/ingest/v1/traces` are all 503. Of the four that pass, the two
  // /api/auth ones export POST only, so Next answers them with a bare 405, and
  // /api/health's handler answers 503 `{"status":"unconfigured"}` on its
  // own check, so the container still reports unhealthy. The sign-in page really
  // does render — and renders no form at all, only the error
  // (packages/dashboard/app/signin/page.tsx branches on authConfigured()), which
  // is why the conclusion above survives the correction and the reason for it
  // does not.
  //
  // Deliberately NOT written to the agent's env file. attach never wires
  // httpBasic into an existing project's channel — that project owns its own
  // auth — so these two are the dashboard's credentials alone, and writing them
  // next to the agent's config would imply a coupling that does not exist.
  plan.dashboardUser = "evestack";
  plan.dashboardPassword = randomBytes(18).toString("base64url");

  // ---- package.json --------------------------------------------------------
  const deps = { ...project.pkg.dependencies };
  const wantsPostgres = Boolean(plan.composeFile) || Boolean(plan.reusedCompose) || Boolean(existingUrl);
  const newDeps = [];
  if (wantsPostgres && !deps["@workflow/world-postgres"]) newDeps.push(["@workflow/world-postgres", WORLD_TAG]);
  if (wantTraces && !existingInstrumentation && !deps["@vercel/otel"]) newDeps.push(["@vercel/otel", OTEL_RANGE]);
  const wantsBootstrap = wantsPostgres && !project.pkg.scripts?.["db:bootstrap"];
  if (newDeps.length > 0 || wantsBootstrap) {
    const what = [
      newDeps.length > 0 ? `${newDeps.length} dependenc${newDeps.length === 1 ? "y" : "ies"}` : null,
      wantsBootstrap ? "the db:bootstrap script" : null,
    ].filter(Boolean).join(" + ");
    change(
      "package.json",
      what,
      `remove ${[...newDeps.map(([n]) => n), wantsBootstrap ? '"db:bootstrap"' : null].filter(Boolean).join(", ")}`,
      () => {
        const raw = readFileSync(project.pkgPath, "utf8");
        const pkg = JSON.parse(raw);
        if (newDeps.length > 0) {
          pkg.dependencies = sortedKeys({ ...pkg.dependencies, ...Object.fromEntries(newDeps) });
        }
        if (wantsBootstrap) {
          // Not `npx --package=@workflow/world-postgres bootstrap`: that CLI
          // loads .env through dotenv and never looks at .env.local, so it
          // falls back to postgres://world:world@localhost:5432/world and dies
          // on ECONNREFUSED. Naming the env file explicitly is the whole point.
          pkg.scripts = {
            ...pkg.scripts,
            "db:bootstrap": `node --env-file-if-exists=${envFileName} node_modules/@workflow/world-postgres/bin/setup.js`,
          };
        }
        // Reserialize with the indentation the file already used. A round trip
        // through JSON.stringify(…, 2) on a tab-indented manifest reformats
        // every line of it, which is a diff nobody asked attach for.
        writeFileSync(project.pkgPath, `${JSON.stringify(pkg, null, jsonIndent(raw))}\n`);
      },
    );
    plan.newDeps = newDeps;
  }

  // ---- env -----------------------------------------------------------------
  const pending = envAdditions.filter(([key]) => key === "" || !env.has(key));
  const realKeys = pending.filter(([key]) => key !== "");
  if (realKeys.length > 0) {
    const envPath = join(target, envFileName);
    const existed = existsSync(envPath);
    const verb = existed ? "change" : "add";
    const action = {
      path: envFileName,
      what: `${realKeys.length} key${realKeys.length === 1 ? "" : "s"}${existed ? " appended — existing values untouched" : ""}`,
      undo: existed ? `delete the "evestack attach" block from ${envFileName}` : `rm ${envFileName}`,
      write: () => {
        const before = existed ? readFileSync(envPath, "utf8") : "";
        // 0600. This block carries a generated Postgres password and, when trace
        // export is on, the ingest token — the two secrets the .gitignore line
        // below exists for. git was the only reader being kept out; the file
        // itself landed at the umask (0644 measured on this machine), so every
        // other account on a shared box could read what git could not.
        //
        // This is the append path as well as the create path, so the chmod half
        // of writeSecretFile() is the half that matters here: the file usually
        // already exists, and `mode` on writeFileSync applies only at O_CREAT.
        const warning = writeSecretFile(envPath, mergeEnvBlock(before, pending));
        if (warning) plan.alerts.push(warning);
      },
    };
    (verb === "add" ? plan.adds : plan.changes).push(action);
    plan.envKeys = realKeys.map(([key]) => key);
  }

  // ---- .gitignore ----------------------------------------------------------
  // The block above carries a generated database password. Committing it would
  // be this command's fault, not the user's — which is also why chooseEnvFile()
  // refuses to write it into a file git already tracks, where a .gitignore line
  // is a no-op.
  if (realKeys.length > 0 && !gitIgnores(target, envFileName)) {
    const gitignorePath = join(target, ".gitignore");
    if (existsSync(gitignorePath)) {
      change(
        ".gitignore",
        `ignore ${envFileName}`,
        `remove the ${envFileName} line`,
        () => {
          const before = readFileSync(gitignorePath, "utf8");
          const head = before && !before.endsWith("\n") ? `${before}\n` : before;
          writeFileSync(gitignorePath, `${head}\n# added by \`evestack attach\` — generated credentials live here\n${envFileName}\n`);
        },
      );
    } else if (existsSync(join(target, ".git"))) {
      add(
        ".gitignore",
        `ignore ${envFileName}`,
        "rm .gitignore",
        () => writeFileSync(gitignorePath, `# added by \`evestack attach\` — generated credentials live here\n${envFileName}\n`),
      );
    } else {
      warn(`${envFileName} will hold a generated password and this is not a git repository — do not commit it later.`);
    }
  }

  return plan;
}

function printPlan(plan) {
  const rows = [...plan.adds, ...plan.changes];
  const width = Math.max(0, ...rows.map((r) => r.path.length), ...plan.skips.map(([p]) => p.length));

  say();
  say(`  ${C.bold}Plan${C.reset}`);
  if (plan.adds.length > 0) {
    say(`  ${C.dim}add${C.reset}`);
    for (const r of plan.adds) say(`    ${C.green}+${C.reset} ${r.path.padEnd(width)}  ${C.dim}${r.what}${C.reset}`);
  }
  if (plan.changes.length > 0) {
    say(`  ${C.dim}change${C.reset}`);
    for (const r of plan.changes) say(`    ${C.cyan}~${C.reset} ${r.path.padEnd(width)}  ${C.dim}${r.what}${C.reset}`);
  }
  if (plan.skips.length > 0) {
    say(`  ${C.dim}skip${C.reset}`);
    for (const [p, why] of plan.skips) say(`    ${C.yellow}·${C.reset} ${p.padEnd(width)}  ${C.dim}${why}${C.reset}`);
  }
  if (rows.length === 0) say(`    ${C.dim}nothing — this project is already attached${C.reset}`);
  for (const note of plan.notes) dim(note);
  // Alerts print here, before the confirmation, because the whole point of one is
  // that the reader may want to stop.
  for (const alert of plan.alerts) {
    say();
    warn(alert);
  }
  if (plan.manual.length > 0) {
    say();
    say(`  ${C.bold}You will have to do this part by hand${C.reset}`);
    for (const [what, why] of plan.manual) say(`    ${C.yellow}!${C.reset} ${what} ${C.dim}— ${why}${C.reset}`);
  }
  say();
  dim("Nothing else in the project is read, moved or rewritten.");
}

function printSummary(plan) {
  const { pm, target } = plan;
  // The file the user runs `docker compose` against: the one written here, or the
  // one a previous attach wrote and this run decided to reuse.
  const composeTarget = plan.composeFile ?? plan.reusedCompose;
  const composeArgs = composeTarget ? composeFlag(composeTarget) : "";
  say();
  say(`${C.green}${C.bold}  Attached.${C.reset}`);
  say();
  say(`  ${C.bold}Next:${C.reset}`);
  // Quoted: a project at ~/My Agent printed `cd /Users/x/My Agent`, which is two
  // arguments and a command that does not work.
  say(`    cd ${shellQuote(target)}`);
  if (plan.newDeps?.length) say(`    ${pm} install`);
  if (composeTarget) {
    say(`    docker compose${composeArgs} up -d postgres        ${C.dim}# durable sessions${C.reset}`);
    say(`    ${pm} run db:bootstrap                 ${C.dim}# create the workflow schema — nothing else creates it${C.reset}`);
  }
  say(`    ${pm} run dev`);
  say();
  // The dashboard is the reason to attach at all, so it cannot be left to the
  // README. This used to print `git clone`, `cd evestack/packages/dashboard`,
  // `pnpm install && pnpm run dev` — three commands, and the last two do not
  // work: the install has to happen at the workspace ROOT for `workspace:*` to
  // resolve, and @evestack/schedules has to be built before Turbopack can find
  // its dist/. One `docker run` against the published image has none of that.
  //
  // A `docker run` rather than a compose service, because attach does not own
  // this project's compose file — it either wrote a Postgres-only one or found
  // one the user wrote, and merging a service into someone else's compose file
  // by service name is exactly the overwrite rule 2 forbids.
  say(`  ${C.bold}Then the dashboard${C.reset} ${C.dim}— sessions, cost, approvals, chat:${C.reset}`);
  for (const line of dashboardRunCommand(plan)) say(`    ${line}`);
  say();
  dim(`  Sign in at http://localhost:${plan.dashboardPort} with ${plan.dashboardUser} / ${plan.dashboardPassword}`);
  if (plan.ingestToken) {
    say();
    // The one value that MUST travel by hand. A `create-evestack` scaffold has
    // a compose service reading the agent's own .env.local, so both halves come
    // from one file; here there is no such file, and a dashboard whose
    // EVESTACK_INGEST_TOKEN differs from the agent's 401s every span without
    // either side saying so.
    //
    // "in", not "written to": on a re-run the token is the one already in that
    // file rather than one this run wrote, and the old wording asserted a match
    // that the code was not making — see the note above the instrumentation
    // section for the two ways it came apart.
    dim(`That token is the same one in ${plan.envFileName}. Both sides need it byte for`);
    dim("byte: the agent sends it as `x-evestack-ingest-token`, and a mismatch is a 401 on");
    dim('every span that shows up only as a Traces tab stuck on "no traces yet".');
  }
  say();

  if (plan.manual.length > 0) {
    say(`  ${C.bold}By hand:${C.reset}`);
    for (const [what, why] of plan.manual) {
      say(`    ${C.yellow}!${C.reset} ${what} ${C.dim}— ${why}${C.reset}`);
    }
    if (plan.manual.some(([what]) => what.startsWith("agent/"))) {
      say();
      dim("Paste this inside your defineAgent({ … }) call:");
      say(WORLD_SNIPPET.split("\n").map((l) => `      ${C.dim}${l}${C.reset}`).join("\n"));
    }
    if (plan.manual.some(([what]) => what === "Add Postgres yourself")) {
      say();
      dim("The compose service:");
      say(composeService({ envFileName: plan.envFileName, port: plan.port })
        .split("\n").map((l) => `      ${C.dim}${l}${C.reset}`).join("\n"));
    }
    say();
  }

  for (const alert of plan.alerts) {
    warn(alert);
    say();
  }

  say(`  ${C.bold}To undo:${C.reset}`);
  for (const action of [...plan.adds, ...plan.changes]) {
    say(`    ${action.path.padEnd(26)} ${C.dim}${action.undo}${C.reset}`);
  }
  say();
  dim("That list is the whole footprint. Follow it and the project is plain eve again.");
  say();
}

/**
 * What to print when a write fails part way through.
 *
 * The undo list is the promise this command makes, and a run that stops half way
 * is when it is worth most: some files have changed, the summary that would have
 * listed them never printed, and the user is left to guess. So the list is
 * printed for exactly the writes that landed — not the whole plan, which would
 * name files that were never touched.
 */
function printPartialSummary(written, failed, error) {
  say();
  say(`${C.red}${C.bold}  Stopped part way through.${C.reset}`);
  say();
  say(`  ${C.red}${failed.path}${C.reset} could not be written — ${error?.message ?? error}`);
  say();
  if (written.length === 0) {
    dim("Nothing was written before that, so there is nothing to undo.");
    say();
    dim("Fix what the message above says and run attach again.");
    say();
    return;
  }
  say(`  ${C.bold}Already written — undo these if you want the project back as it was:${C.reset}`);
  for (const action of written) {
    say(`    ${action.path.padEnd(26)} ${C.dim}${action.undo}${C.reset}`);
  }
  say();
  dim("Or fix what the message above says and run attach again: it skips what it already");
  dim("wrote and adds only the rest.");
  say();
}

async function confirmPlan() {
  const prompt = await makePrompter(false);
  const answer = await prompt.confirm("Write these changes?", true);
  prompt.close();
  return answer;
}

// ---------------------------------------------------------------------------
// generated files
// ---------------------------------------------------------------------------

const WORLD_SNIPPET = `// --- evestack attach ---------------------------------------------------------
// Durable sessions in your own Postgres instead of eve's on-disk world under
// .eve/.workflow-data. Conditional on purpose: with WORKFLOW_POSTGRES_URL unset
// this is exactly the agent you had before, so the change is safe to land
// before the database exists. Delete these lines to undo.
...(process.env.WORKFLOW_POSTGRES_URL
  ? { experimental: { workflow: { world: "@workflow/world-postgres" } } }
  : {}),
// -----------------------------------------------------------------------------`;

/**
 * Only extend an agent whose shape we can see whole.
 *
 * A regex is not a parser, so it gets one job and refuses everything else: a
 * single `defineAgent({` with a literal object, no `experimental` key already
 * present. Anything cleverer — a spread from a variable, two agents in a file,
 * a config built elsewhere — falls through to a printed snippet, which is
 * slower for the user and never wrong.
 */
function canInjectWorld(src) {
  const calls = src.match(/defineAgent\s*\(/g) ?? [];
  return calls.length === 1 && /defineAgent\s*\(\s*\{/.test(src) && !/experimental/.test(src);
}

/**
 * Insert the world snippet immediately after `defineAgent({`.
 *
 * THE SUBTLETY THAT BROKE THIS ONCE. The snippet's last line is a `//` comment
 * ruler, so anything already sitting on the same line as `defineAgent({` ends up
 * appended to that comment and is silently commented out. A compact agent —
 * `export default defineAgent({ model: openai("gpt-5-mini") });`, which is
 * exactly what a hand-written or minimal project looks like — came out of this
 * with no `model` property and an unclosed paren. The project no longer parsed,
 * and `attach` reported success.
 *
 * So the remainder of the line is captured and re-emitted on its own line
 * underneath. Verified against both a one-line agent and a multi-line one.
 */
function injectWorld(src) {
  return src.replace(/(defineAgent\s*\(\s*\{)([^\n]*)/, (_match, open, rest) => {
    const body = WORLD_SNIPPET.split("\n").map((line) => `  ${line}`).join("\n");
    const trailing = rest.trim();
    return trailing ? `${open}\n${body}\n  ${trailing}` : `${open}\n${body}`;
  });
}

/**
 * The dashboard exporter, copied verbatim from the agent template.
 *
 * Read rather than duplicated: this file has a long comment explaining the
 * trade-off it makes with eve's local trace spool, and two copies of that
 * explanation would disagree within a release.
 */
function instrumentationFile() {
  // `{ optional: true }` and a throw, not templateDir()'s default: the default
  // calls process.exit(1), and this used to be called from inside a write — so a
  // broken install tore the process down mid-loop, after some files had already
  // changed and before anything printed an undo list. A thrown Error reaches the
  // handler in index.mjs or src/cli.mjs and prints as one sentence.
  const dir = templateDir({ optional: true });
  if (!dir) {
    throw new Error(
      "Could not locate the agent template, so the instrumentation file cannot be copied.\n" +
        `  Reinstall create-evestack, or re-run without trace export.\n` +
        `  Please report this at ${REPO}/issues`,
    );
  }
  const source = join(dir, "agent", "instrumentation.ts");
  const body = readFileSync(source, "utf8");
  return (
    "// Added by `evestack attach`. Nothing else in the project imports it —\n" +
    "// deleting this file undoes the change completely.\n" +
    body
  );
}

function composeService({ envFileName, port }) {
  return `services:
  postgres:
    # pgvector rather than plain postgres: the same database can back
    # @evestack/memory later without a second container.
    image: pgvector/pgvector:pg17
    restart: unless-stopped
    # Docker's json-file driver has NO max-size and NO max-file by default, and
    # the line above is a promise to keep this container running for months. For
    # those months the daemon appends to
    # /var/lib/docker/containers/<id>/<id>-json.log with nothing rotating it, and
    # a full disk stops this Postgres, which stops the agent's sessions.
    #
    # 10 MB × 3 files is a 30 MB ceiling. Override LOG_MAX_SIZE / LOG_MAX_FILE in
    # the shell or a .env beside this file. Unprefixed on purpose: Compose
    # interpolates both on the HOST before parsing, so neither reaches the
    # container, and an EVESTACK_ name would claim the app reads it.
    # The \`env_file: ${envFileName}\` below is the other mechanism, and what
    # cannot serve here is that MECHANISM, not that file: env_file sets variables
    # inside the container, and this ceiling is the daemon's. Compose separately
    # auto-loads a \`.env\` beside this file for interpolation — so when
    # ${envFileName} IS that \`.env\` (attach writes to it whenever an untracked
    # one already exists), a LOG_MAX_SIZE line in it does apply, by interpolation.
    #
    # \`driver: json-file\` is stated rather than inherited. Without it the daemon's
    # default driver is used, and which options are legal depends on the driver —
    # max-size/max-file belong to json-file, so a host defaulting to journald or
    # awslogs would not apply them. Naming it is what makes this ceiling mean the
    # same thing on every machine.
    #
    # Written out rather than aliased from an \`x-logging\` anchor, which is what
    # the two-service file \`evestack create\` writes uses. There is one service
    # here, so an anchor would save nothing — and this same block is PRINTED for
    # you to paste into a compose file you already own (attach's "Add Postgres
    # yourself" branch). An alias whose anchor stayed behind in the terminal is
    # not a missing log ceiling, it is a file that will not parse: Compose v5.1.0
    # answers \`yaml: line N, column M: unknown anchor 'container-logs'
    # referenced\` and refuses the whole project.
    logging:
      driver: json-file
      options:
        max-size: "\${LOG_MAX_SIZE:-10m}"
        max-file: "\${LOG_MAX_FILE:-3}"
    environment:
      POSTGRES_USER: evestack
      POSTGRES_DB: evestack
    # POSTGRES_PASSWORD comes from ${envFileName}, which attach makes sure git
    # ignores. It used to be written into this file as plain text — and this file
    # is one you commit, so the password generated to keep a stranger out of your
    # agent's database went into git on the next \`git add -A\`.
    #
    # \`env_file:\` and not \`\${...}\`: interpolation reads the shell and .env, never
    # .env.local, so a \`\${POSTGRES_PASSWORD}\` here would fail the parse for every
    # project whose secrets live in .env.local. env_file sets the variable inside
    # the container, which is where Postgres reads it. The cost, stated plainly:
    # every other variable in that file is set in this container too.
    env_file:
      - ${envFileName}
    ports:
      # Loopback only. This container ends up holding every prompt, tool call
      # and result your agent has ever produced; "${port}:5432" would publish
      # that on every interface the host has.
      - "127.0.0.1:${port}:5432"
    volumes:
      - evestack-pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U evestack -d evestack"]
      interval: 3s
      timeout: 3s
      retries: 20
      start_period: 5s

volumes:
  evestack-pgdata:`;
}

/** ` -f <file>` for anything but the default compose filename, else "". */
function composeFlag(file) {
  return file === "docker-compose.yml" ? "" : ` -f ${file}`;
}

function composeFragment({ projectName, envFileName, port, file }) {
  const up = file === "docker-compose.yml" ? "docker compose up -d postgres" : `docker compose -f ${file} up -d postgres`;
  const down = file === "docker-compose.yml" ? "docker compose down -v" : `docker compose -f ${file} down -v`;
  return `# Postgres for this eve agent — added by \`evestack attach\`.
#
# Durable sessions live here instead of .eve/.workflow-data, and the evestack
# dashboard reads the same tables. Nothing here phones home.
#
#   ${up}
#
# Undo: ${down} (this also deletes the sessions), then delete this file.
#
# This file carries no password: POSTGRES_PASSWORD is read from the env file
# beside it, which attach keeps out of git. Commit this one freely.
#
# The project name carries a hash of this directory's absolute path, so two
# attached agents — even two both called "my-agent" — are two Compose projects
# with two volumes rather than one shared database. Move the directory and
# Compose stops recognising the containers and volume it made here; bring them up
# again and copy out of the old volume if you need what was in it.
name: ${projectName}

${composeService({ envFileName, port })}
`;
}

/**
 * The one command that brings the dashboard up against this project.
 *
 * Returned as lines rather than a string so the caller can indent them; every
 * line but the last ends in a backslash, so the block pastes into a shell as a
 * single command.
 *
 * Everything the dashboard fails closed without is passed explicitly. It has no
 * usable default for any of them: EVESTACK_AUTH_* missing means 503 on every
 * request but four GETs — `GET /signin` renders the misconfiguration with no
 * form on it, `GET /api/auth/session` and `GET /api/auth/signout` are POST-only
 * routes and answer 405, and `GET /api/health` reaches its handler, which
 * answers its own 503 `{"status":"unconfigured"}` — and EVESTACK_AGENT_URL
 * defaults to 127.0.0.1:2000, which inside a container is the container. (This
 * line used to say "503 on every route including the sign-in page", which is the
 * one route the gate deliberately lets through; see the note beside
 * plan.dashboardUser above for the measurement.)
 */
function dashboardRunCommand(plan) {
  const lines = [
    // The container name is per project, for the same reason the Compose project
    // name is: a second attached project on one machine got `docker run --name
    // evestack-dashboard` and "the container name is already in use", which is
    // the same collision the hardcoded port had.
    `docker run -d --name ${projectNameFor(plan.target)}-dashboard \\`,
    // 127.0.0.1 on purpose: this is a control plane that starts agent runs and
    // approves gated shell commands. `-p 4000:4000` would publish it on every
    // interface the host has.
    //
    // The host side is probed, not assumed: this was a hardcoded 4000, so on a
    // machine already running one evestack dashboard the command failed with
    // "port is already allocated". The container side stays 4000 — that is where
    // the dashboard listens inside its own namespace.
    `  -p 127.0.0.1:${plan.dashboardPort}:4000 \\`,
    // Docker Desktop resolves host.docker.internal already; on Linux nothing
    // does unless this flag adds it, and there the agent is otherwise
    // unreachable from the container.
    "  --add-host host.docker.internal:host-gateway \\",
    // The same 30 MB log ceiling both generated compose files carry, for the same
    // reason: `docker run -d` with the default json-file driver rotates nothing,
    // so a dashboard left up for months grows one unbounded
    // /var/lib/docker/containers/<id>/<id>-json.log until the disk is full.
    //
    // `--log-driver json-file` is not redundant with the daemon default. Which
    // `--log-opt` keys are legal depends on the driver, and max-size/max-file
    // belong to json-file and local — a host whose daemon defaults to journald
    // or awslogs would not quietly ignore them, it would refuse the run. Naming
    // the driver is what makes this command mean the same thing on every host,
    // which is the same reason both compose files state it instead of inheriting.
    "  --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \\",
    `  -e WORKFLOW_POSTGRES_URL='${fromContainer(plan.dbUrl)}' \\`,
    // `eve dev` listens on 2000 and auto-increments if that port is taken, so
    // this is the first free port from 2000 at the time attach ran — or
    // EVESTACK_AGENT_PORT if the project records one. Read eve's startup log and
    // change this if it landed somewhere else.
    `  -e EVESTACK_AGENT_URL=http://host.docker.internal:${plan.agentPort} \\`,
    `  -e EVESTACK_AUTH_USER=${plan.dashboardUser} \\`,
    `  -e EVESTACK_AUTH_PASSWORD='${plan.dashboardPassword}' \\`,
  ];
  // The third path 30b4de4 missed.
  //
  // That commit gave the mount and the variable that points at it to the repo's
  // own docker-compose.yml and to the compose file `create` generates
  // (create.mjs:1268 and :1289). This `docker run` is the only other place a dashboard
  // gets started by something in this repo, and it did not get either half — so
  // an attached project's Skills page scanned the template skills baked into the
  // image and reported on files nobody is running. lib/skills.ts's fallback
  // always resolves inside the container, and the skill it finds there is called
  // `memory-hygiene`, so the page looks like it is reading yours.
  //
  // Why that page and not another: eve advertises every skill in agent/skills/ to
  // the model beside a `load_skill` tool, so anything in that directory can put
  // instructions into a live turn without a human seeing them first. Scanning the
  // wrong directory is a clean verdict about the wrong files.
  //
  // Read-only, matching both compose files: the dashboard has no reason to write
  // here, and this container already holds a database URL and can start runs.
  //
  // Conditional, unlike the compose files — those are generated beside a template
  // that always ships agent/skills, and attach wraps a project someone else laid
  // out. `docker run -v` on a host path that does not exist CREATES it, root-owned
  // on Linux, which is a directory attach would be adding to a project it promises
  // only to add to reversibly. No directory, no mount: the page then says
  // "bundled template" with the path, which is at least true.
  const skillsDir = join(plan.target, "agent", "skills");
  if (existsSync(skillsDir)) {
    lines.push(
      "  -e EVESTACK_SKILLS_DIR=/agent-skills \\",
      `  -v ${shellQuote(skillsDir)}:/agent-skills:ro \\`,
    );
  }
  // Quoted because this value stopped being ours. It used to be a freshly
  // minted hex string, where quoting was cosmetic; now that attach reuses the
  // token already in the project's .env.local, it is whatever the operator put
  // there. A trailing comment comments out the line-continuation backslash and
  // breaks the printed command; a value containing $(...) runs it.
  if (plan.ingestToken) lines.push(`  -e EVESTACK_INGEST_TOKEN=${shellQuote(plan.ingestToken)} \\`);
  lines.push(`  ${DASHBOARD_IMAGE}`);
  return lines;
}

/**
 * The same Postgres URL, as seen from inside a container.
 *
 * The env file says 127.0.0.1 because the AGENT runs on the host. A container's
 * 127.0.0.1 is the container, so the identical string reaches nothing and the
 * dashboard comes up with an empty session list and ECONNREFUSED in its log —
 * a failure that looks like "the dashboard is broken" rather than like a
 * networking mistake. A database that is already remote is left exactly as
 * written; it is reachable from anywhere and rewriting it would be wrong.
 */
function fromContainer(url) {
  if (!url) return "postgres://evestack:evestack@host.docker.internal:5433/evestack";
  return url.replace(/@(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(?=[:/]|$)/, "@host.docker.internal");
}

function envLines(pending) {
  return pending.map(([key, value]) => (key === "" ? value : `${key}=${value}`));
}

function envBlock(pending) {
  return [
    BLOCK_START,
    "# Added by `evestack attach`. Delete this block to undo.",
    ...envLines(pending),
    BLOCK_END,
    "",
  ].join("\n");
}

/**
 * Put the new keys in the block that is already there, or start one.
 *
 * BLOCK_START and BLOCK_END were written and never read, so a second run that had
 * anything at all to add appended a second complete block. That is not
 * hypothetical: delete one key from the block and re-run — the same file then had
 * two "# --- evestack attach ---" blocks, and the undo instruction attach prints
 * ("delete the evestack attach block") no longer identified one thing.
 *
 * The existing block's contents are left exactly as they are, including any value
 * the user edited: only lines for keys that are missing from the whole file reach
 * this function, and they are inserted before the end marker rather than
 * replacing anything.
 *
 * A start marker with no end marker after it — a hand-truncated file — is treated
 * as no block at all, and a well-formed one is appended. Guessing where somebody
 * else's edit ended is worse than one extra ruler.
 */
function mergeEnvBlock(before, pending) {
  const start = before.lastIndexOf(BLOCK_START);
  const end = start === -1 ? -1 : before.indexOf(BLOCK_END, start);
  if (start === -1 || end === -1) {
    const head = before && !before.endsWith("\n") ? `${before}\n` : before;
    return `${head}${envBlock(pending)}`;
  }
  const body = `${envLines(pending).join("\n")}\n`;
  return `${before.slice(0, end)}${body}${before.slice(end)}`;
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function firstExisting(root, dir, names) {
  return names.find((n) => existsSync(join(root, dir, n))) ?? null;
}

function readdirNames(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function readEnvFiles(target) {
  // .env.local last: eve loads both and the local file wins, so the merged view
  // has to agree with what the agent will actually see.
  const merged = new Map();
  for (const file of [".env", ".env.local"]) {
    const path = join(target, file);
    if (!existsSync(path)) continue;
    // `/\r?\n/`, not `"\n"`, and the difference is a second database.
    //
    // In JavaScript `.` does not match CR and `$` without the `m` flag anchors
    // to end of input, so against a CRLF file every line ends in a character
    // the pattern cannot consume and NOTHING matches — this returned an empty
    // Map for the whole file. Measured: 0 of 2 lines parsed on CRLF, 2 of 2 on
    // LF. A .env written on Windows, or checked out with `core.autocrlf=true`,
    // is enough.
    //
    // What an empty Map causes, in the two places it is read:
    //   :420 `existingUrl` is undefined, so attach takes the else branch and
    //        adds its own Postgres — the case the comment there says must not
    //        happen, because "a second Postgres would split the session history
    //        in half and neither half would be complete".
    //   :703 every key looks absent, so the block appended to the env file
    //        re-declares keys that are already in it — and later wins, so the
    //        new container's URL silently overrides the project's real one.
    //
    // The sibling readers in evestack-cli/src/project.mjs and
    // templates/default/scripts/checks.mjs `.trim()` each line and were never
    // affected. This one matched the raw line.
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
      if (!match) continue;
      merged.set(match[1], match[2].trim().replace(/^["']|["']$/g, ""));
    }
  }
  return merged;
}

/**
 * Run a git command in the project and say whether it succeeded.
 *
 * `stdio: "ignore"` because only the exit code matters, and `error` is checked
 * separately: a machine without git on PATH gives `spawnSync` an error rather
 * than a status, and treating that as "no" would be reading a failure as an
 * answer.
 */
function git(target, args) {
  const result = spawnSync("git", args, { cwd: target, stdio: "ignore" });
  return { ran: !result.error, ok: result.status === 0 };
}

/**
 * Is git tracking this file?
 *
 * The question gitIgnores() below cannot answer, and the one that matters most:
 * .gitignore does nothing for a file that is already in the index, so appending a
 * generated password to a TRACKED .env and then adding `.env` to .gitignore — the
 * exact sequence attach performed — leaves the password staged into the next
 * `git commit -a`. Pattern matching cannot see that; only the index can.
 *
 * When git cannot be asked at all, the answer depends on whether there is
 * anything to commit to: inside a repository, assume tracked (the cautious
 * answer, which costs a fallback to another file); outside one, nothing can be
 * committed, so untracked is simply true.
 */
function isTracked(target, fileName) {
  const { ran, ok } = git(target, ["ls-files", "--error-unmatch", "--", fileName]);
  if (!ran) return existsSync(join(target, ".git"));
  return ok;
}

/**
 * The file attach appends generated credentials to.
 *
 * Never a tracked one. This used to be ".env.local if it exists, else .env if
 * that exists", and a project with a committed `.env` of non-secret defaults and
 * no .env.local got a generated database password and an ingest token appended
 * straight into a tracked file — with `.env` then added to .gitignore, which for
 * a tracked file changes nothing at all.
 *
 * Only these two names are candidates because they are the only two eve loads: a
 * secret written anywhere else would be ignored by the agent, which is a
 * different bug with the same appearance. If both exist and both are tracked
 * there is nowhere safe left, and that is a refusal rather than a quiet write —
 * see the message for the one command that fixes it.
 */
function chooseEnvFile(target) {
  const local = join(target, ".env.local");
  const plain = join(target, ".env");
  if (existsSync(local) && !isTracked(target, ".env.local")) return ".env.local";
  if (existsSync(plain) && !isTracked(target, ".env")) return ".env";
  // Neither existing candidate is safe. A file that does not exist yet cannot be
  // tracked, so preferring .env.local here is both safe and what eve prefers.
  if (!existsSync(local)) {
    if (existsSync(plain)) {
      warn(".env is tracked by git, so the generated credentials go in .env.local instead.");
      dim("eve loads both and .env.local wins, so your existing .env keeps working.");
    }
    return ".env.local";
  }
  throw new Error(
    `.env.local is tracked by git, so the credentials attach generates would be committed.\n` +
      `  Take it out of the index first — the file stays on disk:\n` +
      `    git rm --cached .env.local\n` +
      `  Then add .env.local to .gitignore and run attach again.`,
  );
}

/**
 * Does git ignore this file?
 *
 * `git check-ignore` first, because it is the exact answer: it knows nested
 * .gitignore files, .git/info/exclude and core.excludesFile, none of which the
 * pattern matcher below can see. The matcher stays for the case where git cannot
 * be asked — no git on PATH, or a directory that is not a repository — where
 * being wrong costs one duplicate line in a .gitignore.
 */
function gitIgnores(target, fileName) {
  if (existsSync(join(target, ".git"))) {
    const { ran, ok } = git(target, ["check-ignore", "--quiet", "--", fileName]);
    if (ran) return ok;
  }
  const path = join(target, ".gitignore");
  if (!existsSync(path)) return false;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const pattern = line.replace(/^\/+/, "").replace(/\/+$/, "");
    const rx = new RegExp(`^${pattern.split("*").map(escapeRegex).join(".*")}$`);
    if (rx.test(fileName)) return true;
  }
  return false;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A port a project recorded, or null if it recorded nothing usable.
 *
 * Env files are hand-editable, so "2041 " and "" and "not-a-port" all arrive
 * here; only a plain port number is an answer.
 */
function recordedPort(value) {
  const port = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
}

/**
 * A Postgres a previous `attach` already put in this project, if there is one.
 *
 * Identified by the volume name attach writes, `evestack-pgdata`, which is what
 * makes this a question about OUR compose file rather than about any Postgres the
 * user happens to run. Both spellings of the password are recognised: the plain
 * text one older versions wrote into the compose file (recoverable, and worth
 * recovering — the volume was initialised with it), and the current `env_file:`
 * form, where the value lives in an env file that a fresh clone does not have.
 *
 * The published port is read back for the same reason: reusing the file means
 * reusing the port it publishes, not the free one this run happened to find.
 */
function findEvestackPostgres(target) {
  for (const file of ["docker-compose.evestack.yml", ...COMPOSE_NAMES]) {
    const path = join(target, file);
    if (!existsSync(path)) continue;
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    if (!text.includes("evestack-pgdata")) continue;
    const password = /^\s*POSTGRES_PASSWORD:\s*"?([^"\n]+?)"?\s*$/m.exec(text)?.[1] ?? null;
    const port = recordedPort(/^\s*-\s*"127\.0\.0\.1:(\d+):5432"/m.exec(text)?.[1]);
    return {
      file,
      // An interpolation reference is not a password.
      password: password && !password.includes("${") ? password : null,
      port,
    };
  }
  return null;
}

function jsonIndent(raw) {
  const match = /\n([ \t]+)"/.exec(raw);
  return match ? match[1] : 2;
}

function sortedKeys(object) {
  return Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
}

function minVersion(range) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(range ?? "");
  return match ? match[0] : null;
}

/**
 * Compare two versions. Returns <0, 0 or >0; any prerelease sorts below the
 * release it precedes.
 *
 * The previous version split on "." and mapped Number, which turns
 * "0.30.1-beta.1" into [0, 30, NaN, 1]. NaN !== 2 is true, so it took the
 * branch — and then `NaN < 2` is *false*, so it returned 1: "0.30.1-beta.1 is
 * newer than 0.30.2".
 *
 * That is not a cosmetic ordering bug. `installed` is read verbatim out of
 * node_modules/eve/package.json, so a user on any 0.30.x prerelease below
 * 0.30.2 silently skipped the `< 0` branch at the call site and was never shown
 * the warning that eve's localDev() matched an unanchored /^127\./ against the
 * Host header — meaning `127.evil.com` resolved to an unauthenticated
 * principal. The check that exists to catch that release range reported it as
 * newer than certified.
 *
 * Mirrors contract/lib/semver.mjs `compare()`, which is correct but lives
 * outside the published package and cannot be imported from here.
 */
export function compareVersions(a, b) {
  const parse = (value) => {
    const match = /^\D*(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(value ?? ""));
    if (match === null) return null;
    return {
      release: [Number(match[1]), Number(match[2]), Number(match[3])],
      prerelease: match[4] ?? null,
    };
  };

  const left = parse(a);
  const right = parse(b);
  // Unparseable input must not silently claim an ordering. The call site
  // already handles "could not read a version number out of that range".
  if (left === null || right === null) return 0;

  for (let i = 0; i < 3; i += 1) {
    if (left.release[i] !== right.release[i]) return left.release[i] < right.release[i] ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}


