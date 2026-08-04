#!/usr/bin/env node
/**
 * create-evestack — one command to a self-hosted eve agent.
 *
 * Deliberately dependency-free. A scaffolder that installs a prompt library
 * before it can ask its first question is slower than the thing it scaffolds,
 * and every dependency here is one more supply-chain surface for a tool that
 * writes files and credentials.
 */
import { execSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m",
};
const say = (s = "") => console.log(s);
const step = (s) => say(`${C.cyan}▚${C.reset} ${s}`);
const ok = (s) => say(`  ${C.green}✓${C.reset} ${s}`);
const warn = (s) => say(`  ${C.yellow}!${C.reset} ${s}`);
const dim = (s) => say(`  ${C.dim}${s}${C.reset}`);

function templateDir() {
  // Published layout first, then the monorepo layout for local development.
  for (const candidate of [join(HERE, "template"), join(HERE, "..", "..", "templates", "default")]) {
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }
  console.error(`${C.red}Could not locate the agent template.${C.reset}`);
  process.exit(1);
}

function hasDocker() {
  const r = spawnSync("docker", ["info"], { stdio: "ignore" });
  return r.status === 0;
}

function hasOllama() {
  return spawnSync("ollama", ["--version"], { stdio: "ignore" }).status === 0;
}

async function main() {
  const argv = process.argv.slice(2);
  // Non-interactive when asked for, or when stdin is not a terminal (CI, a
  // piped heredoc, a Dockerfile). Without this the process would reach EOF
  // mid-prompt and exit 0 having created nothing, which looks like success.
  const nonInteractive =
    argv.includes("--yes") || argv.includes("-y") || !process.stdin.isTTY;
  const positional = argv.filter((a) => !a.startsWith("-"));

  const rl = nonInteractive
    ? null
    : createInterface({ input: process.stdin, output: process.stdout });

  let stdinClosed = false;
  rl?.on("close", () => {
    stdinClosed = true;
  });

  const ask = async (q, fallback = "") => {
    if (!rl || stdinClosed) return fallback;
    // Guard the EOF case explicitly: after stdin closes, question() never
    // settles, so race it against the close event rather than hanging.
    const answer = await Promise.race([
      rl.question(`${C.bold}?${C.reset} ${q} `),
      new Promise((res) => rl.once("close", () => res(null))),
    ]);
    if (answer === null) {
      stdinClosed = true;
      return fallback;
    }
    return answer.trim() || fallback;
  };
  const confirm = async (q, def = true) => {
    const a = (await ask(`${q} ${C.dim}(${def ? "Y/n" : "y/N"})${C.reset}`)).toLowerCase();
    return a === "" ? def : a.startsWith("y");
  };

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

  rl?.close();

  // ---- scaffold -------------------------------------------------------------
  say();
  step("Creating project");
  mkdirSync(target, { recursive: true });
  cpSync(templateDir(), target, {
    recursive: true,
    filter: (src) => !/(node_modules|\.eve|\.output|\.env\.local|dist)/.test(src),
  });

  // Shipped as `gitignore` because npm silently renames a packaged `.gitignore`
  // to `.npmignore`, so the file would never survive publish under its real
  // name. Restoring it here is what keeps a generated .env.local out of git.
  const ignoreSrc = join(target, "gitignore");
  if (existsSync(ignoreSrc)) {
    renameSync(ignoreSrc, join(target, ".gitignore"));
  }

  const pkgPath = join(target, "package.json");
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
  if (install.status !== 0) {
    warn(`${pm} install failed — run it yourself in ${target}`);
  } else {
    ok("Dependencies installed");
  }

  // ---- next steps -----------------------------------------------------------
  const dockerUp = hasDocker();
  say();
  say(`${C.green}${C.bold}  Done.${C.reset}`);
  say();
  if (!dockerUp) {
    warn("Docker isn't running. Start Docker Desktop first — Postgres and the sandbox need it.");
    say();
  }
  say(`  ${C.bold}Next:${C.reset}`);
  say(`    cd ${basename(target)}`);
  say(`    docker compose up -d postgres        ${C.dim}# durable sessions${C.reset}`);
  say(`    npx --package=@workflow/world-postgres bootstrap`);
  say(`    ${pm} run dev                          ${C.dim}# chat with your agent${C.reset}`);
  say();
  say(`  ${C.dim}Nothing here bills you. No Vercel account, no metered compute.${C.reset}`);
  if (!useOllama && !apiKeyLine.includes("=sk-")) {
    say(`  ${C.yellow}Add your API key to .env.local before starting.${C.reset}`);
  }
  say();
}

function basename(p) {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? "agent";
}

function readdirSafe(p) {
  try {
    return execSync(`ls -A ${JSON.stringify(p)}`, { encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function detectPm() {
  const ua = process.env.npm_config_user_agent ?? "";
  if (ua.startsWith("pnpm")) return "pnpm";
  if (ua.startsWith("yarn")) return "yarn";
  if (ua.startsWith("bun")) return "bun";
  return "npm";
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
