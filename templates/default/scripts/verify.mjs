#!/usr/bin/env node
/**
 * `npm run verify` — prove the stack works, or say exactly which part does not.
 *
 * Until this existed there was no answer to "did that work?". You ran five
 * commands, watched a framework print `[DEV] server listening`, three
 * channel-idle warnings and a bundler notice about `eval`, and then had to know
 * on your own to `curl /eve/v1/health`. Every genuine problem found while
 * testing this project — an unpublished container port, an embedding model that
 * was never pulled, an ingest token that did not match, a dashboard that 403s
 * every write — looked identical from the outside: nothing obviously wrong, and
 * nothing working.
 *
 * So the rules here are:
 *
 *   - One line per check, green or red, no spinner and no prose in between.
 *   - A red line always carries the command that fixes it. A check that can
 *     only say "failed" is not worth printing.
 *   - Things that are optional say "skipped", never "failed". Nobody should be
 *     told their install is broken because they have not configured Composio.
 *   - It ends by telling you where to click, and offers to open it.
 *
 * Exit code is 1 if anything required failed, so CI can run it too.
 *
 *   npm run verify              check, then offer to open the dashboard
 *   npm run verify -- --open    open it without asking
 *   npm run verify -- --no-open never open it (implied when not a terminal)
 *   npm run verify -- --json    machine-readable, opens nothing
 */
import { spawn } from "node:child_process";

import {
  C,
  connectPostgres,
  dockerRunning,
  envValue,
  findAgent,
  inspectOllama,
  probeJson,
  readEnvFile,
  schemasPresent,
  pgvectorState,
} from "./checks.mjs";

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const openFlag = argv.includes("--open");
const noOpen = argv.includes("--no-open") || asJson;

const results = [];
const pass = (name, detail) => results.push({ name, state: "pass", detail });
const fail = (name, detail, fix) => results.push({ name, state: "fail", detail, fix });
const warn = (name, detail, fix) => results.push({ name, state: "warn", detail, fix });
const skip = (name, detail) => results.push({ name, state: "skip", detail });

const fileEnv = readEnvFile();
const env = (key) => envValue(fileEnv, key);

/* -------------------------------------------------------------------------- */
/* configuration                                                               */
/* -------------------------------------------------------------------------- */

if (!fileEnv) {
  fail(
    "project",
    "no .env.local in this directory",
    "run this from the project directory create-evestack made",
  );
} else {
  pass("project", ".env.local found");
}

/* -------------------------------------------------------------------------- */
/* docker + postgres                                                           */
/* -------------------------------------------------------------------------- */

const docker = dockerRunning();
if (docker) pass("docker", "daemon is responding");
else fail("docker", "daemon is not responding", "start Docker Desktop");

const pgUrl = env("WORKFLOW_POSTGRES_URL");
let client = null;

if (!pgUrl) {
  fail(
    "postgres",
    "WORKFLOW_POSTGRES_URL is not set",
    "copy the line from .env.example — without it sessions are not durable",
  );
} else {
  const where = (() => {
    try {
      const u = new URL(pgUrl);
      return `${u.hostname}:${u.port || 5432}`;
    } catch {
      return "(unparseable URL)";
    }
  })();
  const probe = await connectPostgres(pgUrl);
  if (probe.ok) {
    client = probe.client;
    pass("postgres", `reachable at ${where}`);
  } else {
    fail(
      "postgres",
      `${where} refused the connection — ${probe.error}`,
      // The published-port-missing case is invisible in `docker compose ps`,
      // which reports the container healthy, so the recreate is named up front.
      "docker compose up -d postgres   (already 'Up'? docker compose up -d --force-recreate postgres)",
    );
  }
}

if (client) {
  const schemas = await schemasPresent(client);
  if (schemas.has("workflow")) {
    pass("schema", "workflow tables exist");
  } else {
    fail("schema", "the workflow schema has not been created", "npm run db:bootstrap");
  }

  const vector = await pgvectorState(client);
  if (vector === "installed") pass("pgvector", "installed — long-term memory can store vectors");
  else if (vector === "available")
    pass("pgvector", "available; the memory tools create the extension on first use");
  else
    warn(
      "pgvector",
      "this Postgres has no pgvector",
      "use the pgvector/pgvector image (the generated compose file already does)",
    );
}

/* -------------------------------------------------------------------------- */
/* model provider                                                              */
/* -------------------------------------------------------------------------- */

const provider = (env("EVESTACK_PROVIDER") || "openai").toLowerCase();
const model = env("EVESTACK_MODEL") || { openai: "gpt-5-mini", anthropic: "claude-sonnet-5", ollama: "qwen3" }[provider];

if (provider === "ollama") {
  const baseUrl = env("OLLAMA_BASE_URL") || "http://127.0.0.1:11434";
  // The embedding model is a SEPARATE pull and only matters if memory is used,
  // so it is checked separately and reported as a warning, not a failure.
  const embedProvider = (env("EVESTACK_EMBED_PROVIDER") || "ollama").toLowerCase();
  const embedModel = env("EVESTACK_EMBED_MODEL") || "nomic-embed-text";
  const wanted = embedProvider === "ollama" ? [model, embedModel] : [model];
  const ollama = await inspectOllama(baseUrl, wanted);

  if (!ollama.running) {
    fail("model", `Ollama is not answering on ${baseUrl}`, "start Ollama, then `ollama pull " + model + "`");
  } else if (ollama.missing.includes(model)) {
    fail("model", `Ollama is up but "${model}" is not pulled`, `ollama pull ${model}`);
  } else {
    pass("model", `ollama/${model} is pulled and ready`);
    if (embedProvider === "ollama" && ollama.missing.includes(embedModel)) {
      warn(
        "memory",
        `the embedding model "${embedModel}" is not pulled, so remember/recall will fail`,
        `ollama pull ${embedModel}`,
      );
    } else {
      pass("memory", `embeddings via ollama/${embedModel}`);
    }
  }
} else {
  const keyVar = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  if (env(keyVar)) {
    // Not called. A verify command that spends money the first time you run it
    // is a verify command people stop running.
    pass("model", `${provider}/${model}, ${keyVar} is set`);
  } else {
    fail("model", `${keyVar} is not set`, `add ${keyVar}=… to .env.local`);
  }
  if (provider === "anthropic" && !env("OPENAI_API_KEY") && (env("EVESTACK_EMBED_PROVIDER") || "") !== "ollama") {
    warn(
      "memory",
      "Anthropic has no embeddings endpoint, so remember/recall cannot run",
      "set EVESTACK_EMBED_PROVIDER=ollama (then `ollama pull nomic-embed-text`), or set OPENAI_API_KEY",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* the agent                                                                   */
/* -------------------------------------------------------------------------- */

const agent = await findAgent(env("EVESTACK_AGENT_URL"));
if (agent.health?.ok) {
  pass("agent", `answering at ${agent.url}`);
} else {
  fail("agent", `nothing is answering /eve/v1/health near ${agent.url}`, "npm run dev");
}

/* -------------------------------------------------------------------------- */
/* the dashboard                                                               */
/* -------------------------------------------------------------------------- */

const ingestUrl = env("EVESTACK_DASHBOARD_URL");
const dashboardUrl = ingestUrl
  ? new URL(ingestUrl).origin.replace("127.0.0.1", "localhost")
  : "http://localhost:4000";

const health = await probeJson(new URL("/api/health", dashboardUrl));
if (health.ok && health.body?.ok) {
  pass("dashboard", `answering at ${dashboardUrl}, database connected`);
} else if (health.status === 0) {
  fail("dashboard", `nothing is answering at ${dashboardUrl}`, "docker compose --profile dashboard up -d");
} else {
  fail(
    "dashboard",
    `unhealthy (HTTP ${health.status}${health.body?.database ? `, database ${health.body.database}` : ""})`,
    "docker compose logs dashboard",
  );
}

/* -------------------------------------------------------------------------- */
/* the shared secret between the two halves                                    */
/* -------------------------------------------------------------------------- */

const token = env("EVESTACK_INGEST_TOKEN");
if (!health.ok) {
  // "not up" would be wrong for the 503 case, where the dashboard is answering
  // and is the thing reporting a problem.
  skip("traces", "needs a healthy dashboard to test against");
} else if (!token) {
  skip("traces", "EVESTACK_INGEST_TOKEN is not set, so trace export is off");
} else {
  // An empty OTLP payload. Valid, stores nothing, and the only thing it can
  // tell us apart is 401 (wrong token) from 2xx (right token) — which is
  // exactly the failure that is otherwise invisible, because the OTLP exporter
  // reports a 401 to the agent as a SUCCESSFUL export and the dashboard just
  // looks like it has no traces yet.
  const ingest = await probeJson(new URL("/api/ingest/v1/traces", dashboardUrl), {
    method: "POST",
    headers: { "content-type": "application/json", "x-evestack-ingest-token": token },
    body: JSON.stringify({ resourceSpans: [] }),
  });
  if (ingest.status === 401) {
    fail(
      "traces",
      "the dashboard rejected this project's EVESTACK_INGEST_TOKEN",
      "both halves read .env.local — restart the dashboard: docker compose --profile dashboard up -d --force-recreate dashboard",
    );
  } else if (ingest.status === 0) {
    fail("traces", `the ingest route did not answer — ${ingest.error}`, "docker compose logs dashboard");
  } else {
    pass("traces", "the agent's ingest token is accepted by the dashboard");
  }
}

/* -------------------------------------------------------------------------- */
/* report                                                                      */
/* -------------------------------------------------------------------------- */

const failed = results.filter((r) => r.state === "fail");
const warned = results.filter((r) => r.state === "warn");

if (client) await client.end().catch(() => {});

if (asJson) {
  console.log(JSON.stringify({ ok: failed.length === 0, dashboardUrl, agentUrl: agent.url, results }, null, 2));
  process.exit(failed.length === 0 ? 0 : 1);
}

const MARK = {
  pass: `${C.green}✓${C.reset}`,
  fail: `${C.red}✗${C.reset}`,
  warn: `${C.yellow}!${C.reset}`,
  skip: `${C.dim}–${C.reset}`,
};

console.log(`\n${C.cyan}${C.bold}  evestack verify${C.reset}\n`);
for (const r of results) {
  console.log(`  ${MARK[r.state]} ${r.name.padEnd(10)} ${r.detail}`);
  if (r.fix) console.log(`    ${C.dim}fix:${C.reset} ${C.bold}${r.fix}${C.reset}`);
}
console.log();

if (failed.length > 0) {
  console.log(
    `  ${C.red}${C.bold}${failed.length} check${failed.length === 1 ? "" : "s"} failed.${C.reset} ` +
      `${C.dim}Fix the first one and run \`npm run verify\` again.${C.reset}\n`,
  );
  process.exit(1);
}

const user = env("EVESTACK_AUTH_USER") ?? "evestack";
const password = env("EVESTACK_AUTH_PASSWORD");

console.log(`  ${C.green}${C.bold}Everything works.${C.reset}${warned.length ? ` ${C.yellow}(${warned.length} optional thing to know about)${C.reset}` : ""}\n`);
console.log(`  ${C.bold}Your dashboard${C.reset}  ${dashboardUrl}`);
if (password) console.log(`  ${C.bold}Sign in${C.reset}         ${user} ${C.dim}/${C.reset} ${password}`);
console.log(`  ${C.dim}Sessions, live chat, approvals, memory and cost — all read from your own Postgres.${C.reset}`);
console.log();
console.log(`  ${C.bold}Talk to the agent from a terminal${C.reset}`);
console.log(`    ${C.dim}curl -X POST ${agent.url}/eve/v1/session \\${C.reset}`);
console.log(`    ${C.dim}  -H 'content-type: application/json' \\${C.reset}`);
console.log(`    ${C.dim}  -d '{"message":"say hello"}'${C.reset}`);
console.log();

/* -------------------------------------------------------------------------- */
/* open it                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Opening a browser is the one thing here with a side effect outside this
 * terminal, so it is opt-in on a TTY and never happens in CI, in a pipe, or
 * under --json. `open`/`xdg-open`/`start` cover macOS, Linux and Windows; if
 * none of them exist the URL is already printed above.
 */
function openBrowser(url) {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}

if (noOpen) process.exit(0);

if (openFlag) {
  openBrowser(dashboardUrl);
  process.exit(0);
}

if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(0);

const { createInterface } = await import("node:readline/promises");
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await Promise.race([
  rl.question(`  ${C.bold}?${C.reset} Open the dashboard now? ${C.dim}(Y/n)${C.reset} `),
  new Promise((resolve) => rl.once("close", () => resolve(null))),
]);
rl.close();
if (answer !== null && !answer.trim().toLowerCase().startsWith("n")) {
  openBrowser(dashboardUrl);
  console.log(`  ${C.dim}Opened ${dashboardUrl}${C.reset}\n`);
}
