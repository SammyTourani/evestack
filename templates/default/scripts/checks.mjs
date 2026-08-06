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
