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

import { readFileSync } from "node:fs";
import { basename } from "node:path";

import {
  C,
  connectPostgres,
  dashboardTarget,
  dockerRunning,
  envValue,
  findAgent,
  inspectOllama,
  probeJson,
  readEnvFile,
  schemasPresent,
  pgvectorState,
} from "./checks.mjs";
import { blank, c, fix, g, heading, row, rule } from "./ui.mjs";

const argv = process.argv.slice(2);

/**
 * --help, answered BEFORE anything runs.
 *
 * This used to be one of the flags the file did not know, and an unknown flag
 * was simply ignored — so `npm run verify -- --help` ran the whole thing:
 * Postgres, Docker, the agent, the dashboard, an embedding probe, and then it
 * offered to open a browser. Asking a command what it does should never be the
 * thing that does it. Printed here rather than in a --help branch further down
 * because every check below has a side effect of some kind.
 */
if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(
    [
      "",
      "  npm run verify              check the stack, then offer to open the dashboard",
      "  npm run verify -- --open    open it without asking",
      "  npm run verify -- --no-open never open it (implied when not a terminal)",
      "  npm run verify -- --json    machine-readable, opens nothing",
      "",
      "  Exit code is 1 if anything required failed, so CI can run it too.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

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

// Configuration can come from `.env.local` OR the environment; a container
// deployment and CI both use the second and have no file at all. Only the
// absence of BOTH is a problem, and it shows up as a failing postgres/model
// check below rather than as a scolding about a file.
if (fileEnv) {
  pass("config", ".env.local");
} else if (process.env.WORKFLOW_POSTGRES_URL || process.env.EVESTACK_AUTH_PASSWORD) {
  pass("config", "environment variables (no .env.local, which is fine)");
} else {
  fail(
    "config",
    "no .env.local here and nothing in the environment",
    "run this from the project directory create-evestack made",
  );
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

const provider = (env("EVESTACK_PROVIDER")?.trim() || "openai").toLowerCase();
const model = env("EVESTACK_MODEL") || { openai: "gpt-5-mini", anthropic: "claude-sonnet-5", ollama: "qwen3" }[provider];

/**
 * Which provider will actually be asked for EMBEDDINGS.
 *
 * Resolved the way lib/memory.ts `readEmbedProvider()` resolves it: an explicit
 * EVESTACK_EMBED_PROVIDER first, then the chat provider, and for anthropic —
 * which has no embeddings endpoint at all — OpenAI if there is a key and nothing
 * if there is not.
 *
 * This used to be read INSIDE the `provider === "ollama"` branch, which left the
 * embedding pull-check unreachable for two of the three combinations. The one
 * that matters is the combination .env.example and the warning below both
 * RECOMMEND: EVESTACK_PROVIDER=anthropic with EVESTACK_EMBED_PROVIDER=ollama.
 * There the chat branch suppressed its "Anthropic has no embeddings" warning
 * precisely because the variable was set, and nothing ever asked Ollama whether
 * nomic-embed-text was pulled — so verify printed all green and "Everything
 * works", and the first `remember` failed. "An embedding model that was never
 * pulled" is named in this file's own header as a problem it exists to catch.
 */
const EMBED_DEFAULT_MODEL = { openai: "text-embedding-3-small", ollama: "nomic-embed-text" };
const explicitEmbed = (env("EVESTACK_EMBED_PROVIDER") || "").toLowerCase();
const embedProvider = explicitEmbed
  ? explicitEmbed
  : provider === "ollama"
    ? "ollama"
    : provider === "openai"
      ? "openai"
      : env("OPENAI_API_KEY")
        ? "openai"
        // anthropic with no OpenAI key anywhere: memory.ts refuses to start.
        : null;
const embedModel = env("EVESTACK_EMBED_MODEL") || EMBED_DEFAULT_MODEL[embedProvider];

// One Ollama call for both halves. `wanted` carries only the models this
// configuration will really ask for, so a chat-only or embeddings-only Ollama is
// never reported missing a model nobody wants.
const ollamaBaseUrl = env("OLLAMA_BASE_URL") || "http://127.0.0.1:11434";
const ollama =
  provider === "ollama" || embedProvider === "ollama"
    ? await inspectOllama(ollamaBaseUrl, [
        ...(provider === "ollama" ? [model] : []),
        ...(embedProvider === "ollama" ? [embedModel] : []),
      ])
    : null;

if (provider === "ollama") {
  if (!ollama.running) {
    fail("model", `Ollama is not answering on ${ollamaBaseUrl}`, "start Ollama, then `ollama pull " + model + "`");
  } else if (ollama.missing.includes(model)) {
    fail("model", `Ollama is up but "${model}" is not pulled`, `ollama pull ${model}`);
  } else {
    pass("model", `ollama/${model} is pulled and ready`);
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
}

// Embeddings are a separate decision from chat and a separate failure, which is
// the whole point of the block above. A warning, never a failure: memory is
// optional and nobody should be told their install is broken because they have
// not pulled a 274 MB model they may not use.
if (embedProvider === null) {
  warn(
    "memory",
    "Anthropic has no embeddings endpoint, so remember/recall cannot run",
    "set EVESTACK_EMBED_PROVIDER=ollama (then `ollama pull nomic-embed-text`), or set OPENAI_API_KEY",
  );
} else if (embedProvider !== "openai" && embedProvider !== "ollama") {
  // lib/memory.ts throws on anything else, naming the two it knows. A value it
  // will reject at the first `remember` is worth a red line here.
  fail(
    "memory",
    `EVESTACK_EMBED_PROVIDER="${explicitEmbed}" is not an embedding provider this agent knows`,
    "set it to openai or ollama, or unset it to follow EVESTACK_PROVIDER",
  );
} else if (embedProvider === "ollama") {
  if (!ollama.running) {
    warn(
      "memory",
      `embeddings are set to ollama/${embedModel}, but Ollama is not answering on ${ollamaBaseUrl}`,
      `start Ollama, then \`ollama pull ${embedModel}\``,
    );
  } else if (ollama.missing.includes(embedModel)) {
    warn(
      "memory",
      `the embedding model "${embedModel}" is not pulled, so remember/recall will fail`,
      `ollama pull ${embedModel}`,
    );
  } else {
    pass("memory", `embeddings via ollama/${embedModel}`);
  }
} else if (env("OPENAI_API_KEY")) {
  pass("memory", `embeddings via openai/${embedModel}`);
} else if (provider === "openai") {
  // The model line above already failed on this same missing key with this same
  // fix. One line per problem.
  skip("memory", "needs OPENAI_API_KEY, which the model check already reports");
} else {
  warn(
    "memory",
    `embeddings are set to openai/${embedModel}, but OPENAI_API_KEY is not set`,
    "add OPENAI_API_KEY=… to .env.local, or set EVESTACK_EMBED_PROVIDER=ollama",
  );
}

/* -------------------------------------------------------------------------- */
/* the agent                                                                   */
/* -------------------------------------------------------------------------- */

const agent = await findAgent(env("EVESTACK_AGENT_URL"), env("EVESTACK_AGENT_PORT"));
if (agent.health?.ok) {
  // "guessed" means there was no recorded port and the scan landed somewhere
  // other than the default — which on a machine running two projects may not be
  // this project's agent at all. Say so rather than quietly reporting it.
  pass(
    "agent",
    agent.guessed
      ? `answering at ${agent.url} (found by scanning — add EVESTACK_AGENT_PORT to be sure it is yours)`
      : `answering at ${agent.url}`,
  );
} else if (agent.malformed) {
  // Not "your agent is down" — nothing was probed, because the value is not a
  // URL. Saying the agent is not running would send the reader to `npm run dev`
  // for a typo in .env.local. Before the guard in `agentBaseUrl` this case did
  // not reach here at all: it threw ERR_INVALID_URL out of the middle of the run
  // and took every check that had already passed with it, unprinted.
  fail(
    "agent",
    `EVESTACK_AGENT_URL is not a URL (${agent.malformed}), so there was nothing to probe`,
    "it should look like http://127.0.0.1:2000",
  );
} else {
  fail(
    "agent",
    agent.pinned
      ? `nothing is answering at ${agent.url}, the port this project records`
      : `nothing is answering /eve/v1/health near ${agent.url}`,
    "npm run dev",
  );
}

/* -------------------------------------------------------------------------- */
/* the dashboard                                                               */
/* -------------------------------------------------------------------------- */

const ingestUrl = env("EVESTACK_DASHBOARD_URL");
const target = dashboardTarget(ingestUrl);
const dashboardUrl = target.url;

// Recorded or guessed, said out loud on the one line this check is allowed. A
// dashboard found on the default port, in a project that never wrote that port
// down, may belong to another project entirely — and on a machine where the
// scaffolder had to move this project off 4000, it certainly does. Reporting that
// as a bare green line is how `verify` came to certify a dashboard that was not
// running, connected to a database this project had never written to.
const caveat = target.recorded
  ? ""
  : target.malformed
    ? ` — EVESTACK_DASHBOARD_URL is not a URL (${target.malformed}), so the default port was assumed`
    : " — the default port, since this project records no EVESTACK_DASHBOARD_URL; set it to be sure this is yours";

const health = await probeJson(new URL("/api/health", dashboardUrl));
if (health.ok && health.body?.ok) {
  // A value that could not be parsed is a warning even though something answered,
  // precisely because the thing that answered is not the thing that was
  // configured.
  if (target.malformed) {
    warn(
      "dashboard",
      `answering at ${dashboardUrl}, database connected${caveat}`,
      "it should look like http://127.0.0.1:4000/api/ingest/v1/traces",
    );
  } else {
    pass("dashboard", `answering at ${dashboardUrl}, database connected${caveat}`);
  }

  /*
   * Is the container the one this project asked for?
   *
   * Everything above proves the dashboard is answering. None of it proves WHICH
   * dashboard — and that gap shipped: the published image sat four days and 51
   * commits behind while this line printed the same green either way, so a
   * project whose Skills page scanned the wrong directory and whose /costs and
   * /sessions pages did not exist verified perfectly.
   *
   * The compose file records the tag this project was scaffolded against, and
   * /api/health now reports the version the running image actually is. Comparing
   * two strings we already have is the whole check.
   *
   * A warn, never a fail: an operator may be running a newer image deliberately,
   * or one built locally, and a verify that refuses to go green over that would
   * be wrong more often than it was right. It just has to be SAID.
   */
  const running = typeof health.body?.version === "string" ? health.body.version : null;
  const pinned = pinnedDashboardTag();
  if (running === null) {
    warn(
      "dashboard image",
      `${dashboardUrl} reports no version, so it is older than 0.3.0 — the release that added the field`,
      "docker compose --profile dashboard pull && docker compose --profile dashboard up -d",
    );
  } else if (pinned !== null && running !== pinned) {
    warn(
      "dashboard image",
      `running ${running}, but this project's compose file pins ${pinned}`,
      `docker compose --profile dashboard pull && docker compose --profile dashboard up -d`,
    );
  } else {
    pass("dashboard image", running === pinned ? `${running}, matching the pin` : running);
  }
} else if (health.status === 0) {
  fail(
    "dashboard",
    `nothing is answering at ${dashboardUrl}${caveat}`,
    "docker compose --profile dashboard up -d",
  );
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

/**
 * The eleven checks, in three named groups plus the "other" catch-all.
 *
 * A flat list of eleven lines made every check look equally important and equally
 * urgent, so a red `dashboard` and a red `postgres` read the same — when one of
 * them is why the other failed. Grouping them in dependency order says, without
 * a sentence, that the thing to fix is the highest red line.
 *
 * Any check not named here still prints, under "other": a group table that
 * silently drops a check would be the worst possible bug in a verifier.
 */
const GROUPS = [
  ["foundation", ["config", "docker", "postgres", "schema", "pgvector"]],
  ["model", ["model", "memory"]],
  ["the stack", ["agent", "dashboard", "traces"]],
];

const MARK = { pass: g.OK, fail: g.FAIL, warn: g.WARN, skip: g.SKIP };

blank();
heading("verify", basename(process.cwd()));

/**
 * Wide enough for the longest label actually printed, and never narrower than
 * the 12 the rest of the CLI lines up on.
 *
 * `pad` pads a string to a width; it does not guarantee a gap after it. The
 * longest label here is "dashboard image" at 15 characters against a hardcoded
 * 12, so every healthy run printed a version welded to its label:
 * `✓ dashboard image0.3.1`. Derived from the results rather than bumped to 16,
 * because the next check with a long name would silently do it again.
 */
const LABEL_WIDTH = Math.max(12, ...results.map((r) => r.name.length + 1));

const grouped = new Set(GROUPS.flatMap(([, names]) => names));
const sections = [
  ...GROUPS,
  ["other", results.map((r) => r.name).filter((n) => !grouped.has(n))],
];

for (const [title, names] of sections) {
  const rows = names.map((n) => results.find((r) => r.name === n)).filter(Boolean);
  if (rows.length === 0) continue;
  blank();
  console.log(`    ${C.dim}${title}${C.reset}`);
  for (const r of rows) {
    row(MARK[r.state], r.name, r.state === "fail" ? c.red(r.detail) : c.dim(r.detail), "", {
      indent: 6, labelWidth: LABEL_WIDTH,
    });
    // The fix is the only thing on this screen anyone is meant to type, so it
    // is bold and on its own line rather than a dim `fix:` prefix inline.
    if (r.fix) fix(r.fix, { indent: 8 });
  }
}
blank();

if (failed.length > 0) {
  rule();
  const counts = [
    c.redBold(`${failed.length} failed`),
    ...(warned.length ? [c.yellow(`${warned.length} warning${warned.length === 1 ? "" : "s"}`)] : []),
    c.dim(`${results.filter((r) => r.state === "pass").length} passed`),
  ];
  console.log(`  ${counts.join(c.dim(" · "))}`);
  blank();
  console.log(`  ${c.dim("Fix the highest red line and run")} ${c.bold("evestack verify")} ${c.dim("again.")}`);
  blank();
  process.exit(1);
}

const user = env("EVESTACK_AUTH_USER") ?? "evestack";
const password = env("EVESTACK_AUTH_PASSWORD");

rule();
console.log(
  `  ${c.greenBold("Everything works.")}` +
    (warned.length ? ` ${c.yellow(`${warned.length} optional thing${warned.length === 1 ? "" : "s"} to know about, above.`)}` : ""),
);
blank();
console.log(`  ${c.bold("Dashboard")}   ${c.brandBold(dashboardUrl)}`);
if (password) console.log(`  ${c.bold("Sign in")}     ${user} ${c.dim("/")} ${password}`);
console.log(`  ${c.dim("Sessions, live chat, approvals, memory and cost — all read from your own Postgres.")}`);
blank();
// One command, not a three-line curl. The tour does the same thing and then
// explains what happened, which is what someone running verify for the first
// time is actually after.
console.log(`  ${c.dim("Never used it before?")}  ${c.bold("evestack tour")}  ${c.dim("— sends a first message and follows it")}`);
console.log(`  ${c.dim("through the dashboard. One model call.")}`);
blank();

/* -------------------------------------------------------------------------- */
/* open it                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Opening a browser is the one thing here with a side effect outside this
 * terminal, so it is opt-in on a TTY and never happens in CI, in a pipe, or
 * under --json. `open`/`xdg-open`/`start` cover macOS, Linux and Windows; if
 * none of them exist the URL is already printed above.
 */
/**
 * The dashboard image tag this project's own compose file asks for.
 *
 * Read from the file rather than from an env var, because the compose file is
 * what `docker compose up` obeys — an env var would let the check pass while
 * the thing being started disagreed with it. `EVESTACK_DASHBOARD_IMAGE` wins
 * over the default when set, and that is deliberately NOT read here: someone
 * who overrode the image knows what they are running, and the comparison this
 * feeds is only interesting against the pin the scaffolder wrote.
 *
 * `null` when there is no compose file (an `attach`ed project may have none) or
 * no recognisable tag, and the caller says so rather than guessing.
 */
function pinnedDashboardTag() {
  try {
    const raw = readFileSync("docker-compose.yml", "utf8");
    return /evestack-dashboard:([0-9][0-9A-Za-z.\-+]*)/.exec(raw)?.[1] ?? null;
  } catch {
    return null;
  }
}

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
