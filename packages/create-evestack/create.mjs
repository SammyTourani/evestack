/**
 * The scaffolding wizard — the implementation behind BOTH front doors.
 *
 *   npx create-evestack my-agent   -> index.mjs (this package's bin)
 *   evestack create my-agent       -> @evestack/cli's `evestack` bin, which
 *                                     imports `create-evestack/create`
 *
 * Two published names, one copy of this file. The alternative — an `evestack`
 * package carrying its own scaffolder — is two implementations that drift, and
 * the drift is invisible until someone reports a bug that was already fixed on
 * the other side.
 *
 * Which package holds the implementation is not arbitrary. It is this one,
 * because this one is dependency-free and already carries `template/`;
 * `evestack` depends on `pg` for `doctor`, and inverting the edge would put a
 * Postgres driver in front of every first-time `npx create-evestack`.
 *
 * Deliberately dependency-free. A scaffolder that installs a prompt library
 * before it can ask its first question is slower than the thing it scaffolds,
 * and every dependency here is one more supply-chain surface for a tool that
 * writes files and credentials.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  basename, C, DASHBOARD_IMAGE, detectPm, dim, freePort, makePrompter, ok,
  packageVersion, REPO, say, shellQuote, step, templateDir, warn,
} from "./shared.mjs";

/* -------------------------------------------------------------------------- */
/* bringing it up                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Ask before starting anything.
 *
 * Only on a terminal. In CI, in a heredoc, or under `--yes`, "would you like me
 * to start containers" has no one to answer it, and a scaffolder that pulls a
 * 200 MB image because nobody was there to say no is a scaffolder people stop
 * running unattended.
 */
async function confirmStart() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const { confirm, close } = await makePrompter(false);
  const yes = await confirm(
    `Start Postgres, create the schema and pull the dashboard now? ${C.dim}(~200 MB)${C.reset}`,
    true,
  );
  close();
  return yes;
}

/**
 * Run a command in the project, streaming its output. Returns true on exit 0.
 *
 * `shell` on Windows only, and not for cosmetic consistency: `npm`, `pnpm`,
 * `yarn` and `bun` are installed there as `.cmd` shims, which CreateProcess
 * cannot execute, so a bare spawn fails with ENOENT before the package manager
 * runs at all. templates/default/scripts/dev.mjs and start.mjs already pass
 * exactly this for exactly this reason. Every argument this file passes is a
 * literal without spaces, which is what makes the shell safe to use here.
 *
 * NOT VERIFIED ON WINDOWS — there is no Windows machine in this loop. The claim
 * being matched is the one the template's own scripts already make.
 */
function run(cwd, command, args) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  return result.status === 0;
}

/**
 * The three commands that have one correct answer, in the order they depend on
 * each other, stopping at the first failure.
 *
 * Each step says what it is doing first, because `docker compose up` on a cold
 * machine is a long silence followed by a wall of layer hashes, and a reader
 * who does not know which of the four steps they are in cannot tell a slow pull
 * from a hang.
 */
async function bringUp(target, pm, dashboardPort) {
  say();
  step("Starting Postgres");
  if (!run(target, "docker", ["compose", "up", "-d", "--wait", "postgres"])) {
    warn("Postgres did not come up. The commands below will show you why.");
    return false;
  }
  ok("Postgres is up");

  step("Creating the workflow schema");
  if (!run(target, pm, ["run", "db:bootstrap"])) {
    warn("The schema was not created. Fix what it printed, then re-run it.");
    return false;
  }

  step(`Pulling and starting the dashboard on :${dashboardPort}`);
  if (!run(target, "docker", ["compose", "--profile", "dashboard", "up", "-d", "--wait"])) {
    warn("The dashboard did not start. `docker compose logs dashboard` has the reason.");
    warn("Everything else is up — the agent works without it.");
    return false;
  }
  ok(`Dashboard is up on :${dashboardPort}`);
  return true;
}

function hasDocker() {
  const r = spawnSync("docker", ["info"], { stdio: "ignore" });
  return r.status === 0;
}

function hasOllama() {
  return spawnSync("ollama", ["--version"], { stdio: "ignore" }).status === 0;
}

/**
 * What is actually available from the local Ollama, asked over its HTTP API.
 *
 * `ollama list` would need the CLI to be the same install the agent will talk
 * to; the agent uses OLLAMA_BASE_URL, so this asks the same endpoint the agent
 * will. A tag matches with or without an explicit `:latest`, because `qwen3`
 * and `qwen3:latest` are the same model and the user may have pulled either
 * spelling.
 */
async function inspectOllama(chatModel, embedModel = "nomic-embed-text") {
  const baseUrl = process.env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434";
  const result = {
    baseUrl,
    installed: hasOllama(),
    running: false,
    hasChatModel: false,
    hasEmbedModel: false,
  };
  try {
    const response = await fetch(new URL("/api/tags", baseUrl), {
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return result;
    const body = await response.json();
    result.running = true;
    // Reaching the API proves Ollama is there even if its CLI is not on PATH —
    // a remote OLLAMA_BASE_URL, or a GUI install that never linked the binary.
    result.installed = true;
    const tags = new Set(
      (Array.isArray(body?.models) ? body.models : []).flatMap((m) =>
        typeof m?.name === "string" ? [m.name, m.name.replace(/:latest$/, "")] : [],
      ),
    );
    const has = (name) => tags.has(name) || tags.has(name.replace(/:latest$/, ""));
    result.hasChatModel = has(chatModel);
    result.hasEmbedModel = has(embedModel);
  } catch {
    // Not running, or not reachable. `running` stays false and the caller says so.
  }
  return result;
}

/**
 * Scaffold a project. Returns the process exit code.
 *
 * A return value rather than `process.exit`, because this is now called as a
 * library by `evestack create` as well as by this package's bin — and a
 * library that tears the process down cannot be tested or wrapped.
 */
export async function create(argv) {
  // Arguments first, and nothing at all before them.
  //
  // Neither --help nor --version was handled here, and src/cli.mjs routes `create`
  // before it parses anything, so `evestack create --help` fell through to the
  // wizard with no name to use: it took the default and scaffolded a project
  // literally called `my-agent`, then ran a package-manager install in it.
  const args = parseCreateArgs(argv);
  if (args.help) {
    say(CREATE_USAGE);
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

  // Non-interactive when asked for, or when stdin is not a terminal (CI, a
  // piped heredoc, a Dockerfile). Without this the process would reach EOF
  // mid-prompt and exit 0 having created nothing, which looks like success.
  const nonInteractive = args.yes || !process.stdin.isTTY;
  const positional = args.positional;

  const { ask, confirm, close } = await makePrompter(nonInteractive);

  say();
  say(`${C.cyan}${C.bold}  evestack${C.reset} ${C.dim}— eve on your own machine, $0 infrastructure${C.reset}`);
  say();

  // ---- name & directory -----------------------------------------------------
  const name = positional[0] ?? (await ask("Project name?", "my-agent"));
  const target = isAbsolute(name) ? name : resolve(process.cwd(), name);
  const existing = inspectTarget(target);
  if (existing.kind === "file") {
    close();
    console.error(
      `\n${C.red}${target} is a file, not a directory.${C.reset}\n` +
        `  create makes a new directory and fills it. Give it a name that is free:\n` +
        `    npx create-evestack ${shellQuote(`${basename(target)}-agent`)}`,
    );
    return 1;
  }
  if (existing.kind === "unreadable") {
    close();
    console.error(
      `\n${C.red}${target} cannot be read — ${existing.code}.${C.reset}\n` +
        `  ${existing.code === "EACCES" || existing.code === "EPERM"
          ? "This user does not have permission to look inside it."
          : "The filesystem refused the lookup."}\n` +
        `  Scaffold somewhere you own instead, e.g. ${shellQuote(join(process.cwd(), basename(target)))}.`,
    );
    return 1;
  }
  if (existing.kind === "directory" && existing.entries.length > 0) {
    close();
    console.error(`\n${C.red}${target} already exists and is not empty.${C.reset}`);
    return 1;
  }

  // ---- model ----------------------------------------------------------------
  say();
  say(`  ${C.bold}Model provider${C.reset}`);
  dim("1) OpenAI     — gpt-5-mini, best tool-calling per dollar, costs per token");
  dim("2) Anthropic  — claude-sonnet-5, strong tool-calling, costs per token");
  dim("3) Ollama     — local, $0, weaker tool-calling, needs RAM headroom");
  // Every one of these is written to .env.local as EVESTACK_PROVIDER. It is the
  // variable agent/agent.ts branches on (defaulting to "openai"), and a model
  // name written without it goes to whichever provider was already selected —
  // which is how the Ollama path used to fail, with `compaction trigger model
  // "openai/qwen3" does not have known AI Gateway context window metadata`.
  // Choosing a provider and not writing EVESTACK_PROVIDER is not a partial
  // configuration, it is a broken one.
  // A Map, not an object literal, because the key is whatever the user typed:
  // `PROVIDERS["__proto__"]` on a literal returns Object.prototype, which is
  // truthy, so `?? default` never fires and the wizard goes on to write
  // `EVESTACK_PROVIDER=undefined` and `undefined=` into .env.local.
  const PROVIDERS = new Map([
    ["1", { id: "openai", keyVar: "OPENAI_API_KEY", model: "gpt-5-mini", keyHint: "https://platform.openai.com/api-keys" }],
    ["2", { id: "anthropic", keyVar: "ANTHROPIC_API_KEY", model: "claude-sonnet-5", keyHint: "https://console.anthropic.com/settings/keys" }],
    ["3", { id: "ollama", keyVar: null, model: "qwen3", keyHint: null }],
  ]);
  const modelChoice = await ask("Choose 1, 2 or 3:", "1");
  // Anything unrecognised falls back to the default rather than scaffolding a
  // project configured for a provider nobody picked.
  const chosen = PROVIDERS.get(modelChoice.trim()) ?? PROVIDERS.get("1");
  const useOllama = chosen.id === "ollama";

  let apiKeyLine = "";
  let modelLine = `EVESTACK_PROVIDER=${chosen.id}\nEVESTACK_MODEL=${chosen.model}`;
  if (useOllama) {
    // Three separate things can be missing, and each has a different fix. The
    // wizard used to check only the first, so someone with Ollama installed but
    // no model pulled got a clean scaffold, a clean install, and then an opaque
    // failure on their first message — the point at which they have the least
    // context for debugging it.
    const ollama = await inspectOllama(chosen.model);
    if (!ollama.installed) {
      warn("Ollama is not on PATH. Install it from https://ollama.com, then:");
      warn(`  ollama pull ${chosen.model} && ollama pull nomic-embed-text`);
    } else if (!ollama.running) {
      warn("Ollama is installed but not answering on " + ollama.baseUrl + ". Start it, then:");
      warn(`  ollama pull ${chosen.model} && ollama pull nomic-embed-text`);
    } else {
      // Pull the models now rather than at first message. `ollama pull` of a
      // model already present is a no-op that prints one line, so naming both
      // unconditionally is cheaper than explaining when each is needed.
      if (!ollama.hasChatModel) {
        warn(`Ollama has no "${chosen.model}" yet. Before your first message:`);
        warn(`  ollama pull ${chosen.model}`);
      }
      // A SECOND, SEPARATE model. The chat model cannot produce embeddings, so
      // `remember` and `recall` fail without this one — and they fail inside a
      // tool call, where the model tends to report success anyway.
      if (!ollama.hasEmbedModel) {
        warn("Long-term memory needs a local embedding model, which is a separate pull:");
        warn("  ollama pull nomic-embed-text");
        dim("Skip it if you do not want the remember/recall tools; nothing else uses it.");
      }
    }
    // The wizard is where this warning has to land. By the time someone reads
    // the README section on local models they have usually already run the
    // stack — and on a machine short of memory the failure is not a slow reply,
    // it is the whole host going down. qwen3 is 5.2 GB on top of Docker,
    // Postgres, the dashboard and the agent.
    warn("qwen3 is 5.2 GB. Budget model size + 4 GB free RAM on top of Docker, Postgres");
    warn("and the dashboard, or the machine can hang. A hosted key is safer on a laptop.");
    apiKeyLine = "# Local models need no API key.";
  } else {
    say();
    dim(`Paste a key now, or leave blank and add it to .env.local later — ${chosen.keyHint}`);
    const key = await ask(`${chosen.keyVar}:`, "");
    apiKeyLine = `${chosen.keyVar}=${key}`;
  }

  // ---- integrations ---------------------------------------------------------
  say();
  const wantComposio = await confirm(
    `Enable one-click sign-in to 1000+ tools via Composio? ${C.dim}(Gmail, Slack, Notion, Linear…)${C.reset}`,
    true,
  );
  let composioLine = "# COMPOSIO_API_KEY=ak_...";
  if (wantComposio) {
    dim("Get a key at https://app.composio.dev — or leave blank and add it later.");
    const ck = await ask("COMPOSIO_API_KEY:", "");
    composioLine = ck ? `COMPOSIO_API_KEY=${ck}` : "COMPOSIO_API_KEY=";
  }

  close();

  // ---- scaffold -------------------------------------------------------------
  say();
  step("Creating project");
  // Guarded rather than left to throw. `npx create-evestack /etc/foo` reaches
  // here with nothing existing at the path and no permission to create it, and
  // index.mjs prints message-only — so an unguarded mkdirSync showed the user
  // `EACCES: permission denied, mkdir '/etc/foo'` and nothing else.
  try {
    mkdirSync(target, { recursive: true });
  } catch (error) {
    const code = error?.code ?? "unknown";
    console.error(
      `\n${C.red}Could not create ${target} — ${code}.${C.reset}\n` +
        (code === "EACCES" || code === "EPERM" || code === "EROFS"
          ? `  ${dirname(target)} is not writable by this user.\n` +
            `  Scaffold somewhere you own, e.g. ${shellQuote(join(process.cwd(), basename(target)))}.`
          : `  ${error?.message ?? error}`),
    );
    return 1;
  }
  const source = templateDir();
  cpSync(source, target, {
    recursive: true,
    filter: (src) => isTemplateFile(source, src),
  });

  // Shipped as `gitignore` because npm silently renames a packaged `.gitignore`
  // to `.npmignore`, so the file would never survive publish under its real
  // name. Restoring it here is what keeps a generated .env.local out of git.
  const ignoreSrc = join(target, "gitignore");
  if (existsSync(ignoreSrc)) {
    renameSync(ignoreSrc, join(target, ".gitignore"));
  }

  const pkgPath = join(target, "package.json");
  if (!existsSync(pkgPath)) {
    // Reached only if the copy silently produced nothing. Say so here rather
    // than letting the next line die on an ENOENT that names the wrong file.
    console.error(
      `\n${C.red}The agent template did not copy — ${pkgPath} is missing.${C.reset}\n` +
        `  Template source: ${source}\n` +
        `  Please report this at ${REPO}/issues`,
    );
    return 1;
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  // Normalised, because a directory name is not an npm name. `npx
  // create-evestack "My Agent"` wrote `"name": "My Agent"` — capitals and a
  // space are both invalid — and npm then refused the install with
  // `Invalid name`, from a manifest the user never typed. projectNameFor a few
  // lines down had always normalised the same string for Compose.
  pkg.name = packageNameFor(target);
  pkg.private = true;
  delete pkg.description;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  ok(`Project at ${C.bold}${target}${C.reset}`);

  // Credentials are generated, never defaulted. eve fails closed on non-loopback
  // traffic, so a shipped default password would be the one thing standing
  // between a stranger and someone's agent.
  const password = randomBytes(18).toString("base64url");
  // The trace-ingest shared secret, generated for the same reason and one step
  // further: unlike the password, there is NO working value to fall back to.
  // The dashboard's `ingestAuthorized()` accepts this token or a session, and an
  // OTLP exporter cannot hold a session — so with the variable unset on both
  // sides every span POST is a 401. Worse, @vercel/otel treats a 401 as a
  // successful export (the fetch promise resolves), so the batch is dropped
  // silently and the dashboard just looks empty. A generated value is the only
  // configuration in which trace export works at all.
  //
  // Hex rather than the password's base64url: it is what the dashboard's own
  // docs tell you to paste (`openssl rand -hex 32`), and it is trivially safe to
  // carry in an HTTP header.
  //
  // ONE FILE FEEDS BOTH SIDES. The dashboard service in the docker-compose.yml
  // written below reads `env_file: .env.local` — this exact file — so the agent
  // on the host and the dashboard in the container read one variable from one
  // place and cannot drift. That is what lets the whole dashboard step be
  // `docker compose --profile dashboard up -d` with nothing to copy across.
  const ingestToken = randomBytes(32).toString("hex");
  // The database password, generated for exactly the reason stated above and
  // previously the one credential that was not.
  //
  // The compose file this writes used to carry `POSTGRES_PASSWORD: evestack`
  // and publish `"5433:5432"` — no interface prefix, so 0.0.0.0 — while pinning
  // the dashboard beside it to 127.0.0.1. Verified exploitable from another
  // machine on the same network: connecting to the LAN address on 5433 with
  // evestack/evestack returned rows. That database holds every prompt, tool
  // result and memory the agent has ever produced.
  //
  // Generating it fixed half of that. The other half: the generated value was
  // written INTO docker-compose.yml, twice — POSTGRES_PASSWORD and the
  // dashboard's WORKFLOW_POSTGRES_URL — and docker-compose.yml is a file this
  // scaffold means to be committed. The .gitignore it ships ignores .env and
  // .env.* and quite deliberately not the compose file, so the credential
  // generated because "a shipped default password would be the one thing
  // standing between a stranger and someone's agent" went into git on the first
  // `git add -A`, while the same password in .env.local was carefully ignored.
  // It is now written only to .env (below) and referenced from the compose file.
  //
  // base64url so it is safe unquoted in a URL, in a compose interpolation and in
  // an env file: the alphabet is [A-Za-z0-9_-] and contains no $, # or quote.
  const dbPassword = randomBytes(18).toString("base64url");

  // Ports are chosen against the machine, not assumed.
  //
  // `attach` has always done this; `create` hardcoded 5433 and 4000, which is
  // the wrong way round — `create` is the command someone runs first, and runs
  // twice. A second project, or a clone of this repo with its own compose file,
  // took the port and `docker compose up` failed halfway with
  // `Bind for 0.0.0.0:5433 failed: port is already allocated`, leaving a
  // container created but with nothing published. `docker compose ps` then
  // says "healthy" while the port is missing, so the failure surfaces one
  // command later as a raw ECONNREFUSED out of a migration library.
  const pgPort = await freePort(5433);
  const dashboardPort = await freePort(4000);
  // The agent's port is PINNED, not discovered.
  //
  // `eve dev` takes 2000 and silently auto-increments when it is busy, and
  // nothing recorded where it landed — so the compose file below pointed the
  // dashboard at a hardcoded :2000 and `verify` probed 2000..2004 and believed
  // the first answer. With two projects up, the second project's dashboard
  // drove the FIRST project's agent: real runs, started in the wrong place,
  // with nothing anywhere saying so. Recording the port turns three guesses
  // into one fact.
  const agentPort = await freePort(2000);
  writeFileSync(
    join(target, ".env.local"),
    [
      "# evestack — generated. Never commit this file.",
      "",
      "# Model provider",
      apiKeyLine,
      modelLine,
      "",
      "# The port the agent listens on. `npm run dev` passes it to eve, the",
      "# dashboard container is pointed at it, and `evestack verify` reads it —",
      "# so a second project on this machine cannot be mistaken for this one.",
      `EVESTACK_AGENT_PORT=${agentPort}`,
      "",
      "# Durable sessions (docker compose provides this Postgres)",
      `WORKFLOW_POSTGRES_URL=postgres://evestack:${dbPassword}@127.0.0.1:${pgPort}/evestack`,
      "WORKFLOW_POSTGRES_MAX_POOL_SIZE=20",
      "WORKFLOW_POSTGRES_WORKER_CONCURRENCY=20",
      "",
      "# Route auth — generated for this project. Also the dashboard sign-in.",
      "EVESTACK_AUTH_USER=evestack",
      `EVESTACK_AUTH_PASSWORD=${password}`,
      "",
      "# Dashboard trace export",
      `EVESTACK_DASHBOARD_URL=http://127.0.0.1:${dashboardPort}/api/ingest/v1/traces`,
      "# Read by BOTH halves: the agent sends it as the x-evestack-ingest-token",
      "# header, and the dashboard container gets it from this same file via",
      "# `env_file:` in docker-compose.yml. Change it in one place or neither —",
      "# a mismatch is a 401 on every span, which looks like 'no traces yet'.",
      `EVESTACK_INGEST_TOKEN=${ingestToken}`,
      "",
      "# Integrations",
      composioLine,
      "",
    ].join("\n"),
  );
  ok("Generated .env.local with a unique auth password and trace-ingest token");

  // Compose only accepts [a-z0-9][a-z0-9_-]* as a project name, and a directory
  // name is not constrained to that — so normalise rather than emit a file that
  // fails to parse.
  //
  // THE SUFFIX IS THE POINT. Compose treats `name:` as the project identity, so
  // two directories that normalise to the same name are ONE project: the second
  // `docker compose up` recreates the first one's containers and both agents
  // then read one database, with nothing anywhere saying so.
  //
  // This used to be the bare basename, which fixed an earlier collision against
  // the literal string "evestack" and left the far likelier one wide open —
  // `my-agent` is the DEFAULT name, so two default scaffolds collide by default.
  // Observed on this machine: ~/evestack-trial/my-agent and
  // ~/evestack-stranger/my-agent, with the surviving container reporting
  // `com.docker.compose.project.working_dir` pointing at the second directory.
  // One agent's sessions, memories and traces were in the other's database.
  //
  // Hashing the ABSOLUTE PATH rather than counting upwards keeps the name stable
  // for a given directory — it has to be, or every `docker compose` in that
  // project would address a different stack than the last one did.
  const composeProject = projectNameFor(target);

  // The database password, in the one file Compose will read it from.
  //
  // This is the distinction the leak turned on, so it is worth stating exactly:
  // `env_file:` on a service sets variables INSIDE that container, while
  // `${...}` in the compose file is INTERPOLATION, resolved on the host before
  // the file is parsed — and interpolation reads the shell and `.env`, and never
  // .env.local. Verified both ways against Compose v5.1.3: `${VAR:?msg}` filled
  // from this .env initialises Postgres with that password (a wrong password
  // over TCP from another container is refused with `password authentication
  // failed`), and the same reference with the value only in .env.local fails the
  // parse outright with `required variable ... is missing a value`.
  //
  // So POSTGRES_PASSWORD and the dashboard's in-container connection string are
  // both interpolated from here. docker-compose.yml stays committable and
  // carries no secret; this file and .env.local are both ignored by the
  // .gitignore written above.
  writeFileSync(join(target, ".env"), composeEnvFile(dbPassword));
  ok("Generated .env with the database password — read by Compose, ignored by git");

  writeFileSync(join(target, "docker-compose.yml"), composeFile(composeProject, { pgPort, dashboardPort, agentPort }));
  ok("Wrote docker-compose.yml — Postgres, and the dashboard behind a profile");

  // ---- install --------------------------------------------------------------
  step("Installing dependencies");
  const pm = detectPm();
  // `shell` on Windows for the reason run() states: npm/pnpm/yarn/bun are `.cmd`
  // shims there and a bare spawn cannot execute them, so every Windows run ended
  // at "Created, but dependencies are not installed" and exit 1. Not verified on
  // Windows from here — this matches what the template's own scripts already do.
  const install = spawnSync(pm, ["install"], {
    cwd: target,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  // A failed install leaves an empty node_modules, and the "Next:" steps below
  // would then fail one after another with unrelated-looking errors. Report it
  // as the failure it is — including the exit code, so CI and shell `&&` chains
  // stop here instead of proceeding on a project that cannot run.
  const installed = install.status === 0 && existsSync(join(target, "node_modules", "eve"));
  if (installed) {
    ok("Dependencies installed");
  }

  // ---- next steps -----------------------------------------------------------
  const dockerUp = hasDocker();
  // localhost, not 127.0.0.1, because this one is for a human to click.
  const dashboardUrl = `http://localhost:${dashboardPort}`;
  say();
  if (!installed) {
    say(`${C.yellow}${C.bold}  Created, but dependencies are not installed.${C.reset}`);
    say();
    say(`  ${C.bold}Finish it:${C.reset}`);
    // Quoted: a project called "My Agent" printed `cd My Agent`, which is two
    // arguments and a command that does not work.
    say(`    cd ${shellQuote(basename(target))}`);
    say(`    ${pm} install`);
    say();
    dim("If the install failed on a 404 for @evestack/composio, that package is not");
    dim("published yet. Drop it from package.json and delete agent/tools/composio.ts —");
    dim("everything else in the template works without it.");
    say();
    return 1;
  }
  say(`${C.green}${C.bold}  Done.${C.reset}`);
  say();
  if (!dockerUp) {
    warn("Docker isn't running. Start Docker Desktop first — Postgres and the sandbox need it.");
    say();
  }
  // Five lines, one of them the dashboard. This used to be five lines plus a
  // monorepo clone plus a `docker build` that had never been run by anyone —
  // the largest single piece of friction in the product. What replaced it is a
  // pull, because the compose file written above points at a published image.
  // ---- offer to do the infrastructure part ----------------------------------
  //
  // Two of the four remaining commands are pure setup with one correct answer:
  // start Postgres, create the schema. The third pulls an image. None of them
  // needs a decision, all of them fail in ways that are hard to read, and every
  // one is a chance to stop. `npm run dev` stays manual because it runs in the
  // foreground and belongs to the user's terminal.
  //
  // Asked, not assumed: it starts containers and pulls ~200 MB. Declining
  // prints the same list it always did.
  if (dockerUp && (await confirmStart())) {
    const brought = await bringUp(target, pm, dashboardPort);
    if (brought) {
      say();
      say(`  ${C.bold}Left to do:${C.reset}`);
      say(`    cd ${shellQuote(basename(target))} && ${pm} run dev  ${C.dim}# the agent, in this terminal${C.reset}`);
      say(`    ${pm} run verify                    ${C.dim}# checks all of it, in another${C.reset}`);
      say();
      say(`  ${C.dim}Dashboard${C.reset} ${dashboardUrl} ${C.dim}—${C.reset} evestack ${C.dim}/${C.reset} ${password}`);
      say();
      say(`  ${C.dim}Nothing here bills you. No Vercel account, no metered compute.${C.reset}`);
      say();
      return 0;
    }
    // bringUp already explained what failed; fall through to the manual list so
    // the reader has the commands in front of them.
    say();
  }

  say(`  ${C.bold}Next:${C.reset}`);
  say(`    cd ${shellQuote(basename(target))}`);
  say(`    docker compose up -d postgres              ${C.dim}# durable sessions${C.reset}`);
  // `npx --package=@workflow/world-postgres bootstrap` looks equivalent and is
  // not: its CLI loads `.env` via dotenv and never reads `.env.local`, so it
  // silently falls back to postgres://world:world@localhost:5432/world and dies
  // on ECONNREFUSED. The script wires the generated .env.local in explicitly.
  say(`    ${pm} run db:bootstrap                       ${C.dim}# create the workflow schema${C.reset}`);
  say(`    ${pm} run dev                                ${C.dim}# chat with your agent on :2000${C.reset}`);
  say(`    docker compose --profile dashboard up -d   ${C.dim}# the dashboard on :${dashboardPort}${C.reset}`);
  say(`    ${pm} run verify                             ${C.dim}# check every part of it${C.reset}`);
  say();
  // The dashboard is the reason to pick evestack over plain eve, so the sign-in
  // is printed rather than left to be dug out of .env.local. It is a freshly
  // generated per-project secret on the user's own terminal; the alternative is
  // a user who brings the container up and cannot get past the sign-in page.
  say(`  ${C.dim}Sign in at${C.reset} ${dashboardUrl} ${C.dim}with${C.reset} evestack ${C.dim}/${C.reset} ${password}`);
  dim("(it is in .env.local, which the dashboard container reads too — nothing to copy)");
  // Said once, here, because the split is the reason nothing in this project has
  // to be scrubbed before it is pushed.
  dim("docker-compose.yml is safe to commit: the credentials are in .env and .env.local,");
  dim("both of which the generated .gitignore ignores.");
  say();
  say(`  ${C.dim}Nothing here bills you. No Vercel account, no metered compute.${C.reset}`);
  // Keyed off the line actually written, not off a substring of a key format:
  // "sk-" is an OpenAI shape, and an Anthropic key that did not start with it
  // would have produced this warning to someone who had just pasted one.
  if (!useOllama && apiKeyLine.endsWith("=")) {
    say(`  ${C.yellow}Add ${chosen.keyVar} to .env.local before starting.${C.reset}`);
  }
  say();
  return 0;
}

// Build leftovers and secrets that must never reach a generated project.
const EXCLUDED_SEGMENTS = new Set([
  "node_modules",
  ".eve",
  ".output",
  ".next",
  "dist",
  ".env.local",
  "tsconfig.tsbuildinfo",
]);

/**
 * Decide whether a template path is copied.
 *
 * Exported because scripts/sync-template.mjs needs exactly this decision when it
 * copies templates/default into the package before publish, and had its own
 * substring-against-the-absolute-path version of it — the bug below, one step
 * earlier in the pipeline, where it copied nothing and then died on an ENOENT for
 * the manifest.
 *
 * Matched against the path *relative to the template root*, one segment at a
 * time. Testing the absolute path instead — which this did — silently copies
 * nothing under `npx`, because npm stages the package at
 * `~/.npm/_npx/<hash>/node_modules/create-evestack/template/…` and every source
 * path therefore contains `node_modules`. Substring matching had the same class
 * of bug for anyone whose project lived under a directory named `dist`.
 */
export function isTemplateFile(templateRoot, src) {
  const rel = relative(templateRoot, src);
  if (rel === "") return true; // the template root itself
  return !rel.split(sep).some((segment) => EXCLUDED_SEGMENTS.has(segment));
}

/**
 * What is already at the target path, in the shapes that need different answers.
 *
 * The guard used to be `existsSync(target) && readdirSafe(target).length > 0`,
 * and readdirSafe returned [] for anything it could not read. On a FILE that is
 * ENOTDIR, so the guard decided the path was empty enough and mkdirSync then
 * threw `EEXIST: file already exists, mkdir '/path/README.md'` — an errno, and
 * index.mjs prints message-only, so that errno was the entire explanation the
 * user got for pointing at a file. EACCES on a directory had the same shape.
 *
 * `readdirSync`, not a shell — the reason survives from readdirSafe: this once
 * ran `ls -A ${JSON.stringify(p)}` through execSync, and JSON.stringify is not a
 * shell quoter. It escapes `"` and `\` and leaves `$` alone, and `$(…)` and
 * backticks expand inside double quotes, so `npx create-evestack '$(touch
 * pwned)'` executed that command before the wizard printed its first question.
 * readdirSync takes the path as a path and cannot be talked into anything else.
 */
function inspectTarget(path) {
  let stats;
  try {
    stats = statSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return { kind: "missing" };
    return { kind: "unreadable", code: error?.code ?? "unknown" };
  }
  if (!stats.isDirectory()) return { kind: "file" };
  try {
    return { kind: "directory", entries: readdirSync(path) };
  } catch (error) {
    return { kind: "unreadable", code: error?.code ?? "unknown" };
  }
}

/**
 * The flags `create` accepts, and why an unknown one is now refused.
 *
 * The whole parser was `argv.filter((a) => !a.startsWith("-"))`. It dropped a
 * flag it did not recognise and KEPT the value that followed it, so the value
 * became the directory name. Verified: `npx create-evestack --port 5000` created
 * a directory called `5000`, `--template minimal` created `minimal`, and
 * `my-agent --dry-run` — a flag that exists on `attach` and is advertised two
 * lines away in the shared usage — scaffolded for real and then offered to start
 * containers. `-my-agent` was discarded entirely and the wizard asked for a name
 * it had just been given.
 *
 * A name is not a place to put an argument nobody parsed, so every flag is now
 * either known or an error, and `--` ends the options for the rare directory
 * that really is called `--help`.
 */
const CREATE_FLAGS = new Map([
  ["--yes", "yes"], ["-y", "yes"],
  ["--help", "help"], ["-h", "help"],
  ["--version", "version"], ["-V", "version"],
]);

/** Flags that are real somewhere else, so the error can say where. */
const FLAGS_ELSEWHERE = new Map([
  ["--dry-run", "attach"],
  ["-n", "attach"],
  ["--json", "verify"],
  ["--open", "verify"],
  ["--no-open", "verify and open"],
  ["--sql", "doctor"],
  ["--verbose", "doctor"],
]);

export const CREATE_USAGE = `evestack create — scaffold a new self-hosted eve agent

  npx create-evestack [name] [--yes]
  evestack create [name] [--yes]

Creates the directory, copies the agent template into it, generates this
project's credentials into .env.local and .env, writes a docker-compose.yml for
Postgres plus the dashboard, and installs dependencies.

Options
  --yes, -y       take every default and ask nothing. Implied when stdin is not
                  a terminal — CI, a heredoc, a Dockerfile
  --help, -h      this
  --version, -V   print create-evestack's version

An existing non-empty directory is refused, never merged into. To scaffold into
a directory whose name starts with a dash, end the options first:

  npx create-evestack -- --weird-name
`;

export function parseCreateArgs(argv) {
  const parsed = { positional: [], yes: false, help: false, version: false, error: null };
  let endOfFlags = false;
  for (const arg of argv) {
    if (endOfFlags || !arg.startsWith("-")) {
      if (!endOfFlags && arg === "-") {
        parsed.error = unknownFlag(arg);
        return parsed;
      }
      parsed.positional.push(arg);
      continue;
    }
    if (arg === "--") {
      endOfFlags = true;
      continue;
    }
    const key = CREATE_FLAGS.get(arg.split("=")[0]);
    // `--yes=true` is not a flag this takes a value for either: refuse rather
    // than silently accept a value that changes nothing.
    if (!key || arg.includes("=")) {
      parsed.error = unknownFlag(arg);
      return parsed;
    }
    parsed[key] = true;
  }
  if (parsed.positional.length > 1) {
    parsed.error =
      `create takes one directory name, and got ${parsed.positional.length}: ` +
      `${parsed.positional.map((p) => JSON.stringify(p)).join(", ")}.\n` +
      "  Nothing was created. Quote a name with spaces in it.";
  }
  return parsed;
}

function unknownFlag(flag) {
  const name = flag.split("=")[0];
  const lines = [`Unknown option ${JSON.stringify(flag)} — nothing was created.`];
  const elsewhere = FLAGS_ELSEWHERE.get(name);
  if (elsewhere) {
    lines.push(`  ${name} is a flag on \`${elsewhere}\`, not on \`create\`.`);
  }
  // The `-my-agent` case: what was meant is almost certainly a directory name.
  if (/^-[^-]/.test(name) && name.length > 2) {
    lines.push(`  To scaffold into a directory called ${JSON.stringify(flag)}:`);
    lines.push(`    npx create-evestack -- ${shellQuote(flag)}`);
  }
  lines.push("", "  create takes one directory name and:", "    --yes, -y      accept every default and ask nothing",
    "    --help, -h     the full usage", "    --version, -V  print the version");
  return lines.join("\n");
}

/**
 * The generated project's npm manifest name.
 *
 * A directory name is not an npm name: capitals, spaces and a leading dot are
 * all legal in one and rejected by the other. This was the bare basename, so
 * `npx create-evestack "My Agent"` wrote `"name": "My Agent"` and npm refused
 * the install it went on to run — from a manifest the user never typed, three
 * screens after the mistake. projectNameFor below had always normalised the same
 * string for Compose; this is the same idea against npm's rules.
 */
export function packageNameFor(target) {
  const slug = basename(target)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+/, "")
    .replace(/-+$/, "")
    .slice(0, 214);
  return slug || "agent";
}

/**
 * The Compose project name for a scaffolded directory.
 *
 * Exported so test/compose.test.mjs asserts THIS derivation rather than its own
 * copy of it — a collision test that re-implements the hashing would keep
 * passing after the real one changed.
 */
export function projectNameFor(target) {
  const slug =
    basename(target).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z0-9]+/, "") ||
    "evestack";
  return `${slug}-${createHash("sha256").update(target).digest("hex").slice(0, 6)}`;
}

/**
 * The one variable the compose file reads from `.env`.
 *
 * Exported so a test asserts the compose file and the generated `.env` agree on
 * the name — a compose file interpolating a variable nothing writes fails at
 * parse time with `required variable ... is missing a value`, and a `.env`
 * writing a variable nothing reads is a password sitting in a file for no
 * reason.
 */
export const DB_PASSWORD_VAR = "EVESTACK_DB_PASSWORD";

/**
 * The `.env` beside the compose file: the database password, and nothing that is
 * not needed to start the stack.
 *
 * Exported so the same string a scaffold gets is the string a test checks — a
 * test that rebuilt this content would keep passing while the real file drifted
 * back into the compose file.
 */
export function composeEnvFile(dbPassword) {
  return [
    "# evestack — generated. Read by `docker compose`, and never committed.",
    "",
    "# Compose interpolates ${...} in docker-compose.yml from this file (or the",
    "# shell) and from nowhere else — it does not read .env.local. That is the whole",
    "# reason this file exists: docker-compose.yml is meant to be committed, so the",
    "# database password cannot be in it.",
    `${DB_PASSWORD_VAR}=${dbPassword}`,
    "",
    "# The agent gets the same password from WORKFLOW_POSTGRES_URL in .env.local,",
    "# because it runs on the host and connects over the published port. Rotate it in",
    "# both files together, and remember that Postgres only applies POSTGRES_PASSWORD",
    "# when the data volume is first created — `docker compose down -v` (which deletes",
    "# the sessions) is what makes a new password take effect.",
    "",
    "# To run your own dashboard image instead of the published one:",
    `# EVESTACK_DASHBOARD_IMAGE=${DASHBOARD_IMAGE}`,
    "",
  ].join("\n");
}

export function composeFile(projectName, { pgPort = 5433, dashboardPort = 4000, agentPort = 2000 } = {}) {
  // The compose project name has to be unique to this DIRECTORY PATH, not to its
  // name. Compose treats `name:` as the project identity, so two scaffolds — or
  // one scaffold plus a cloned evestack repo — become the SAME project: the
  // second `docker compose up` recreates the first one's container and both
  // agents silently share one database. Observed twice, most recently with two
  // directories both called `my-agent`, which is the DEFAULT name.
  //
  // The trade this makes, stated because the generated file says it too: the
  // name is derived from the absolute path, so MOVING the project directory
  // gives it a new identity and Compose no longer recognises the old containers
  // and volume. That is visible and recoverable — `docker compose up -d` makes
  // fresh ones, and the old volume is still there to copy out of. Sharing a
  // database with an unrelated agent is neither.
  //
  // NO SECRET IN THIS FILE. It used to carry the generated database password
  // twice — POSTGRES_PASSWORD, and the dashboard's WORKFLOW_POSTGRES_URL — and
  // this is the one generated file the scaffold means you to commit: the
  // .gitignore it writes covers .env and .env.*, deliberately not this. So the
  // password that exists because "a shipped default would be the one thing
  // standing between a stranger and someone's agent" was committed by the first
  // `git add -A`. Both references are now `${...}`, which Compose interpolates
  // from `.env` on the host before parsing, and `.env` is ignored.
  //
  // `:?` rather than `:-`: a missing password must stop the command, not start a
  // Postgres with an empty one. Compose prints the text after `?` verbatim.
  //
  // The dashboard sits behind a profile so a plain `docker compose up -d` starts
  // Postgres alone — the agent is useful without the dashboard, and pulling a
  // ~400 MB image is not something to do to someone who only asked for a
  // database.
  const password = `\${${DB_PASSWORD_VAR}:?missing — it belongs in the .env file beside this one}`;
  return `# evestack — your whole stack, on your machine, for $0.
#
# The "name:" line below is this directory's identity to Docker Compose, and it
# carries a hash of the directory's full path so that two projects with the same
# folder name cannot silently share one database. Move this directory and Compose
# will not recognise the containers and volume it made here — bring them up again
# and copy out of the old volume if you need what was in it.
#
#   docker compose up -d postgres              durable sessions
#   docker compose --profile dashboard up -d   + the dashboard on :${dashboardPort}
#
# THIS FILE IS SAFE TO COMMIT, and that is the reason ${DB_PASSWORD_VAR} appears
# below instead of the password itself. Compose fills those in from the .env file
# beside this one, which the generated .gitignore ignores along with .env.local.
# Keep it that way: a password pasted in here goes into git the next time anyone
# runs \`git add -A\`, and the database it opens holds every prompt, tool result
# and memory this agent has produced.
#
# The dashboard is a pull, not a build. To run your own image instead — a local
# build, a fork, a private registry — set EVESTACK_DASHBOARD_IMAGE in that same
# .env, or export it in your shell.
name: ${projectName}

services:
  postgres:
    image: pgvector/pgvector:pg17
    restart: unless-stopped
    environment:
      POSTGRES_USER: evestack
      # From .env, never from here. Compose resolves this on the host before it
      # parses the file — that is interpolation, and it reads the shell and .env
      # and NOT .env.local. (A service's \`env_file:\` is the other mechanism, and
      # it sets variables inside the container; the dashboard below uses it.)
      POSTGRES_PASSWORD: "${password}"
      POSTGRES_DB: evestack
    ports:
      # 127.0.0.1 on purpose, and this line is the whole reason the password is
      # generated per project rather than shipped. Publishing "${pgPort}:5432" binds
      # 0.0.0.0, and a machine on the same network could reach this database and
      # authenticate — verified, on a real LAN, against the old default
      # credentials. It holds every prompt, tool result and memory the agent has
      # produced, which makes it a more valuable target than the dashboard that
      # was already pinned to loopback two services down.
      #
      # Reaching it from another host is a deliberate act: publish it yourself,
      # or put it behind something that terminates TLS and authenticates.
      - "127.0.0.1:${pgPort}:5432"
    volumes:
      - evestack-pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U evestack -d evestack"]
      interval: 3s
      timeout: 3s
      retries: 20

  dashboard:
    # Pinned to a tag, not \`latest\`: this is the image version tested against
    # the agent template this project was scaffolded from. \`latest\` exists in
    # the registry for anyone who would rather track the newest.
    image: \${EVESTACK_DASHBOARD_IMAGE:-${DASHBOARD_IMAGE}}
    profiles: ["dashboard"]
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    # The generated credentials, without a second copy of them in a second file.
    # EVESTACK_AUTH_USER and EVESTACK_AUTH_PASSWORD are what the dashboard signs
    # you in with AND what it presents to your agent; with either missing it
    # answers 503 to every request and reports unhealthy, by design — it starts
    # agent runs, approves gated shell commands and deletes memories.
    #
    # EVESTACK_INGEST_TOKEN rides along in the same file, and that is the whole
    # reason it can be generated once: your agent runs on the host and reads
    # .env.local directly, this container reads the same .env.local through the
    # line below, so both halves of the trace-ingest shared secret come from one
    # place. Edit it there and restart both — the agent's exporter sends it as
    # \`x-evestack-ingest-token\`, and a value that does not match is a 401 on
    # every span that the OTLP exporter reports to the agent as a success.
    #
    # The model key rides along in the same file, which is a real if small cost:
    # anyone who owns this container can already start runs that spend that key,
    # so the marginal exposure is close to nothing and the alternative is the
    # same secret duplicated into a .env that drifts.
    env_file:
      - .env.local
    environment:
      # .env.local says 127.0.0.1:${pgPort} because the AGENT runs on your host.
      # Inside a container "127.0.0.1" is the container, so the same database is
      # reached over the compose network instead — and the password comes from
      # .env by interpolation, exactly as it does for Postgres above. This line
      # overrides the value env_file just supplied, which is the order Compose
      # documents and the reason both halves stay consistent.
      WORKFLOW_POSTGRES_URL: postgres://evestack:${password}@postgres:5432/evestack
      # \`npm run dev\` also runs on the host, not in compose.
      EVESTACK_AGENT_URL: \${EVESTACK_AGENT_URL:-http://host.docker.internal:${agentPort}}
    ports:
      # 127.0.0.1 on purpose. The process inside binds 0.0.0.0 because nothing
      # could reach it otherwise; the published mapping is where exposure is
      # actually decided, and this one keeps the control plane on loopback.
      - "127.0.0.1:${"$"}{DASHBOARD_PORT:-${dashboardPort}}:4000"
    extra_hosts:
      - "host.docker.internal:host-gateway"

volumes:
  evestack-pgdata:
`;
}
