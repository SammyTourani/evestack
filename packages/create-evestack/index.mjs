#!/usr/bin/env node
/**
 * create-evestack — one command to a self-hosted eve agent.
 *
 * Two commands, one binary:
 *
 *   npx create-evestack my-agent      scaffold a new agent
 *   npx create-evestack attach [dir]  wrap an eve project you already have
 *
 * `attach` is a subcommand rather than a second bin on PATH. A package called
 * create-evestack that installs a general-purpose `evestack` command is a
 * surprise, and it would collide with any real evestack CLI later — while npm's
 * own `create-*` convention already makes `npx create-evestack <anything>` the
 * obvious way in. The one cost: a project you actually want to name "attach"
 * has to be written `npx create-evestack ./attach`.
 *
 * Deliberately dependency-free. A scaffolder that installs a prompt library
 * before it can ask its first question is slower than the thing it scaffolds,
 * and every dependency here is one more supply-chain surface for a tool that
 * writes files and credentials.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  basename, C, detectPm, dim, makePrompter, ok, say, step, templateDir, warn,
} from "./shared.mjs";

function hasDocker() {
  const r = spawnSync("docker", ["info"], { stdio: "ignore" });
  return r.status === 0;
}

function hasOllama() {
  return spawnSync("ollama", ["--version"], { stdio: "ignore" }).status === 0;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "attach") {
    const { attach } = await import("./attach.mjs");
    return attach(argv.slice(1));
  }
  if (argv.includes("--help") || argv.includes("-h")) return usage();

  // Non-interactive when asked for, or when stdin is not a terminal (CI, a
  // piped heredoc, a Dockerfile). Without this the process would reach EOF
  // mid-prompt and exit 0 having created nothing, which looks like success.
  const nonInteractive =
    argv.includes("--yes") || argv.includes("-y") || !process.stdin.isTTY;
  const positional = argv.filter((a) => !a.startsWith("-"));

  const { ask, confirm, close } = await makePrompter(nonInteractive);

  say();
  say(`${C.cyan}${C.bold}  evestack${C.reset} ${C.dim}— eve on your own machine, $0 infrastructure${C.reset}`);
  say();

  // ---- name & directory -----------------------------------------------------
  const name = positional[0] ?? (await ask("Project name?", "my-agent"));
  const target = isAbsolute(name) ? name : resolve(process.cwd(), name);
  if (existsSync(target) && readdirSafe(target).length > 0) {
    console.error(`\n${C.red}${target} already exists and is not empty.${C.reset}`);
    process.exit(1);
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
    if (!hasOllama()) {
      warn("Ollama not found on PATH — install it from https://ollama.com, then `ollama pull qwen3`.");
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
  mkdirSync(target, { recursive: true });
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
        "  Please report this at https://github.com/SammyTourani/evestack/issues",
    );
    process.exit(1);
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.name = basename(target);
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
  // ONE FILE FEEDS BOTH SIDES. This is what makes generating it correct even
  // though the dashboard runs from a separate clone: the clone supplies the
  // IMAGE, never the environment. The dashboard service in the docker-compose.yml
  // written below reads `env_file: .env.local` — this exact file — so the agent
  // on the host and the dashboard in the container read one variable from one
  // place and cannot drift. Running the dashboard some other way (`pnpm dev`
  // inside the clone) means copying the value across by hand; the next-steps
  // below say so, and packages/dashboard/README.md documents it.
  const ingestToken = randomBytes(32).toString("hex");
  writeFileSync(
    join(target, ".env.local"),
    [
      "# evestack — generated. Never commit this file.",
      "",
      "# Model provider",
      apiKeyLine,
      modelLine,
      "",
      "# Durable sessions (docker compose provides this Postgres)",
      "WORKFLOW_POSTGRES_URL=postgres://evestack:evestack@localhost:5433/evestack",
      "WORKFLOW_POSTGRES_MAX_POOL_SIZE=20",
      "WORKFLOW_POSTGRES_WORKER_CONCURRENCY=20",
      "",
      "# Route auth — generated for this project",
      "EVESTACK_AUTH_USER=evestack",
      `EVESTACK_AUTH_PASSWORD=${password}`,
      "",
      "# Dashboard trace export",
      "EVESTACK_DASHBOARD_URL=http://localhost:4000/api/ingest/v1/traces",
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
  const composeProject =
    basename(target).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z0-9]+/, "") ||
    "evestack";
  writeFileSync(join(target, "docker-compose.yml"), composeFile(composeProject));
  ok("Wrote docker-compose.yml");

  // ---- install --------------------------------------------------------------
  step("Installing dependencies");
  const pm = detectPm();
  const install = spawnSync(pm, ["install"], { cwd: target, stdio: "inherit" });
  // A failed install leaves an empty node_modules, and the "Next:" steps below
  // would then fail one after another with unrelated-looking errors. Report it
  // as the failure it is — including the exit code, so CI and shell `&&` chains
  // stop here instead of proceeding on a project that cannot run.
  const installed = install.status === 0 && existsSync(join(target, "node_modules", "eve"));
  if (installed) {
    ok("Dependencies installed");
  } else {
    process.exitCode = 1;
  }

  // ---- next steps -----------------------------------------------------------
  const dockerUp = hasDocker();
  say();
  if (!installed) {
    say(`${C.yellow}${C.bold}  Created, but dependencies are not installed.${C.reset}`);
    say();
    say(`  ${C.bold}Finish it:${C.reset}`);
    say(`    cd ${basename(target)}`);
    say(`    ${pm} install`);
    say();
    dim("If the install failed on a 404 for @evestack/composio, that package is not");
    dim("published yet. Drop it from package.json and delete agent/tools/composio.ts —");
    dim("everything else in the template works without it.");
    say();
    return;
  }
  say(`${C.green}${C.bold}  Done.${C.reset}`);
  say();
  if (!dockerUp) {
    warn("Docker isn't running. Start Docker Desktop first — Postgres and the sandbox need it.");
    say();
  }
  say(`  ${C.bold}Next:${C.reset}`);
  say(`    cd ${basename(target)}`);
  say(`    docker compose up -d postgres        ${C.dim}# durable sessions${C.reset}`);
  // `npx --package=@workflow/world-postgres bootstrap` looks equivalent and is
  // not: its CLI loads `.env` via dotenv and never reads `.env.local`, so it
  // silently falls back to postgres://world:world@localhost:5432/world and dies
  // on ECONNREFUSED. The script wires the generated .env.local in explicitly.
  say(`    ${pm} run db:bootstrap                 ${C.dim}# create the workflow schema${C.reset}`);
  say(`    ${pm} run dev                          ${C.dim}# chat with your agent${C.reset}`);
  say();
  // The dashboard is the reason to pick evestack over plain eve, and it lives
  // in the repo rather than this package — so a user who never opens the README
  // would finish this command without learning it exists.
  //
  // Say plainly that this is a build, not a pull. This used to print
  // `cd evestack/packages/dashboard && pnpm install && pnpm dev`, which does not
  // work: the install has to happen at the workspace ROOT for `workspace:*` to
  // resolve, @evestack/schedules has to be built before Turbopack can find
  // dist/, and since the dashboard grew route auth it refuses every request
  // without EVESTACK_AUTH_PASSWORD. Three failures in one line. The image path
  // below has none of them, and your docker-compose.yml already has the service
  // wired to this project's database and credentials.
  say(`  ${C.bold}Then add the dashboard${C.reset} ${C.dim}— sessions, cost, approvals, chat:${C.reset}`);
  say(`    git clone https://github.com/SammyTourani/evestack`);
  say(`    docker build -t evestack-dashboard:local -f evestack/packages/dashboard/Dockerfile evestack`);
  say(`    docker compose --profile dashboard up -d   ${C.dim}# :4000${C.reset}`);
  say();
  dim("That is a build, not a pull — evestack does not publish a dashboard image");
  dim("yet, so `--profile dashboard` fails until the build above has run once.");
  dim("The clone is only needed for that build; delete it afterwards if you like.");
  say();
  say(`  ${C.dim}Nothing here bills you. No Vercel account, no metered compute.${C.reset}`);
  // Keyed off the line actually written, not off a substring of a key format:
  // "sk-" is an OpenAI shape, and an Anthropic key that did not start with it
  // would have produced this warning to someone who had just pasted one.
  if (!useOllama && apiKeyLine.endsWith("=")) {
    say(`  ${C.yellow}Add ${chosen.keyVar} to .env.local before starting.${C.reset}`);
  }
  say();
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
 * Matched against the path *relative to the template root*, one segment at a
 * time. Testing the absolute path instead — which this did — silently copies
 * nothing under `npx`, because npm stages the package at
 * `~/.npm/_npx/<hash>/node_modules/create-evestack/template/…` and every source
 * path therefore contains `node_modules`. Substring matching had the same class
 * of bug for anyone whose project lived under a directory named `dist`.
 */
function isTemplateFile(templateRoot, src) {
  const rel = relative(templateRoot, src);
  if (rel === "") return true; // the template root itself
  return !rel.split(sep).some((segment) => EXCLUDED_SEGMENTS.has(segment));
}

function usage() {
  say();
  say(`${C.cyan}${C.bold}  evestack${C.reset} ${C.dim}— eve on your own machine, $0 infrastructure${C.reset}`);
  say();
  say(`  ${C.bold}npx create-evestack${C.reset} [name] ${C.dim}[--yes]${C.reset}`);
  dim("Scaffold a new self-hosted eve agent: Postgres sessions, Docker sandbox, memory.");
  say();
  say(`  ${C.bold}npx create-evestack attach${C.reset} [dir] ${C.dim}[--yes] [--dry-run]${C.reset}`);
  dim("Wrap an eve project you already have with evestack's control plane. Additive,");
  dim("never overwrites your files, and prints an undo line for everything it writes.");
  say();
  dim("To scaffold a project actually named `attach`, write `npx create-evestack ./attach`.");
  say();
}

/**
 * The target directory's entries, or [] if it cannot be read.
 *
 * `readdirSync`, not a shell. This ran `ls -A ${JSON.stringify(p)}` through
 * execSync, and JSON.stringify is not a shell quoter: it escapes `"` and `\`
 * and leaves `$` alone, but `$(…)` and backticks expand inside double quotes.
 * The path comes straight from argv, so `npx create-evestack '$(touch pwned)'`
 * executed that command before the wizard printed its first question. readdirSync
 * takes the path as a path and cannot be talked into anything else.
 */
function readdirSafe(p) {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

function composeFile(projectName) {
  // The compose project name has to be per-directory, not the literal string
  // "evestack". Compose treats `name:` as the project identity, so two scaffolds
  // — or one scaffold plus a cloned evestack repo, which the printed next-steps
  // tell you to set up — become the SAME project. The second `docker compose up`
  // then recreates the first one's container and both agents silently share one
  // database. Observed live: scaffolding into a new directory recreated an
  // unrelated running evestack-postgres-1.
  //
  // The dashboard service is real, not commented out, but sits behind a profile
  // so `docker compose up -d` never tries to pull an image that does not exist
  // yet. evestack publishes NO dashboard image today; the header below says so
  // and gives the two commands that produce one locally. Publishing turns this
  // into a one-line change — see the note on EVESTACK_DASHBOARD_IMAGE.
  return `# evestack — your whole stack, on your machine, for $0.
#
#   docker compose up -d postgres              durable sessions
#   docker compose --profile dashboard up -d   + the dashboard on :4000
#
# THE DASHBOARD IMAGE IS NOT PUBLISHED YET. The second command fails with a pull
# error until you build it once, from the evestack repository — clone it
# anywhere, and delete the clone afterwards if you like:
#
#   git clone https://github.com/SammyTourani/evestack
#   docker build -t evestack-dashboard:local \\
#     -f evestack/packages/dashboard/Dockerfile evestack
#
# (The context is the repo ROOT, not packages/dashboard: the dashboard resolves
# a pnpm \`workspace:*\` dependency that only exists against the root lockfile.)
#
# When an image is published, set EVESTACK_DASHBOARD_IMAGE in a .env beside this
# file — or just re-scaffold, since the default below will point at the registry.
name: ${projectName}

services:
  postgres:
    image: pgvector/pgvector:pg17
    restart: unless-stopped
    environment:
      POSTGRES_USER: evestack
      POSTGRES_PASSWORD: evestack
      POSTGRES_DB: evestack
    ports:
      - "5433:5432"
    volumes:
      - evestack-pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U evestack -d evestack"]
      interval: 3s
      timeout: 3s
      retries: 20

  dashboard:
    image: \${EVESTACK_DASHBOARD_IMAGE:-evestack-dashboard:local}
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
      # .env.local says localhost:5433 because the AGENT runs on your host.
      # Inside a container "localhost" is the container, so the same database is
      # reached over the compose network instead.
      WORKFLOW_POSTGRES_URL: postgres://evestack:evestack@postgres:5432/evestack
      # \`npm run dev\` also runs on the host, not in compose.
      EVESTACK_AGENT_URL: \${EVESTACK_AGENT_URL:-http://host.docker.internal:2000}
    ports:
      # 127.0.0.1 on purpose. The process inside binds 0.0.0.0 because nothing
      # could reach it otherwise; the published mapping is where exposure is
      # actually decided, and this one keeps the control plane on loopback.
      - "127.0.0.1:\${DASHBOARD_PORT:-4000}:4000"
    extra_hosts:
      - "host.docker.internal:host-gateway"

volumes:
  evestack-pgdata:
`;
}

main().catch((error) => {
  console.error(`\n${C.red}${error?.message ?? error}${C.reset}`);
  process.exit(1);
});
