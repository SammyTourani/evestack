/**
 * `evestack status` — is it working, and if not, what do I type.
 *
 * The command that did not exist and should have. A bare `evestack` printed
 * thirty-eight lines of usage and exited 2; the answer to "is my stack up?" was
 * `evestack verify`, which is a different question — verify is a pre-flight that
 * talks to Docker, probes an OTLP ingest route and can take a couple of seconds
 * per check. Status is the glance: three parallel probes plus a configuration
 * read, a short timeout, and one fix command under anything red.
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

import { c, fixLine, forHumans, g, headingLine, plain, rowLine, shortPath } from "create-evestack/ui";

import { classifyConnectFailure, connect, DoctorError } from "./db.mjs";
import { findProjectEnv, notAProject, projectEnv, wantsHelp } from "./project.mjs";

/** Short: this is the glance. A part that takes longer than this to answer is,
 *  for the purpose of the question being asked, not answering. */
const PROBE_MS = 2500;

export const STATUS_USAGE = `evestack status — is the stack up, and if not, what to run

  evestack status [--json]

Four parts — the agent, Postgres and the dashboard probed in parallel, plus the
model configuration, which is read rather than called — and the command that
fixes anything that is down. Read-only: nothing is started, stopped or written.
Works from anywhere inside the project.

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

/**
 * A GET that answers instead of throwing.
 *
 * `status: 0` is reserved for "nothing answered at all" — refused, or timed
 * out. Any other number means something is listening and replied, which is a
 * different problem with a different fix, and every probe below now depends on
 * being able to tell those two apart.
 */
async function reachable(url, { wantBody = false } = {}) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_MS) });
    const answer = { ok: response.ok, status: response.status };
    // Only when asked, only on a failure, and only when the server says it is
    // JSON: an HTML error page from a proxy in front is not worth reading into
    // memory on a command whose whole promise is that it is a glance.
    if (wantBody && !response.ok && response.headers.get("content-type")?.includes("application/json")) {
      answer.body = await response.json().catch(() => undefined);
    }
    return answer;
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
  if (health.ok) return { part: "agent", state: "ok", where: portLabel(base), detail: "answering" };
  // Something replied, so the port is not empty and `npm run dev` cannot help:
  // a second agent would fail to bind it. eve's own health handler is an
  // unconditional 200 — `{ok, status: "ready", workflowId}`, with no failure
  // branch in it — so a non-2xx here is never a sick agent. It is a different
  // process, a proxy, or a build that never mounted the route. Calling a socket
  // that answered "not answering" is the same false claim the Postgres row made.
  if (health.status !== 0) {
    return { part: "agent", state: "fail", where: portLabel(base),
             detail: `something answered ${health.status} here, and it is not an eve agent`,
             fix: "check what is already on this port, or set EVESTACK_AGENT_PORT" };
  }
  return { part: "agent", state: "fail", where: portLabel(base),
           detail: "not answering", fix: "npm run dev" };
}

/**
 * A URL only if it is one we can actually fetch.
 *
 * `new URL` accepts any scheme, so it is not a validator on its own — see the
 * note in probeDashboard about `localhost:4000`.
 */
function httpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * The `:port` a human would recognise, defaulted from the scheme.
 *
 * `new URL("https://dash.example.com").port` is the empty string — the port is
 * implied, not absent — so `|| 80` reported every https deployment as `:80`.
 * The row was otherwise correct, which is what made it easy to read past.
 */
function portLabel(base) {
  const url = new URL(base);
  return `:${url.port || (url.protocol === "https:" ? 443 : 80)}`;
}

async function probeDashboard(env) {
  const ingest = env("EVESTACK_DASHBOARD_URL");
  let base = "http://127.0.0.1:4000";
  if (ingest) {
    const parsed = httpUrl(ingest);
    // Only when it parsed AND speaks http(s). `new URL("localhost:4000")` — the
    // single most likely way to get this variable wrong — does NOT throw: it
    // parses as protocol `localhost:` with origin "null", so the old try/catch
    // never fired, `new URL("/api/health", "null")` threw one frame later, and
    // `evestack status` died with a bare "Invalid URL" and exit 1. The guard was
    // written for exactly this value and could not see it.
    if (parsed) base = parsed.origin;
    /* otherwise keep the default; verify is the command that complains about it */
  }
  const port = portLabel(base);
  const health = await reachable(new URL("/api/health", base), { wantBody: true });
  if (health.ok) return { part: "dashboard", state: "ok", where: port, detail: "healthy", url: base };
  const row = { part: "dashboard", state: "fail", where: port, url: base };
  if (health.status !== 0) return { ...row, ...unhealthyDashboard(health) };
  return { ...row, detail: "not answering", fix: "docker compose --profile dashboard up -d" };
}

/**
 * Which of the dashboard's not-ok states this is, read off its own answer.
 *
 * app/api/health/route.ts has four of them and every one leaves on a 503. This
 * row asserted the first for all four — "its credentials are missing", fixed by
 * force-recreating the container — which is wrong three times out of four, and
 * wrong in the expensive direction: it recreates a container that was never the
 * problem, nothing changes, and the next run says the same thing. The body was
 * naming the actual state the whole time.
 *
 * That body is the contract: `status` names the state, `reason` narrows the
 * degraded one, and a dashboard that cannot reach Postgres carries neither.
 */
function unhealthyDashboard(health) {
  const body = health.body ?? {};
  switch (body.reason ?? body.status) {
    case "unconfigured":
      return { detail: "up, but EVESTACK_AUTH_PASSWORD is not set, so it serves no page but /signin",
               fix: "docker compose --profile dashboard up -d --force-recreate dashboard" };
    case "schema-missing":
      return { detail: "up and connected, but the workflow schema was never created",
               fix: "npm run db:bootstrap" };
    case "schema-too-new":
      return { detail: "up, but older than its own database — traces and costs cannot be served",
               fix: "docker compose --profile dashboard pull && docker compose --profile dashboard up -d" };
    default:
      // Its database, not its container. Recreating the dashboard here would
      // restart the one process in the pair that was working.
      if (body.database === "unreachable") {
        return { detail: "up, but it cannot reach Postgres", fix: "docker compose up -d postgres" };
      }
      return { detail: `up, but answering ${health.status}`, note: body.error,
               fix: "docker compose logs dashboard" };
  }
}

/**
 * A connection that did not open, split the way `doctor` splits it.
 *
 * Every one of these used to be "not answering — docker compose up -d
 * postgres". On the case that matters most that is false twice over: a server
 * which answers a startup packet and then rejects the password IS answering,
 * and starting a second one cannot help. That is the defect that made `doctor`
 * unusable and cost a tester an afternoon, and it was still sitting here.
 *
 * `classifyConnectFailure` is the judgement doctor already makes, on the same
 * error, so the two commands cannot disagree about one socket. What is not
 * shared is the wording: doctor's paragraph explains, and a status row has to
 * fit on one line with one thing to type under it.
 *
 * `connect` wraps the driver's error in a DoctorError, so the thing worth
 * classifying is the cause rather than the wrapper.
 */
function postgresFailureRow(error) {
  const cause = error?.cause ?? error;

  // Not a database problem at all — this process cannot load the driver.
  // `docker compose up -d postgres` would start a database it still could not
  // open a socket to.
  if (cause?.code === "ERR_MODULE_NOT_FOUND") {
    return { state: "fail", detail: "cannot load the `pg` driver, so nothing was asked",
             fix: "npm i -g evestack" };
  }

  switch (classifyConnectFailure(cause)) {
    case "credentials":
      return { state: "fail", detail: "up, and it rejected these credentials",
               fix: "check the user and password in WORKFLOW_POSTGRES_URL" };
    case "no-database":
      return { state: "fail", detail: "up, but that database does not exist",
               fix: "check the name after the last / in WORKFLOW_POSTGRES_URL" };
    case "refused":
      // The server's own SQLSTATE is the only honest thing to lead with here:
      // 53300 and 57P03 are different afternoons, and doctor prints the rest.
      return { state: "fail", detail: `up, and it refused the connection (${cause?.code ?? "unknown"})`,
               note: cause?.message, fix: "evestack doctor" };
    default:
      return { state: "fail", detail: "not answering", fix: "docker compose up -d postgres",
               note: error instanceof DoctorError ? undefined : error?.message };
  }
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
    return { part: "postgres", where, ...postgresFailureRow(error) };
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
  const provider = (env("EVESTACK_PROVIDER")?.trim() || "openai").toLowerCase();
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

  // In parallel. Three sequential probes at the 2.5s PROBE_MS timeout is a
  // seven-and-a-half-second "glance" on a machine where nothing is running,
  // which is precisely the machine where someone is typing this repeatedly.
  // The fourth row, model, is read from configuration and never waits, so the
  // worst case here is one timeout rather than three.
  const { agent, postgres, dashboard, model } = await probeAll(env);
  const results = [agent, postgres, dashboard, model];

  if (argv.includes("--json")) {
    const down = results.filter((r) => r.state === "fail");
    /**
     * Strip presentation before serialising, or `--json` is not machine-readable.
     *
     * Two probes build their `detail` for a human: probeModel appends
     * `c.dim("(local)")` on the ollama path, and probePostgres joins its parts
     * with the `g.skip` separator glyph. Both went into the payload verbatim, so
     * with colour on — a real terminal, or FORCE_COLOR in CI — the JSON carried
     * `"detail": "qwen3 \\u001b[2m(local)\\u001b[22m"`. Valid JSON, and a value
     * no consumer can compare, match or print.
     *
     * Stripped here rather than at the source because the human report wants
     * those escapes; this is the boundary where they stop being wanted.
     */
    const clean = results.map((r) => ({ ...r, detail: plain(r.detail), where: plain(r.where) }));
    stdout.write(
      `${JSON.stringify({ ok: down.length === 0, project: name, dir: found.dir, results: clean }, null, 2)}\n`,
    );
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
