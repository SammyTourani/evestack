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
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// One colour table for the whole project, and the only one that asks whether
// this is a terminal before emitting an escape. `npm run verify | tee log.txt`
// used to write raw \x1b[31m into the file. Re-exported rather than re-declared
// so that verify.mjs and dev.mjs keep their single `from "./checks.mjs"` import.
export { C, c, g } from "./ui.mjs";

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

/* -------------------------------------------------------------------------- */
/* the two blocks a first run should not have to explain away                  */
/* -------------------------------------------------------------------------- */

/**
 * Lines `eve dev` writes to STDERR that mean nothing to the person reading them.
 * Both were measured on a cold scaffold, on stderr, with stdout untouched.
 *
 * ONE. rolldown, bundling a dependency:
 *
 *   node_modules/@vercel/otel/dist/node/index.js (23:28893) [EVAL] Use of
 *   direct `eval` function is strongly discouraged as it poses security risks
 *   and may cause issues with minification.
 *
 * plus three indented lines of frame and a `Help:` hint. The eval is inside
 * @protobufjs/inquire, vendored into @vercel/otel's node build - code this
 * project never runs, because agent/instrumentation.ts registers the JSON
 * exporter and not the protobuf one. It prints on first boot and again on every
 * hot rebuild, so a stranger editing a tool reads "poses security risks" once a
 * minute with no way to know it is about someone else's file.
 *
 * eve already tries to hide exactly this. internal/nitro/host/
 * nitro-bundler-config.js installs an onLog that drops any warn whose
 * id / ids / loc.file / pluginCode sits under node_modules, and it works: the
 * same warning is absent from `npm run build`, which was checked. The dev
 * server's authored-artifact rebuild does not route through that config, so the
 * one bundle a person watches all day is the one that leaks.
 *
 * TWO. the workflow SDK, once per new session and twice over:
 *
 *   [workflow-sdk] deploymentId: 'latest' has no effect in this world and was
 *   ignored. It is only supported by worlds with atomic deployments, such as
 *   Vercel. The run will target the current deployment.
 *     currentDeploymentId postgres
 *
 * eve asks for deploymentId 'latest' whenever EVE_DEV=1 (execution/
 * workflow-runtime.js, shouldRouteToLatestDeployment), the Postgres world has no
 * resolveLatestDeploymentId, and the SDK narrates the fallback. Twice, because
 * its dedupe flag is per module instance and the dev server has two. A
 * self-hosted world is the only kind this template supports, so the advice can
 * never apply. It is absent from `npm run start`, which was also checked:
 * EVE_DEV is unset there, so the request that provokes it is never made.
 *
 * NOTHING ELSE IS FILTERED. Two sentences, both traced to their emitter, both
 * about a state the reader cannot act on. Everything else eve, Postgres or this
 * project's own code writes is relayed byte for byte, colours included.
 * EVESTACK_RAW_LOGS=1 turns even these two back on.
 */
export const BENIGN_DEV_NOISE = [
  /\[EVAL\]\s*Use of direct `eval` function is strongly discouraged/,
  /^\[workflow-sdk\] deploymentId: 'latest' has no effect in this world/,
];

/** SGR escapes. Matching happens on the plain text; what is printed keeps its
 *  colour. */
const SGR = /\u001B\[[0-9;]*m/g;

/**
 * The filter as a value rather than a stream, so what it decides can be tested
 * without spawning anything. push(chunk) returns the text to write on, and
 * flush() returns whatever partial line is still held when the child exits.
 *
 * A matched line takes its CONTINUATION LINES with it: everything blank or
 * indented that follows, up to the next line starting in column zero. Both
 * blocks above are shaped that way. rolldown hangs a frame and a Help hint off
 * its heading, the SDK hangs currentDeploymentId off its own, and suppressing
 * the shape rather than each individual line means a future rolldown that words
 * its hint differently leaves no orphaned fragments with nothing to explain them.
 */
export function createDevNoiseFilter(patterns = BENIGN_DEV_NOISE) {
  const state = { pending: "", suppressed: 0, swallowing: false };

  function keep(line) {
    const plain = line.replace(SGR, "");
    if (state.swallowing) {
      if (plain.trim() === "") return false;
      if (/^\s/.test(plain)) return false;
    }
    state.swallowing = false;
    if (patterns.some((pattern) => pattern.test(plain))) {
      state.swallowing = true;
      state.suppressed += 1;
      return false;
    }
    return true;
  }

  return {
    push(chunk) {
      const lines = (state.pending + chunk).split("\n");
      // The tail is whatever has not been terminated yet. Holding it is what
      // makes matching a whole line possible at all; `holding` below is how a
      // caller decides to release one that never gets its newline.
      state.pending = lines.pop();
      const kept = lines.filter(keep);
      if (kept.length === 0) return "";
      return `${kept.join("\n")}\n`;
    },
    get holding() {
      return state.pending !== "";
    },
    flush() {
      const line = state.pending;
      state.pending = "";
      if (line === "") return "";
      return keep(line) ? line : "";
    },
    get suppressed() {
      return state.suppressed;
    },
  };
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
 * A value that can actually be used as the base for `/eve/v1/health`.
 *
 * `URL.parse` plus a protocol check, for exactly the reasons `dashboardTarget`
 * above has both. This is that same bug on the other half of the stack, and
 * `findAgent` got neither guard: `new URL("/eve/v1/health", url)` sat inside
 * `check`, which is OUTSIDE probeJson's try/catch and outside every catch in
 * verify, so one typo threw
 *
 *   TypeError [ERR_INVALID_URL]: Invalid URL
 *     input: '/eve/v1/health', base: 'localhost:2000'
 *
 * out of the middle of the run. And because verify prints its report at the END,
 * the checks that had already passed were never printed at all: a mistyped
 * EVESTACK_AGENT_URL cost the whole report, not one line of it. Reproduced with
 * `localhost:2000`, `127.0.0.1:2000`, `2000`, `:2000` and `//localhost:2000`.
 *
 * The protocol check is the load-bearing half, again just as it is there:
 * `URL.parse("localhost:2000")` SUCCEEDS — it reads `localhost:` as the scheme —
 * and `.origin` for a non-special scheme is the four-character string "null", so
 * accepting it only moves the throw one line down.
 */
export function agentBaseUrl(url) {
  const trimmed = url?.trim();
  if (!trimmed) return null;
  const parsed = URL.parse(trimmed);
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) return null;
  return parsed;
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
    const base = agentBaseUrl(url);
    if (!base) return null;
    const probe = await probeJson(new URL("/eve/v1/health", base), {}, 2000);
    return probe.ok ? { url, health: probe.body } : null;
  };

  if (explicitUrl) {
    // A malformed value is reported, not thrown, and NOT quietly replaced by a
    // scan: adopting whatever answers on 2000 is precisely the bug the pinned
    // branch below exists to prevent. `malformed` is what verify prints instead
    // of "nothing is answering", which would blame the agent for a typo.
    const explicit = explicitUrl.trim();
    if (!agentBaseUrl(explicit)) return { url: explicit, health: null, malformed: explicit };
    return (await check(explicit)) ?? { url: explicit, health: null };
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

/**
 * Which `eve` to execute: this project's, by absolute path, whenever it exists.
 *
 * `scripts/start.mjs` spawned the bare name `eve` and relied on PATH. That works
 * under `npm run start`, because npm prepends `node_modules/.bin` to PATH for
 * the command it runs — and it is exactly the assumption that breaks the moment
 * a process supervisor starts the agent, which is the whole point of a service
 * unit. systemd's default PATH is `/usr/local/sbin:/usr/local/bin:/usr/sbin:
 * /usr/bin:/sbin:/bin`; launchd's is shorter still. Neither contains
 * `node_modules/.bin`.
 *
 * Measured before this function existed, with the real scripts/start.mjs and a
 * stub `node_modules/.bin/eve` in a scratch project:
 *
 *   PATH=<project>/node_modules/.bin:/usr/bin:/bin  ->  eve start --port 2000
 *   PATH=/usr/local/bin:/usr/bin:/bin               ->  "eve is not installed
 *                                                        in this project."
 *
 * That second line is the ENOENT branch of start.mjs, and it tells an operator
 * whose install is perfectly fine to go and run `npm install` — a true-sounding
 * message about the wrong problem, produced only under the supervisor, only in
 * production. Resolving the path here removes the dependency on PATH entirely,
 * so `ExecStart=/usr/bin/node scripts/start.mjs` behaves the same as `npm start`.
 *
 * `scriptUrl` is the caller's `import.meta.url`; the project root is its parent
 * directory's parent, because every script here lives at `<root>/scripts/*.mjs`.
 *
 * Windows is deliberately left on PATH. There the shim is `eve.cmd`, it is
 * spawned through `shell: true` (see start.mjs), and an absolute path handed to
 * cmd.exe needs quoting rules this is not the place to reimplement — no one
 * supervises this stack with systemd on Windows, so the trap above cannot bite
 * there.
 */
export function eveBinary(scriptUrl, platform = process.platform) {
  if (platform === "win32") return "eve";
  const root = dirname(dirname(fileURLToPath(scriptUrl)));
  const local = join(root, "node_modules", ".bin", "eve");
  return existsSync(local) ? local : "eve";
}
