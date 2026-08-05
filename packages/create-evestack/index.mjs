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
import { execSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
  dim("1) OpenAI or Anthropic API key  — best tool-calling, costs per token");
  dim("2) Ollama (local)               — genuinely $0, weaker tool-calling");
  const modelChoice = await ask("Choose 1 or 2:", "1");
  const useOllama = modelChoice.trim() === "2";

  let apiKeyLine = "";
  let modelLine = "";
  if (useOllama) {
    if (!hasOllama()) {
      warn("Ollama not found on PATH — install it from https://ollama.com, then `ollama pull qwen3`.");
    }
    modelLine = "EVESTACK_MODEL=qwen3";
    apiKeyLine = "# Local models need no API key.";
  } else {
    say();
    dim("Paste a key now, or leave blank and add it to .env.local later.");
    const key = await ask("OPENAI_API_KEY:", "");
    apiKeyLine = key ? `OPENAI_API_KEY=${key}` : "OPENAI_API_KEY=";
    modelLine = "EVESTACK_MODEL=gpt-5-mini";
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
      "",
      "# Integrations",
      composioLine,
      "",
    ].join("\n"),
  );
  ok("Generated .env.local with a unique auth password");

  writeFileSync(join(target, "docker-compose.yml"), composeFile());
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
  say(`  ${C.bold}Then add the dashboard${C.reset} ${C.dim}— sessions, cost, approvals, chat:${C.reset}`);
  say(`    git clone https://github.com/SammyTourani/evestack`);
  say(`    cd evestack/packages/dashboard && pnpm install && pnpm dev`);
  say(`    ${C.dim}point WORKFLOW_POSTGRES_URL at the same database${C.reset}`);
  say();
  say(`  ${C.dim}Nothing here bills you. No Vercel account, no metered compute.${C.reset}`);
  if (!useOllama && !apiKeyLine.includes("=sk-")) {
    say(`  ${C.yellow}Add your API key to .env.local before starting.${C.reset}`);
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

function readdirSafe(p) {
  try {
    return execSync(`ls -A ${JSON.stringify(p)}`, { encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function composeFile() {
  return `# evestack — your whole stack, on your machine, for $0.
name: evestack

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

volumes:
  evestack-pgdata:
`;
}

main().catch((error) => {
  console.error(`\n${C.red}${error?.message ?? error}${C.reset}`);
  process.exit(1);
});
