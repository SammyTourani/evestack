/**
 * The probes behind `npm run verify` and `npm run db:bootstrap`.
 *
 * Every check here answers one question a person actually asks while setting
 * this up — "is the database up?", "did the schema get created?", "why does the
 * agent say nothing?" — and every failure carries the one command that fixes
 * it. That pairing is the point. An install that reports `ECONNREFUSED` has
 * told you what happened; an install that reports "Postgres is not reachable on
 * 127.0.0.1:5433 — run `docker compose up -d postgres`" has told you what to do.
 *
 * Dependency-free apart from `pg`, which the project already has. It runs
 * before `npm install` has necessarily finished anything else.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

export const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

/**
 * `.env.local` as a plain object.
 *
 * Node's `--env-file` would do this, but it applies to the process that was
 * already started and we need the values before deciding whether to start
 * anything. Deliberately small: `KEY=value`, `#` comments, no interpolation,
 * no multi-line quoting — the generated file uses none of it, and a parser that
 * silently half-understands a hand-edited file is worse than one that does not
 * try.
 */
export function readEnvFile(path = ".env.local") {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const out = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out[trimmed.slice(0, eq).trim()] = value;
  }
  return out;
}

/** Environment first, then `.env.local`. An exported variable wins, as it does
 *  everywhere else — `--env-file-if-exists` does not clobber a real export. */
export function envValue(fileEnv, key) {
  const live = process.env[key];
  if (live !== undefined && live !== "") return live;
  const fromFile = fileEnv?.[key];
  return fromFile === undefined || fromFile === "" ? undefined : fromFile;
}

/** Never print a password back at someone, not in a terminal and not in a log. */
export function redact(connectionString) {
  return String(connectionString).replace(/:\/\/([^:@/]*):[^@/]*@/, "://$1:***@");
}

export function dockerRunning() {
  return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
}

/**
 * Open a Postgres connection, or explain why not.
 *
 * Returns `{ ok, client, error }` rather than throwing so a caller can report
 * several checks in one pass instead of dying on the first.
 */
export async function connectPostgres(connectionString, timeoutMs = 5000) {
  let pg;
  try {
    ({ default: pg } = await import("pg"));
  } catch {
    return { ok: false, error: "the `pg` package is not installed — run `npm install` first" };
  }
  const client = new pg.Client({
    connectionString,
    application_name: "evestack-verify",
    connectionTimeoutMillis: timeoutMs,
  });
  try {
    await client.connect();
    // An idle client whose socket dies emits 'error', and with nothing listening
    // that is an uncaughtException — a raw stack trace out of the one tool whose
    // entire job is to never print one. The window is not theoretical: `verify`
    // holds this connection open from the schema check all the way past the
    // Ollama, agent, dashboard and ingest probes before calling `end()`.
    //
    // Deliberately a no-op. Every question this connection is asked has already
    // been asked by then, so there is nothing left to report; and a query that
    // does come afterwards rejects on its own with pg's "not queryable", which
    // the caller reports as the failed check it is.
    client.on("error", () => {});
    return { ok: true, client };
  } catch (error) {
    await client.end().catch(() => {});
    return { ok: false, error: describeConnectError(error) };
  }
}

/**
 * One readable sentence out of whatever pg threw.
 *
 * A refused connection to a name that resolves to several addresses arrives as
 * an `AggregateError` whose own `message` is the EMPTY STRING — the detail is
 * one level down, in `.errors`. Printing `error.message` therefore printed a
 * blank line exactly when the reader most needed the reason, which is how the
 * first version of this file shipped.
 */
export function describeConnectError(error) {
  if (error instanceof AggregateError) {
    const parts = Array.isArray(error.errors) ? error.errors : [];
    const seen = [...new Set(parts.map(describeConnectError).filter(Boolean))];
    return seen.join("; ") || error.message || "connection refused";
  }
  if (error instanceof Error) {
    const { code, address, port } = error;
    const where = address ? ` (${address}${port ? `:${port}` : ""})` : "";
    const message = error.message || code || "connection failed";
    return code && !message.includes(code) ? `${code}: ${message}${where}` : `${message}${where}`;
  }
  return String(error);
}

/** Which of these schemas exist? `db:bootstrap` is what creates them. */
export async function schemasPresent(client) {
  const { rows } = await client.query(
    "select schema_name from information_schema.schemata where schema_name = any($1)",
    [["workflow", "workflow_drizzle", "graphile_worker", "evestack"]],
  );
  return new Set(rows.map((r) => r.schema_name));
}

/** Is pgvector installed or at least installable? Long-term memory needs it. */
export async function pgvectorState(client) {
  const { rows } = await client.query(
    "select installed_version is not null as installed from pg_available_extensions where name = 'vector'",
  );
  if (rows.length === 0) return "unavailable";
  return rows[0].installed ? "installed" : "available";
}

/**
 * What the local Ollama actually has.
 *
 * Asked over HTTP rather than by shelling out to `ollama list`, because the
 * agent talks to OLLAMA_BASE_URL and that may not be the same install the CLI
 * on PATH points at. `qwen3` and `qwen3:latest` are the same model, so both
 * spellings match.
 */
export async function inspectOllama(baseUrl, wanted = []) {
  const result = { running: false, models: [], missing: [...wanted] };
  try {
    const response = await fetch(new URL("/api/tags", baseUrl), {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return result;
    const body = await response.json();
    result.running = true;
    const list = Array.isArray(body?.models) ? body.models : [];
    result.models = list.map((m) => m?.name).filter((n) => typeof n === "string");
    const tags = new Set(result.models.flatMap((n) => [n, n.replace(/:latest$/, "")]));
    result.missing = wanted.filter((n) => !tags.has(n) && !tags.has(n.replace(/:latest$/, "")));
  } catch {
    // Not running or not reachable. `running` stays false.
  }
  return result;
}

/** A JSON GET that answers `{ ok, status, body }` instead of throwing. */
export async function probeJson(url, init = {}, timeoutMs = 4000) {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, error: error?.message ?? String(error) };
  }
}

/**
 * Which dashboard this project's checks should talk to.
 *
 * The same failure as `findAgent`, reached from the other direction. The
 * dashboard URL is derived from EVESTACK_DASHBOARD_URL, and when that was unset
 * the caller fell back to a hardcoded `http://localhost:4000`.
 *
 * `create` and `attach` both write that variable, so a freshly generated project
 * takes the recorded path and is right. But it is documented as OPTIONAL — trace
 * export is off by default and .env.example ships the line commented — so
 * removing it is an ordinary thing for a reader to do. Do that on a machine where
 * 4000 was already busy, which is *precisely why the scaffolder moved this
 * project to 4001*, and the probe lands on ANOTHER project's dashboard and
 * reports it as this one's: "answering, database connected", against a database
 * this project has never written a row to. Measured exactly that — a green
 * `dashboard` line while this project's dashboard was not running at all.
 *
 * There is no EVESTACK_DASHBOARD_PORT to pin against the way the agent pins, so
 * this cannot always be certain. What it can do is never present a guess as a
 * fact: `recorded` is false when the answer came from the default port, and
 * verify prints that on the line instead of swallowing it.
 *
 * `URL.parse` rather than `new URL`: a typo'd EVESTACK_DASHBOARD_URL used to
 * throw a bare TypeError from the middle of verify, ending the run instead of
 * reporting a failed check.
 */
export const DEFAULT_DASHBOARD_URL = "http://localhost:4000";

export function dashboardTarget(ingestUrl) {
  const trimmed = ingestUrl?.trim();
  if (!trimmed) return { url: DEFAULT_DASHBOARD_URL, recorded: false };

  // The protocol check is not belt-and-braces, it is the actual bug. `URL.parse`
  // SUCCEEDS on "localhost:4000/api/ingest/v1/traces" — the most natural way to
  // typo this value — because it reads `localhost:` as a scheme and the rest as an
  // opaque path. `.origin` for a non-special scheme is then the four-character
  // string "null", so accepting it would hand verify a base of "null" to resolve
  // /api/health against, which throws. Caught by the test for this function, which
  // is the only reason it is not in the shipped file.
  const parsed = URL.parse(trimmed);
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    return { url: DEFAULT_DASHBOARD_URL, recorded: false, malformed: trimmed };
  }

  // 127.0.0.1 -> localhost only for what gets printed and clicked. They are the
  // same host, and `localhost` is the spelling browsers and OS keychains treat
  // as the more trustworthy origin of the pair.
  return { url: parsed.origin.replace("127.0.0.1", "localhost"), recorded: true };
}

/**
 * Where the agent is listening.
 *
 * `eve dev` takes 2000 but **auto-increments if it is taken**, so a fixed guess
 * is wrong exactly when a second project is running — which is also when
 * someone is most likely to be confused about which agent they are talking to.
 */
export async function findAgent(explicitUrl, pinnedPort, startPort = 2000, span = 5) {
  const check = async (url) => {
    const probe = await probeJson(new URL("/eve/v1/health", url), {}, 2000);
    return probe.ok ? { url, health: probe.body } : null;
  };

  if (explicitUrl) {
    return (await check(explicitUrl)) ?? { url: explicitUrl, health: null };
  }

  // The recorded port, and ONLY the recorded port. Falling through to a scan
  // here would reintroduce the bug this exists to remove: a second project's
  // agent answering on 2000 and being reported as this project's, with a
  // copy-pasteable curl command aimed at someone else's agent. "Your agent is
  // not running" is the correct answer when this project's agent is not.
  if (pinnedPort) {
    const url = `http://127.0.0.1:${pinnedPort}`;
    return (await check(url)) ?? { url, health: null, pinned: true };
  }

  // No recorded port: an older scaffold, or a project made by `attach`. Scan,
  // and say so, because the answer is a guess.
  for (let port = startPort; port < startPort + span; port += 1) {
    const found = await check(`http://127.0.0.1:${port}`);
    if (found) return { ...found, guessed: port !== startPort };
  }
  return { url: `http://127.0.0.1:${startPort}`, health: null };
}

/**
 * The argv for `eve <command>`, with this project's recorded port applied.
 *
 * Shared by `npm run dev` and `npm run start` because the two drifted apart and
 * only one of them was right. `dev` passed EVESTACK_AGENT_PORT through as
 * `--port`; `start` passed nothing, so a BUILT server took `$PORT` or eve's own
 * default of 3000 and ignored the port the project had written down.
 *
 * Everything else in the project reads that variable as the answer to "where is
 * the agent": `verify` probes it, and the generated compose file points the
 * dashboard's EVESTACK_AGENT_URL at it. So in production all of them were
 * pointing somewhere the agent was not.
 *
 * Measured: `npm run start` bound 3000, which on that machine was already an
 * unrelated Next app, so the built agent served nothing at all and said so
 * nowhere. 3000 is a bad number to land on by accident — it is the default for
 * Next, CRA and Vite.
 *
 * A `--port` the caller typed always wins: the recorded port is a default, not a
 * rule. `--port=N` and `--port N` are both honoured, which is why this checks for
 * the prefix as well as equality.
 */
export function eveArgsWithPort(command, passthrough = [], pinnedPort) {
  const args = [command, ...passthrough];
  const pinned = pinnedPort?.trim();
  if (!pinned) return args;
  if (passthrough.some((arg) => arg === "--port" || arg.startsWith("--port="))) return args;
  args.push("--port", pinned);
  return args;
}
