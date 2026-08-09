/**
 * `evestack status` — is it working, and if not, what do I type.
 *
 * The command that did not exist and should have. A bare `evestack` printed
 * thirty-eight lines of usage and exited 2; the answer to "is my stack up?" was
 * `evestack verify`, which is a different question — verify is a pre-flight that
 * talks to Docker, probes an OTLP ingest route and can take a couple of seconds
 * per check. Status is the glance: four parallel probes, a short timeout, and
 * one fix command under anything red.
 *
 * The division of labour, stated because two commands that both "check things"
 * will otherwise grow into each other:
 *
 *   status   is it running right now, and where           (fast, read-only)
 *   verify   is it configured correctly, part by part     (thorough, pre-flight)
 *   doctor   a run stopped moving — why                   (forensic, Postgres)
 *
 * Read-only, like doctor: the Postgres connection is pinned
 * `default_transaction_read_only = on` by the same helper, so pointing this at a
 * production database is safe.
 */
import { spawnSync } from "node:child_process";

import { c, fixLine, forHumans, g, headingLine, rowLine, shortPath } from "create-evestack/ui";

import { connect, DoctorError } from "./db.mjs";
import { findProjectEnv, notAProject, projectEnv, wantsHelp } from "./project.mjs";

/** Short: this is the glance. A part that takes longer than this to answer is,
 *  for the purpose of the question being asked, not answering. */
const PROBE_MS = 2500;

export const STATUS_USAGE = `evestack status — is the stack up, and if not, what to run

  evestack status [--json]

Four probes in parallel — the agent, Postgres, the dashboard and the model
configuration — and the command that fixes anything that is down. Read-only:
nothing is started, stopped or written. Works from anywhere inside the project.

Options
  --json          machine-readable
  -h, --help      this

Exit codes
  0  everything this project needs is answering
  1  something is down, and it printed what to run
  2  not an evestack project

  \`evestack verify\` is the thorough version — configuration, not liveness.
  \`evestack doctor\` is for when everything is up and a run still will not move.
`;

/* -------------------------------------------------------------------------- */
/* probes                                                                      */
/* -------------------------------------------------------------------------- */

/** A GET that answers instead of throwing. */
async function reachable(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_MS) });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, status: 0, error: error?.name === "TimeoutError" ? "timed out" : "refused" };
  }
}

/**
 * Every probe at once. Exported because `tour` refuses to start against a stack
 * that is not up, and it must refuse for the same reasons and with the same
 * fixes that `status` reports — a tour that says "agent unreachable" while
 * status says "not answering — npm run dev" is two tools disagreeing about one
 * socket.
 */
export async function probeAll(env) {
  const [agent, postgres, dashboard] = await Promise.all([
    probeAgent(env),
    probePostgres(env),
    probeDashboard(env),
  ]);
  return { agent, postgres, dashboard, model: probeModel(env) };
}

async function probeAgent(env) {
  const explicit = env("EVESTACK_AGENT_URL");
  const port = env("EVESTACK_AGENT_PORT") || "2000";
  let base = explicit || `http://127.0.0.1:${port}`;
  try {
    base = new URL(base).origin;
  } catch {
    return { part: "agent", state: "fail", detail: `EVESTACK_AGENT_URL is not a URL (${explicit})`,
             fix: "it should look like http://127.0.0.1:2000", where: explicit };
  }
  const health = await reachable(new URL("/eve/v1/health", base));
  return health.ok
    ? { part: "agent", state: "ok", where: `:${new URL(base).port || 80}`, detail: "answering" }
    : { part: "agent", state: "fail", where: `:${new URL(base).port || 80}`,
        detail: "not answering", fix: "npm run dev" };
}

async function probeDashboard(env) {
  const ingest = env("EVESTACK_DASHBOARD_URL");
  let base = "http://127.0.0.1:4000";
  if (ingest) {
    try {
      base = new URL(ingest).origin;
    } catch {
      /* keep the default; verify is the command that complains about the value */
    }
  }
  const port = `:${new URL(base).port || 80}`;
  const health = await reachable(new URL("/api/health", base));
  if (health.ok) return { part: "dashboard", state: "ok", where: port, detail: "healthy", url: base };
  if (health.status === 503) {
    return { part: "dashboard", state: "fail", where: port, url: base,
             detail: "up, but answering 503 — its credentials are missing",
             fix: "docker compose --profile dashboard up -d --force-recreate dashboard" };
  }
  return { part: "dashboard", state: "fail", where: port, url: base, detail: "not answering",
           fix: "docker compose --profile dashboard up -d" };
}

/**
 * Postgres, plus the two things about it worth knowing at a glance: whether the
 * schema was ever created, and how much is in it.
 *
 * "Connected but no schema" is its own state and its own fix — forgetting
 * `db:bootstrap` is one of the two mistakes scripts/dev.mjs was written to
 * catch, and reporting it as a plain green tick is how someone spends ten
 * minutes on an agent that starts and then fails on its first turn.
 */
async function probePostgres(env) {
  const url = env("WORKFLOW_POSTGRES_URL");
  if (!url) {
    return { part: "postgres", state: "fail", detail: "WORKFLOW_POSTGRES_URL is not set",
             fix: "copy the line from .env.example" };
  }
  let where = "";
  try {
    const parsed = new URL(url);
    where = `:${parsed.port || 5432}`;
  } catch {
    return { part: "postgres", state: "fail", detail: "WORKFLOW_POSTGRES_URL is not a URL",
             fix: "check the line in .env.local" };
  }

  let session;
  try {
    session = await connect({ connectionString: url, timeoutMs: PROBE_MS });
  } catch (error) {
    return { part: "postgres", state: "fail", where, detail: "not answering",
             fix: "docker compose up -d postgres",
             note: error instanceof DoctorError ? undefined : error?.message };
  }

  const { client } = session;
  try {
    const { rows } = await client.query(
      `select
         (select count(*) from information_schema.tables
           where table_schema = 'workflow' and table_name = 'workflow_runs')  as has_schema,
         (select count(*) from information_schema.tables
           where table_schema = 'evestack' and table_name = 'memories')       as has_memories`,
    );
    if (Number(rows[0].has_schema) === 0) {
      return { part: "postgres", state: "fail", where,
               detail: "connected, but the workflow schema was never created",
               fix: "npm run db:bootstrap" };
    }

    // Rows without `$eve.type` are eve's own internal bookkeeping, not runs
    // anybody started — counting them makes an idle project look busy.
    const counts = await client.query(
      `select (select count(*) from workflow.workflow_runs
                where attributes->>'$eve.type' is not null) as runs`,
    );
    const runs = Number(counts.rows[0].runs);
    let memories = null;
    if (Number(rows[0].has_memories) > 0) {
      memories = Number((await client.query("select count(*) from evestack.memories")).rows[0].count);
    }
    const parts = [`${runs.toLocaleString()} run${runs === 1 ? "" : "s"}`];
    if (memories !== null) parts.push(`${memories.toLocaleString()} ${memories === 1 ? "memory" : "memories"}`);
    return { part: "postgres", state: "ok", where, detail: parts.join(` ${g.skip} `) };
  } catch (error) {
    return { part: "postgres", state: "warn", where, detail: `connected, but ${error.message}` };
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * The model, from configuration only.
 *
 * Deliberately not called. verify.mjs states the rule and it holds here twice
 * over: "a verify command that spends money the first time you run it is a
 * verify command people stop running" — and status is meant to be typed often.
 */
function probeModel(env) {
  const provider = (env("EVESTACK_PROVIDER") || "openai").toLowerCase();
  const model =
    env("EVESTACK_MODEL") ||
    { openai: "gpt-5-mini", anthropic: "claude-sonnet-5", ollama: "qwen3" }[provider] ||
    "unknown";
  if (provider === "ollama") {
    return { part: "model", state: "ok", where: provider, detail: `${model} ${c.dim("(local)")}` };
  }
  const keyVar = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  return env(keyVar)
    ? { part: "model", state: "ok", where: provider, detail: model }
    : { part: "model", state: "fail", where: provider,
        detail: `${model} — ${keyVar} is not set`, fix: `add ${keyVar}=… to .env.local` };
}

function dockerRunning() {
  return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
}

/* -------------------------------------------------------------------------- */
/* the command                                                                 */
/* -------------------------------------------------------------------------- */

export async function status(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  if (wantsHelp(argv)) {
    stdout.write(STATUS_USAGE);
    return 0;
  }

  const found = findProjectEnv();
  if (!found) return notAProject(stderr);
  const env = projectEnv(found);
  const name = found.dir.split(/[\\/]/).filter(Boolean).pop() ?? "project";

  // In parallel. Four sequential probes at a 2.5s timeout is a ten-second
  // "glance" on a machine where nothing is running, which is precisely the
  // machine where someone is typing this repeatedly.
  const { agent, postgres, dashboard, model } = await probeAll(env);
  const results = [agent, postgres, dashboard, model];

  if (argv.includes("--json")) {
    const down = results.filter((r) => r.state === "fail");
    stdout.write(`${JSON.stringify({ ok: down.length === 0, project: name, dir: found.dir, results }, null, 2)}\n`);
    return down.length === 0 ? 0 : 1;
  }

  const GLYPH = { ok: c.green(g.dot), warn: c.yellow(g.dot), fail: c.red(g.dot) };

  // Built as lines and written once, to the stdout this function was handed.
  // Printing straight to process.stdout would make the parameter a lie on the
  // human path — which it was, and a test asserting on the report got an empty
  // sink while the real output went past it to the terminal.
  const lines = ["", headingLine(name, shortPath(found.dir)), ""];
  for (const r of results) {
    const detail = r.state === "fail" ? c.red(r.detail) : c.dim(r.detail);
    lines.push(rowLine(GLYPH[r.state], r.part, `${c.dim(pad10(r.where ?? ""))}${detail}`, "", { indent: 4 }));
    if (r.note) lines.push(`      ${c.dim(r.note)}`);
    if (r.fix) lines.push(fixLine(r.fix, { indent: 6 }));
  }
  lines.push("");

  const down = results.filter((r) => r.state === "fail");
  if (down.length === 0) {
    const url = forHumans(dashboard.url ?? "http://localhost:4000");
    lines.push(
      `  ${c.greenBold("Everything is up.")}  ${c.dim("Your dashboard:")} ${c.brand(url)}`,
      `  ${c.dim(`${g.arrow} `)}${c.bold("evestack open")}${c.dim("   sign in, with the password printed for you")}`,
      "",
    );
    stdout.write(`${lines.join("\n")}\n`);
    return 0;
  }

  // One cause, one fix. When both containers are missing at once the honest
  // answer is usually not two compose commands — it is that Docker is not
  // running, and saying so beats sending someone to a command that will fail.
  const containersDown = postgres.state === "fail" && dashboard.state === "fail";
  if (containersDown && !dockerRunning()) {
    lines.push(
      `  ${c.yellowBold("Docker is not running")}${c.dim(" — Postgres and the dashboard both live in it.")}`,
      `  ${c.dim(`${g.arrow} `)}${c.bold("Start Docker Desktop, then run this again.")}`,
      "",
    );
    stdout.write(`${lines.join("\n")}\n`);
    return 1;
  }

  const n = down.length;
  lines.push(
    `  ${c.redBold(`${n} ${n === 1 ? "part is" : "parts are"} down.`)} ` +
      c.dim(`Run the ${n === 1 ? "line above" : "first line above"}, then ${"`evestack status`"} again.`),
    `  ${c.dim(`${"`evestack verify`"} checks configuration too, and says more about why.`)}`,
    "",
  );
  stdout.write(`${lines.join("\n")}\n`);
  return 1;
}

/** Ports and provider names sit in their own narrow column so the details line
 *  up whether a row says ":5433" or "anthropic". */
function pad10(s) {
  return `${s}${" ".repeat(Math.max(1, 11 - s.length))}`;
}
