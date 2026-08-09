#!/usr/bin/env node
/**
 * `npm run dev` — check the two things that are always wrong first, then start
 * the agent.
 *
 * This is the most-run command in the project and it had the two worst error
 * messages in it, both for the two most ordinary mistakes there are.
 *
 * Forget `docker compose up -d postgres`:
 *
 *     [env-runner] worker init failed: connect ECONNREFUSED 127.0.0.1:5433
 *     Development worker failed before readiness: connect ECONNREFUSED 127.0.0.1:5433
 *
 * Forget `npm run db:bootstrap`:
 *
 *     [env-runner] worker init failed: Failed query: select "id", "output",
 *     "output_cbor", "deployment_id", "status", "name", "spec_version",
 *     "execution_context", … from "workflow"."workflow_runs" where … = $1
 *     order by … limit $2
 *     params: pending,21
 *
 * printed twice. Neither one names Docker, names the schema, names a command,
 * or gives the reader anything to do. Both are one command away from fixed.
 *
 * So this checks, says the command, and exits. When everything is fine it
 * prints nothing and execs `eve dev` with stdio inherited, so eve's own
 * interactive terminal UI, its colours and its TTY detection are all exactly
 * as they were — this wrapper is invisible on the happy path.
 *
 *   npm run dev              check, then start
 *   npm run dev -- --no-ui   passed straight through to eve, as are all flags
 *   EVESTACK_SKIP_PREFLIGHT=1 npm run dev    start without checking
 */
import { spawn } from "node:child_process";

import {
  C,
  connectPostgres,
  dockerRunning,
  envValue,
  eveArgsWithPort,
  inspectOllama,
  readEnvFile,
  schemasPresent,
} from "./checks.mjs";

const passthrough = process.argv.slice(2);

function stop(title, lines) {
  console.error(`\n${C.red}${C.bold}  ${title}${C.reset}\n`);
  for (const line of lines) console.error(`  ${line}`);
  console.error();
  process.exit(1);
}

/**
 * Start eve, replacing this process's role entirely.
 *
 * `--port` comes from EVESTACK_AGENT_PORT, which the scaffolder chose and wrote
 * down. Without it `eve dev` takes 2000 and auto-increments when that is busy,
 * and nothing records where it went — so the dashboard, which is configured with
 * a fixed URL, ends up driving whichever agent happens to hold 2000. On a
 * machine with two projects that is the other project's agent.
 *
 * A `--port` the user typed always wins: the pin is a default, not a rule.
 */
function startEve() {
  // Shared with scripts/start.mjs. It lived here first and `start` did without
  // it, which is the whole reason a built server ignored the recorded port.
  const args = eveArgsWithPort("dev", passthrough, process.env.EVESTACK_AGENT_PORT);
  // `eve` from the local install rather than a global one, so the version the
  // project pinned is the version that runs.
  const child = spawn("eve", args, {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
  child.on("error", (error) => {
    if (error.code === "ENOENT") {
      stop("eve is not installed in this project.", [
        `Run ${C.bold}npm install${C.reset} first.`,
      ]);
    }
    throw error;
  });
  // Ctrl-C must reach eve, not just this wrapper, or the user is left with an
  // agent still holding the port.
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

if (process.env.EVESTACK_SKIP_PREFLIGHT) {
  startEve();
} else {
  await preflight();
  startEve();
}

async function preflight() {
  const fileEnv = readEnvFile();
  const env = (key) => envValue(fileEnv, key);

  /* -- the database ------------------------------------------------------- */

  const pgUrl = env("WORKFLOW_POSTGRES_URL");
  if (!pgUrl) {
    // Not fatal. Without it eve falls back to a local on-disk world, which
    // works — it is just not the durable Postgres this project is about. Say so
    // once and carry on rather than refusing to start.
    console.warn(
      `${C.yellow}  !${C.reset} WORKFLOW_POSTGRES_URL is not set, so sessions are stored under .eve/ ` +
        "instead of Postgres.\n" +
        `    ${C.dim}The dashboard reads Postgres, so it will show nothing. .env.example has the line.${C.reset}`,
    );
    return;
  }

  let where = "the configured host";
  try {
    const parsed = new URL(pgUrl);
    where = `${parsed.hostname}:${parsed.port || 5432}`;
  } catch {
    stop("WORKFLOW_POSTGRES_URL is not a URL.", ["Check the line in .env.local."]);
  }

  const probe = await connectPostgres(pgUrl, 4000);
  if (!probe.ok) {
    stop(`Postgres is not running, so the agent cannot start.`, [
      `Nothing is accepting connections on ${C.bold}${where}${C.reset}.`,
      `${C.dim}${probe.error}${C.reset}`,
      "",
      ...(dockerRunning()
        ? [
            `${C.bold}Start it:${C.reset}`,
            "",
            "    docker compose up -d postgres",
            "",
            `${C.dim}Already "Up"? A container whose port bind failed once is not re-bound by a${C.reset}`,
            `${C.dim}plain restart, and \`docker compose ps\` still calls it healthy. Force it:${C.reset}`,
            "",
            "    docker compose up -d --force-recreate postgres",
          ]
        : [
            `${C.bold}Docker is not running.${C.reset} Start Docker Desktop, then:`,
            "",
            "    docker compose up -d postgres",
          ]),
    ]);
  }

  /* -- the schema -------------------------------------------------------- */

  const schemas = await schemasPresent(probe.client);
  await probe.client.end().catch(() => {});

  if (!schemas.has("workflow")) {
    stop("The database has no workflow schema yet.", [
      `Postgres is up at ${C.bold}${where}${C.reset}, but nothing has created the tables eve`,
      "stores sessions in. That is one command, and nothing creates it for you:",
      "",
      `    ${C.bold}npm run db:bootstrap${C.reset}`,
      "",
      `${C.dim}Then \`npm run dev\` again.${C.reset}`,
    ]);
  }

  /* -- the model --------------------------------------------------------- */
  // Last, and never fatal for a hosted provider: a wrong key is the provider's
  // 401 to report, not ours to guess at. For Ollama it IS knowable locally, and
  // a missing pull is otherwise a failure on the user's first message.

  const provider = (env("EVESTACK_PROVIDER")?.trim() || "openai").toLowerCase();
  if (provider === "ollama") {
    const model = env("EVESTACK_MODEL") || "qwen3";
    const ollama = await inspectOllama(
      env("OLLAMA_BASE_URL") || "http://127.0.0.1:11434",
      [model],
    );
    if (!ollama.running) {
      stop("Ollama is not running, and this project is configured to use it.", [
        `Nothing answered at ${C.bold}${env("OLLAMA_BASE_URL") || "http://127.0.0.1:11434"}${C.reset}.`,
        "",
        "  Start Ollama (open the app, or `ollama serve`), then:",
        "",
        `    ${C.bold}ollama pull ${model}${C.reset}`,
        "",
        `${C.dim}Or switch to a hosted provider by editing EVESTACK_PROVIDER in .env.local.${C.reset}`,
      ]);
    }
    if (ollama.missing.includes(model)) {
      stop(`Ollama does not have "${model}" yet.`, [
        "The agent would fail on your first message. Pull it first:",
        "",
        `    ${C.bold}ollama pull ${model}${C.reset}`,
        "",
        `${C.dim}Models present: ${ollama.models.join(", ") || "none"}${C.reset}`,
      ]);
    }
  } else {
    const keyVar = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    if (!env(keyVar)) {
      stop(`${keyVar} is not set, so the agent has no model to call.`, [
        `This project is configured for ${C.bold}${provider}${C.reset}. Add the key to .env.local:`,
        "",
        `    ${C.bold}${keyVar}=…${C.reset}`,
        "",
        `${C.dim}Or run for free on your own machine: set EVESTACK_PROVIDER=ollama.${C.reset}`,
      ]);
    }
  }
}
