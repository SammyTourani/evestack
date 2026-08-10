/**
 * Helpers shared by `create-evestack` and `create-evestack attach`.
 *
 * Split out of index.mjs when attach arrived. Both commands colour output, both
 * ask questions, and both need the agent template — a second copy of the
 * EOF-guarded reader below would be a second place for the hang it exists to
 * prevent to come back.
 *
 * Still dependency-free, for the reason index.mjs gives.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { blank, c, C, g, say } from "./ui.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export const REPO = "https://github.com/SammyTourani/evestack";

/**
 * The dashboard image, and whether it exists yet.
 *
 * Pinned to a tag rather than `latest` for the same reason sync-template.mjs
 * pins the template's workspace ranges: a scaffold should get the combination
 * that was tested with it, not whatever was pushed to the registry this
 * morning. `latest` is published too, for anyone who wants to opt into drift.
 *
 * The tag tracks packages/dashboard/package.json `version` — NOT this package's
 * version, which moves for reasons that have nothing to do with the image.
 * .github/workflows/publish-dashboard.yml refuses to publish when the two
 * disagree, so this constant cannot go stale silently.
 *
 * PUBLISHED is false until the first GHCR push. It is the only edit needed
 * afterwards: it removes the "this pull will fail" paragraph from the printed
 * steps and from the generated compose header. Printing a pull command that
 * 404s, with nothing saying so, is worse than the clone-and-build it replaced.
 */
export const DASHBOARD_IMAGE_TAG = "0.3.0";
export const DASHBOARD_IMAGE = `ghcr.io/sammytourani/evestack-dashboard:${DASHBOARD_IMAGE_TAG}`;
/*
 * `DASHBOARD_IMAGE_PUBLISHED` lived here and is gone.
 *
 * It gated a build-it-yourself apology in the scaffolder, the same in `attach`,
 * and a NOT PUBLISHED YET banner in the generated compose file — all correct
 * while the image did not exist, and all unreachable since it did. It had been
 * a constant `true` for a release, so those forty lines were dead code that
 * told the reader to `git clone` and `docker build` something they can now
 * pull. Dead code that gives instructions is worse than dead code that does
 * not: the day someone flips a flag to debug, the apology comes back wrong.
 *
 * Re-verified against the registry before deleting, anonymously and unauthed:
 * `GET ghcr.io/v2/sammytourani/evestack-dashboard/manifests/0.1.0` -> 200, with
 * linux/amd64 and linux/arm64 in the index. If a future release ever ships
 * ahead of its image again, say so in the release notes rather than reviving a
 * branch nobody exercises.
 */

/**
 * Re-exported so the ~100 call sites in create.mjs and attach.mjs that already
 * write `${C.dim}…${C.reset}` keep working — and become NO_COLOR-correct without
 * being touched, because ui.mjs decides whether those strings are escapes or
 * empty. The table used to be declared here, and identically in two other files.
 */
export { C, c, g };

/**
 * The Node this package is tested on, and the floor every manifest already
 * declares.
 *
 * Nothing checked it. `engines` is advice — npm prints a warning nobody reads
 * and installs anyway — so an older runtime got all the way into the generated
 * project before failing, at a depth where the error never names the version:
 * the template's scripts use `--env-file-if-exists` (Node 20.12+) and its
 * checks call `URL.parse` (Node 22.1+), so the symptom is an unknown flag or a
 * missing function several commands after the mistake was made.
 *
 * A message rather than an exit, so the caller owns the exit code and nothing is
 * half-created first. The limit, stated because it is real: a Node too old to
 * PARSE this file dies before this function exists. That is Node 13 and below,
 * which cannot run any part of this package anyway; the versions people actually
 * still have — 20 and 22 — parse it and get the sentence.
 */
export const MIN_NODE_MAJOR = 24;

export function nodeVersionProblem(version = process.versions.node) {
  const major = Number.parseInt(version, 10);
  if (!Number.isFinite(major) || major >= MIN_NODE_MAJOR) return null;
  return (
    `evestack needs Node ${MIN_NODE_MAJOR} or newer — this is Node ${version}.\n` +
    `  Every package here declares "engines": { "node": ">=${MIN_NODE_MAJOR}" }, and npm only warns.\n` +
    "  The project this creates runs its scripts with --env-file-if-exists (Node 20.12+)\n" +
    "  and its checks call URL.parse (Node 22.1+), so an older runtime fails later and\n" +
    "  deeper, in messages that never name the version.\n" +
    "  Install Node 24 from https://nodejs.org, or `nvm install 24` / `fnm use 24`."
  );
}

/**
 * A value as a shell would need it typed.
 *
 * Both wizards print `cd <dir>` for a human to paste, and a directory with a
 * space in it — `npx create-evestack "My Agent"` — produced `cd My Agent`, which
 * is two arguments and a broken instruction. Single quotes rather than
 * backslashes, because inside them every character is literal but the quote
 * itself, which is closed, escaped and reopened.
 */
export function shellQuote(value) {
  const text = String(value);
  if (text === "") return "''";
  if (/^[A-Za-z0-9._+@%/:=,-]+$/.test(text)) return text;
  return `'${text.split("'").join(`'\\''`)}'`;
}

/**
 * The mode every generated credential file gets, and why `writeFileSync` alone
 * does not get there.
 *
 * Both wizards generate real secrets — a dashboard sign-in password, a trace
 * ingest token, a Postgres password — and both wrote them with a plain
 * `writeFileSync`, which means the process umask decides who can read them.
 * Measured on this machine (umask 022) by scaffolding into a temp directory and
 * stat-ing the result:
 *
 *     -rw-r--r--  .env        EVESTACK_DB_PASSWORD
 *     -rw-r--r--  .env.local  EVESTACK_AUTH_PASSWORD, EVESTACK_INGEST_TOKEN,
 *                             WORKFLOW_POSTGRES_URL (password inline), API key
 *
 * World-readable. On a shared box that is every other account on it, and the
 * dashboard password is a control plane that starts agent runs and approves
 * gated shell commands — the same reasoning that pins its port to 127.0.0.1.
 *
 * TWO CALLS, NOT ONE, and this is the part that is easy to get wrong. The `mode`
 * option on writeFileSync is passed to `open(2)` with O_CREAT, so it applies
 * only when the file is CREATED; overwriting an existing 0644 file leaves it at
 * 0644 and the option is silently ignored.
 *
 * Which of the two calls does the work depends on the caller. `create` refuses a
 * directory that is not empty (create.mjs:360), so its files are always new and
 * the `mode` option is enough there. `attach` is the opposite case: it APPENDS
 * its block to an env file the project usually already has, so for the command
 * that most needs this, the chmod is the only half that does anything.
 *
 * The chmod is best-effort on purpose. It can fail for reasons that have nothing
 * to do with this package — a file owned by another user, a mount that does not
 * carry Unix modes, Windows, a container bind mount — and none of those is worth
 * aborting a scaffold half way through, after the file itself has been written
 * correctly. The caller is told, so the user can fix it, and the run continues.
 *
 * Returns null on success, or the message to warn with.
 */
export const SECRET_FILE_MODE = 0o600;

export function writeSecretFile(path, contents) {
  writeFileSync(path, contents, { mode: SECRET_FILE_MODE });
  try {
    chmodSync(path, SECRET_FILE_MODE);
    return null;
  } catch (error) {
    return (
      `Could not restrict ${path} to owner-only (0600) — ${error?.message ?? error}\n` +
      `  It holds generated credentials. Tighten it yourself: chmod 600 ${shellQuote(path)}`
    );
  }
}

/**
 * The flags every entry point shares, and the one rule that makes them safe.
 *
 * `--help` used to be read AFTER the command had been routed, which is how
 * `npx create-evestack attach --help` ran real detection on a real project and
 * then offered to write files with the prompt defaulting to yes. Help is a
 * question: it is answered before anything is detected, installed or written.
 *
 * Scanning stops at `--`, so a directory whose name genuinely begins with a dash
 * can still be named: `npx create-evestack -- --help` scaffolds into `--help`.
 */
export const HELP_FLAGS = new Set(["--help", "-h"]);
export const VERSION_FLAGS = new Set(["--version", "-V"]);

export function hasFlag(argv, flags) {
  for (const arg of argv) {
    if (arg === "--") return false;
    if (flags.has(arg)) return true;
  }
  return false;
}

/**
 * This package's own version, for `--version`.
 *
 * Read from the manifest rather than duplicated in a constant, because a
 * hand-typed copy of a number that `npm version` moves is a number that is
 * wrong within one release.
 */
export function packageVersion() {
  try {
    return JSON.parse(readFileSync(join(HERE, "package.json"), "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export { say, blank };
export const step = (s) => say(`  ${g.MARK} ${c.bold(s)}`);
export const ok = (s) => say(`  ${g.OK} ${s}`);
export const warn = (s) => say(`  ${g.WARN} ${s}`);
export const dim = (s) => say(`  ${c.dim(s)}`);

export function basename(p) {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? "agent";
}

/**
 * Where the agent template lives.
 *
 * `{ optional: true }` returns null instead of exiting, for callers that only
 * want to read something out of the template and have a sane answer without it.
 * Scaffolding has no such answer — a create command that cannot find what it
 * creates should stop — so the default stays fatal.
 */
export function templateDir({ optional = false } = {}) {
  // Published layout first, then the monorepo layout for local development.
  for (const candidate of [join(HERE, "template"), join(HERE, "..", "..", "templates", "default")]) {
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }
  if (optional) return null;
  console.error(`${C.red}Could not locate the agent template.${C.reset}`);
  process.exit(1);
}

/**
 * Which package manager to name in "run this next" instructions.
 *
 * A lockfile in the project beats the user agent: `npx create-evestack attach`
 * always runs under npm no matter what installed the project, so telling a pnpm
 * user to run `npm install` would rewrite their node_modules layout for them.
 */
export function detectPm(dir) {
  if (dir) {
    if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
    if (existsSync(join(dir, "yarn.lock"))) return "yarn";
    if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) return "bun";
    if (existsSync(join(dir, "package-lock.json"))) return "npm";
  }
  const ua = process.env.npm_config_user_agent ?? "";
  if (ua.startsWith("pnpm")) return "pnpm";
  if (ua.startsWith("yarn")) return "yarn";
  if (ua.startsWith("bun")) return "bun";
  return "npm";
}

/**
 * A reader that answers with the fallback instead of hanging.
 *
 * Non-interactive when asked for, or when stdin is not a terminal (CI, a piped
 * heredoc, a Dockerfile). Without this the process would reach EOF mid-prompt
 * and exit 0 having done nothing, which looks like success.
 */
export async function makePrompter(nonInteractive) {
  const { createInterface } = await import("node:readline/promises");
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

  return { ask, confirm, close: () => rl?.close() };
}

/* -------------------------------------------------------------------------- */
/* ports                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Is something already listening here?
 *
 * A short connect probe rather than a bind test: binding would succeed against
 * a port Docker has published but nothing is answering on, and it is Docker's
 * publish that fails later, not ours.
 */
export function portAnswers(port, host = "127.0.0.1") {
  return new Promise((res) => {
    const socket = createConnection({ host, port });
    const done = (answered) => {
      socket.destroy();
      res(answered);
    };
    socket.setTimeout(400);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/**
 * The first free port at or after `start`, or `start` if the whole window is
 * taken.
 *
 * `attach` has always done this and `create` did not, which is backwards —
 * `create` is the command a first-time user runs, and running it twice was
 * enough to earn `Bind for 0.0.0.0:5433 failed: port is already allocated`
 * halfway through `docker compose up`, with a half-created container left
 * behind. Worse, `docker compose ps` then reports the container healthy while
 * the published port is missing, so the NEXT command fails instead with a raw
 * ECONNREFUSED from inside a migration library.
 *
 * Falling back to `start` rather than throwing is deliberate: 20 consecutive
 * busy ports means something unusual is going on, and Docker's own error names
 * the port more usefully than a guess from here would.
 */
export async function freePort(start, count = 20) {
  for (let port = start; port < start + count; port += 1) {
    if (!(await portAnswers(port))) return port;
  }
  return start;
}
