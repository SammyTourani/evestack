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
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import {
  basename, C, DASHBOARD_IMAGE, DASHBOARD_IMAGE_PUBLISHED, detectPm, dim, makePrompter,
  ok, REPO, say, step, templateDir, warn,
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
const DASHBOARD_INGEST = "http://localhost:4000/api/ingest/v1/traces";

const COMPOSE_NAMES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];
const AGENT_ENTRIES = ["agent.ts", "agent.tsx", "agent.mts", "agent.js", "agent.mjs"];
const INSTRUMENTATION_ENTRIES = [
  "instrumentation.ts", "instrumentation.tsx", "instrumentation.mts",
  "instrumentation.js", "instrumentation.mjs",
];

const BLOCK_START = "# --- evestack attach ---------------------------------------------------------";
const BLOCK_END = "# --- end evestack attach -----------------------------------------------------";

export async function attach(argv) {
  const flags = argv.filter((a) => a.startsWith("-"));
  const positional = argv.filter((a) => !a.startsWith("-"));
  const yes = flags.includes("--yes") || flags.includes("-y");
  const dryRun = flags.includes("--dry-run") || flags.includes("-n");

  const name = positional[0] ?? ".";
  const target = isAbsolute(name) ? name : resolve(process.cwd(), name);

  say();
  say(`${C.cyan}${C.bold}  evestack attach${C.reset} ${C.dim}— add the control plane to an eve project you already have${C.reset}`);
  say();

  const project = detectEveProject(target);
  step(`Attaching ${C.bold}${target}${C.reset}`);
  reportEveVersion(project);

  const pm = detectPm(target);
  const env = readEnvFiles(target);
  const envFileName = existsSync(join(target, ".env.local"))
    ? ".env.local"
    : existsSync(join(target, ".env"))
      ? ".env"
      : ".env.local";

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

  // Resolved before the plan is built so the plan can name the port it will
  // publish on rather than promising 5433 and using something else.
  const port = await freePort(5433);
  const plan = buildPlan({ target, project, env, envFileName, pm, wantTraces, existingInstrumentation, port });
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
  for (const action of [...plan.adds, ...plan.changes]) {
    action.write();
    ok(`${action.path} ${C.dim}${action.what}${C.reset}`);
  }

  printSummary(plan);
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

function buildPlan({ target, project, env, envFileName, pm, wantTraces, existingInstrumentation, port }) {
  const plan = {
    target, pm, envFileName, port,
    adds: [], changes: [], skips: [], manual: [], notes: [],
    dbUrl: null, composeFile: null,
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
    // Generated, never defaulted. This database ends up holding every prompt
    // and tool result the agent has produced, and a shipped default password on
    // a published port is the only thing between a stranger and all of it.
    const password = randomBytes(18).toString("base64url");
    // 127.0.0.1, never "localhost": the port is published on the loopback IPv4
    // address only, and a resolver that answers localhost with ::1 first turns
    // a working stack into ECONNREFUSED.
    plan.dbUrl = `postgres://evestack:${password}@127.0.0.1:${port}/evestack`;

    const existingCompose = COMPOSE_NAMES.find((n) => existsSync(join(target, n)));
    if (!existingCompose) {
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
      const projectName = composeProjectName(project.pkg.name ?? basename(target));
      add(
        plan.composeFile,
        `Postgres 17 (pgvector) on 127.0.0.1:${port}`,
        `docker compose${plan.composeFile === "docker-compose.yml" ? "" : ` -f ${plan.composeFile}`} down -v, then rm ${plan.composeFile}`,
        () => writeFileSync(join(target, plan.composeFile), composeFragment({
          projectName, password, port, file: plan.composeFile,
        })),
      );
      envAdditions.push(
        ["", ""],
        ["", `# Durable sessions — the Postgres in ${plan.composeFile}`],
        ["WORKFLOW_POSTGRES_URL", plan.dbUrl],
        ["", "# world-postgres defaults to concurrency 50 against a pool of 10 and warns"],
        ["", "# about it on every boot. Matching them silences it."],
        ["WORKFLOW_POSTGRES_MAX_POOL_SIZE", "20"],
        ["WORKFLOW_POSTGRES_WORKER_CONCURRENCY", "20"],
      );
    } else {
      plan.manual.push([
        "Add Postgres yourself",
        `Both compose files exist. The service block evestack would have written is printed below;\n` +
          `    add it, then put WORKFLOW_POSTGRES_URL in ${envFileName}.`,
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
  if (existingInstrumentation) {
    plan.skips.push([`agent/${existingInstrumentation}`, "you already have one — evestack does not overwrite it"]);
  } else if (wantTraces) {
    add(
      "agent/instrumentation.ts",
      "trace export to the dashboard",
      "rm agent/instrumentation.ts",
      () => writeFileSync(join(target, "agent", "instrumentation.ts"), instrumentationFile()),
    );
    // Generated here, and it has to be, because there is no working alternative:
    // the dashboard's ingest route takes this shared secret or a session cookie,
    // and an OTLP exporter cannot hold a session. Unset on both sides, every span
    // POST is a 401 — which @vercel/otel reports to the agent as a successful
    // export, so the only symptom is a permanently empty Traces tab.
    //
    // Unlike `create-evestack`, attach writes no compose file for the dashboard,
    // so nothing carries this value across for you: the dashboard is started from
    // a clone with its own .env.local. printSummary() therefore echoes the line to
    // paste, which is the one manual step this secret costs.
    plan.ingestToken = randomBytes(32).toString("hex");
    envAdditions.push(
      ["", ""],
      ["", "# Dashboard trace export — the dashboard's own ingest route, not OTLP 4318"],
      ["EVESTACK_DASHBOARD_URL", DASHBOARD_INGEST],
      ["", "# The exporter sends this as the `x-evestack-ingest-token` header. The"],
      ["", "# dashboard needs the SAME value in its own EVESTACK_INGEST_TOKEN, or it"],
      ["", "# 401s every span while the rest of the dashboard keeps working."],
      ["EVESTACK_INGEST_TOKEN", plan.ingestToken],
    );
  } else {
    plan.notes.push("Skipping trace export — the dashboard still reads sessions, cost and approvals from Postgres.");
  }

  // Generated unconditionally, unlike the ingest token: trace export is optional
  // and this is not. The dashboard fails closed — with EVESTACK_AUTH_USER or
  // EVESTACK_AUTH_PASSWORD unset it answers 503 on every route, including the
  // sign-in page, so the setup printed below would hand you a dashboard that
  // cannot be opened at all.
  //
  // Deliberately NOT written to the agent's env file. attach never wires
  // httpBasic into an existing project's channel — that project owns its own
  // auth — so these two are the dashboard's credentials alone, and writing them
  // next to the agent's config would imply a coupling that does not exist.
  plan.dashboardUser = "evestack";
  plan.dashboardPassword = randomBytes(18).toString("base64url");

  // ---- package.json --------------------------------------------------------
  const deps = { ...project.pkg.dependencies };
  const wantsPostgres = Boolean(plan.composeFile) || Boolean(existingUrl);
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
        const head = before && !before.endsWith("\n") ? `${before}\n` : before;
        writeFileSync(envPath, `${head}${envBlock(pending)}`);
      },
    };
    (verb === "add" ? plan.adds : plan.changes).push(action);
    plan.envKeys = realKeys.map(([key]) => key);
  }

  // ---- .gitignore ----------------------------------------------------------
  // The block above carries a generated database password. Committing it would
  // be this command's fault, not the user's.
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
  const composeArgs = plan.composeFile && plan.composeFile !== "docker-compose.yml" ? ` -f ${plan.composeFile}` : "";
  say();
  say(`${C.green}${C.bold}  Attached.${C.reset}`);
  say();
  say(`  ${C.bold}Next:${C.reset}`);
  say(`    cd ${target}`);
  if (plan.newDeps?.length) say(`    ${pm} install`);
  if (plan.composeFile) {
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
  dim(`  Sign in at http://localhost:4000 with ${plan.dashboardUser} / ${plan.dashboardPassword}`);
  if (plan.ingestToken) {
    say();
    // The one value that MUST travel by hand. A `create-evestack` scaffold has
    // a compose service reading the agent's own .env.local, so both halves come
    // from one file; here there is no such file, and a dashboard whose
    // EVESTACK_INGEST_TOKEN differs from the agent's 401s every span without
    // either side saying so.
    dim(`That token is the same one written to ${plan.envFileName}. Both sides need it byte for`);
    dim("byte: the agent sends it as `x-evestack-ingest-token`, and a mismatch is a 401 on");
    dim('every span that shows up only as a Traces tab stuck on "no traces yet".');
  }
  if (!DASHBOARD_IMAGE_PUBLISHED) {
    say();
    warn(`${DASHBOARD_IMAGE} is not published yet, so that`);
    warn("pull fails with `manifest unknown`. Until the first release, build that exact");
    warn("tag once and docker will find it locally:");
    say();
    say(`    git clone ${REPO}`);
    say(`    docker build -t ${DASHBOARD_IMAGE} \\`);
    say("      -f evestack/packages/dashboard/Dockerfile evestack");
    say();
    dim("The context is the repo ROOT, not packages/dashboard — the dashboard resolves a");
    dim("pnpm `workspace:*` dependency that only exists against the root lockfile. Delete");
    dim("the clone afterwards if you like; the image stays.");
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
      say(composeService({ password: randomBytes(18).toString("base64url"), port: plan.port })
        .split("\n").map((l) => `      ${C.dim}${l}${C.reset}`).join("\n"));
    }
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
  const source = join(templateDir(), "agent", "instrumentation.ts");
  const body = readFileSync(source, "utf8");
  return (
    "// Added by `evestack attach`. Nothing else in the project imports it —\n" +
    "// deleting this file undoes the change completely.\n" +
    body
  );
}

function composeService({ password, port }) {
  return `services:
  postgres:
    # pgvector rather than plain postgres: the same database can back
    # @evestack/memory later without a second container.
    image: pgvector/pgvector:pg17
    restart: unless-stopped
    environment:
      POSTGRES_USER: evestack
      POSTGRES_PASSWORD: "${password}"
      POSTGRES_DB: evestack
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

function composeFragment({ projectName, password, port, file }) {
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
# The project name is derived from package.json so two attached agents on one
# machine get two databases instead of quietly sharing one volume.
name: ${projectName}

${composeService({ password, port })}
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
 * route including the sign-in page, and EVESTACK_AGENT_URL defaults to
 * 127.0.0.1:2000, which inside a container is the container.
 */
function dashboardRunCommand(plan) {
  const lines = [
    "docker run -d --name evestack-dashboard \\",
    // 127.0.0.1 on purpose: this is a control plane that starts agent runs and
    // approves gated shell commands. `-p 4000:4000` would publish it on every
    // interface the host has.
    "  -p 127.0.0.1:4000:4000 \\",
    // Docker Desktop resolves host.docker.internal already; on Linux nothing
    // does unless this flag adds it, and there the agent is otherwise
    // unreachable from the container.
    "  --add-host host.docker.internal:host-gateway \\",
    `  -e WORKFLOW_POSTGRES_URL='${fromContainer(plan.dbUrl)}' \\`,
    // `eve dev` listens on 2000 and auto-increments if that port is taken —
    // read its startup log and change this if it landed somewhere else.
    "  -e EVESTACK_AGENT_URL=http://host.docker.internal:2000 \\",
    `  -e EVESTACK_AUTH_USER=${plan.dashboardUser} \\`,
    `  -e EVESTACK_AUTH_PASSWORD='${plan.dashboardPassword}' \\`,
  ];
  if (plan.ingestToken) lines.push(`  -e EVESTACK_INGEST_TOKEN=${plan.ingestToken} \\`);
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

function envBlock(pending) {
  const lines = [BLOCK_START, "# Added by `evestack attach`. Delete this block to undo."];
  for (const [key, value] of pending) {
    lines.push(key === "" ? value : `${key}=${value}`);
  }
  lines.push(BLOCK_END, "");
  return `${lines.join("\n")}`;
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
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
      if (!match) continue;
      merged.set(match[1], match[2].trim().replace(/^["']|["']$/g, ""));
    }
  }
  return merged;
}

/**
 * Does .gitignore already cover this file?
 *
 * Deliberately conservative and pattern-level only — `git check-ignore` would
 * be exact but needs git on PATH and a repository, and being wrong here in the
 * safe direction only costs a duplicate line.
 */
function gitIgnores(target, fileName) {
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

function composeProjectName(name) {
  const slug = name.replace(/^@/, "").replace(/[^a-zA-Z0-9_-]+/g, "-").toLowerCase().replace(/^-+|-+$/g, "");
  return `evestack-${slug || "agent"}`;
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

/**
 * The first port from `start` that nothing answers on.
 *
 * Docker's own error for a taken port is `Bind for 0.0.0.0:5433 failed`, which
 * arrives minutes later at `docker compose up`. Worse is the case where it does
 * NOT fail: a second attached project pointed at the first project's database,
 * reading someone else's sessions. Probing loopback misses a port bound only to
 * another interface — that case still gets docker's error, just not ours.
 */
async function freePort(start) {
  for (let port = start; port < start + 20; port += 1) {
    if (!(await portAnswers(port))) return port;
  }
  return start;
}

function portAnswers(port) {
  return new Promise((res) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (answered) => {
      socket.destroy();
      res(answered);
    };
    socket.setTimeout(400);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}
