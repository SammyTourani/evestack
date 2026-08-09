/**
 * `evestack verify` and `evestack open` — the two things a stuck person types.
 *
 * `npm run verify` already existed, and it only helps someone who remembers the
 * script name AND is standing in the right directory. The globally installed
 * `evestack` command knew `create`, `attach` and `doctor` — so the answer to
 * "is this thing working?" was a script name, and the answer to "what was my
 * password again?" was to go and read a dotfile. Both are now a command.
 *
 * Neither one reimplements anything. `verify` runs the project's own checker so
 * it cannot drift from the version the user installed, and falls back to the one
 * inside `create-evestack` for a project made by `attach`, which has no
 * `scripts/` directory of its own.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// The shared design system, from the package that already carries the template.
// This file declared its own copy of the colour table, as did shared.mjs and the
// template's checks.mjs — three tables, none of which asked whether stdout was a
// terminal before emitting an escape.
import { c, g, heading } from "create-evestack/ui";

/**
 * The env files eve itself loads, in the order it loads them — `.env.local` last,
 * because it wins.
 *
 * These two and no others: a project's credentials have to be somewhere the agent
 * will read, so this list is the same one `attach` chooses between.
 */
const ENV_FILES = [".env", ".env.local"];

/**
 * The nearest directory above `from` that looks like an evestack project, and the
 * env files it has.
 *
 * Walks up, because `npm run` is normally typed at a project root but
 * `evestack` is on PATH and gets typed from wherever the person happens to be —
 * very often one directory deeper, in `agent/`. Refusing there with "not an
 * evestack project" would be technically true and useless.
 *
 * `.env.local` was the only marker, with the comment "every scaffolded and every
 * attached project has one". That was not true: `attach` writes to `.env` when
 * the project already has one, so an attached project could have no .env.local at
 * all — and both of these commands then told the user "this is not an evestack
 * project" and advised `npx evestack create my-agent`, i.e. to throw away the
 * thing they had just attached.
 *
 * A bare `.env` is not enough on its own, because half the npm projects on a
 * machine have one; paired with a package.json that depends on `eve` it is, and
 * that pair is exactly what `attach` requires before it will touch a directory.
 */
export function findProjectEnv(from = process.cwd()) {
  let dir = resolve(from);
  for (let up = 0; up < 8; up += 1) {
    const envFiles = ENV_FILES.filter((file) => existsSync(join(dir, file)));
    if (envFiles.includes(".env.local") || (envFiles.length > 0 && dependsOnEve(dir))) {
      return { dir, envFiles };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** The directory only, for callers and tests that just want the root. */
export function findProject(from = process.cwd()) {
  return findProjectEnv(from)?.dir ?? null;
}

/** Does this directory's package.json declare eve? */
function dependsOnEve(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return Boolean(pkg.dependencies?.eve ?? pkg.devDependencies?.eve);
  } catch {
    return false;
  }
}

/** Exported: `status` and `tour` refuse in exactly the same place, for exactly
 *  the same reason, and three copies of this paragraph would drift. */
export function notAProject(stderr) {
  stderr.write(
    `\n  ${c.redBold("This is not an evestack project.")}\n` +
      `  ${c.dim("No .env.local here or above, and no .env beside a package.json that needs eve.")}\n\n` +
      `  ${c.dim(`${g.arrow} `)}${c.bold("cd")} into the directory ${c.bold("evestack create")} made, or the one you ran\n` +
      `    ${c.bold("evestack attach")} in — or start a new one:\n\n` +
      `      ${c.bold("npx evestack create my-agent")}\n\n`,
  );
  return 2;
}

/** Same tiny KEY=value reader the template's checks use. */
function readEnvFile(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
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

/**
 * The project's own verify script, or the one bundled with the scaffolder.
 *
 * Project first on purpose: it is the version that shipped with the user's
 * install, and a globally installed CLI that silently checks a project against
 * a NEWER set of rules than the project has would report problems the project
 * cannot have.
 */
function findVerifyScript(projectDir) {
  const own = join(projectDir, "scripts", "verify.mjs");
  if (existsSync(own)) return own;
  try {
    return new URL(import.meta.resolve("create-evestack/template/scripts/verify.mjs")).pathname;
  } catch {
    return null;
  }
}

export const VERIFY_USAGE = `evestack verify — check every part of the stack and say what to fix

  evestack verify [--json]

Runs the project's own checker: Postgres, the workflow schema, the agent, the
dashboard, the sandbox image and the trace pipeline. Works from anywhere inside
the project directory.

Options
  --json          machine-readable output
  --open          open the dashboard afterwards if everything passed
  --no-open       never open a browser
  -h, --help      this

Exit codes
  0  everything checked out
  1  something is broken, and it printed what
  2  could not look — not an evestack project, or no checker to run
`;

export const OPEN_USAGE = `evestack open — print the dashboard URL and sign-in, and open it

  evestack open [--no-open]

The scaffolder prints the dashboard credentials once, in a terminal that then
scrolls. This prints them again, checks whether the dashboard is answering, and
hands the URL to your browser.

Options
  --no-open       print the URL and sign-in, and do not launch a browser
  -h, --help      this

Exit codes
  0  the dashboard is answering
  1  nothing is answering there yet
  2  not an evestack project
`;

/**
 * Every value this project configures, merged in eve's own load order.
 *
 * Exported because `status` needs the same view `open` does, and the merge has
 * a rule in it worth keeping in one place: `.env.local` wins over `.env`, and
 * the real environment wins over both — a container deployment sets these as
 * variables and has no file at all.
 */
export function projectEnv(found) {
  const merged = {};
  for (const file of found.envFiles) Object.assign(merged, readEnvFile(join(found.dir, file)));
  return (key) => process.env[key] || merged[key] || undefined;
}

/** Was help asked for, ignoring anything after `--`? */
export function wantsHelp(argv) {
  for (const arg of argv) {
    if (arg === "--") return false;
    if (arg === "--help" || arg === "-h") return true;
  }
  return false;
}

export async function verify(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  // First, before the project is even located. `evestack verify --help` used to
  // run the whole verification — Docker, Postgres, HTTP probes — because the flag
  // was passed straight through to a checker that only knows --json and
  // --open/--no-open, and an unrecognised flag there is simply ignored.
  if (wantsHelp(argv)) {
    stdout.write(VERIFY_USAGE);
    return 0;
  }

  const found = findProjectEnv();
  if (!found) return notAProject(stderr);
  const projectDir = found.dir;

  const script = findVerifyScript(projectDir);
  if (!script) {
    stderr.write(
      `\n  ${c.redBold("Could not find the verify script.")}\n\n` +
        `  ${c.dim("From inside the project this is also:")}  ${c.bold("npm run verify")}\n\n`,
    );
    return 2;
  }

  if (projectDir !== process.cwd()) {
    stdout.write(`  ${c.dim(`checking ${projectDir}`)}\n`);
  }

  // Inherited stdio: verify prints colour, asks one question, and its exit code
  // is the answer. Capturing any of that would break all three.
  //
  // Both env files, in eve's own order, and only the ones that exist: an attached
  // project may keep its configuration in `.env`, and this passed `.env.local`
  // alone — so the checker ran with no database URL and reported a project that
  // works as broken. Naming a file that is not there would print "not found.
  // Continuing without it." on every run, which is noise on the happy path.
  const envFlags = found.envFiles.map((file) => `--env-file-if-exists=${file}`);
  const result = spawnSync(
    process.execPath,
    [...envFlags, script, ...argv],
    { cwd: projectDir, stdio: "inherit" },
  );
  return result.status ?? 1;
}

/**
 * `evestack open` — where is my dashboard and what is the password.
 *
 * This exists because the scaffolder prints the credentials exactly once, in a
 * terminal that then scrolls, and nothing else ever printed them again. The
 * recovery path was "go and read .env.local", which assumes the reader knows
 * that file exists and which of its keys is the password.
 */
export async function open(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  // Before the probe and before the browser. `evestack open --help` checked only
  // for --no-open, so it went on to fetch /api/health and then LAUNCH A BROWSER —
  // help is a question, and the answer to it is not a new window.
  if (wantsHelp(argv)) {
    stdout.write(OPEN_USAGE);
    return 0;
  }

  const found = findProjectEnv();
  if (!found) return notAProject(stderr);

  // Merged in eve's order, so .env.local wins — and so an attached project that
  // keeps its configuration in `.env` is read at all.
  const value = projectEnv(found);

  // The ingest URL is the one place the chosen dashboard port is recorded, and
  // the scaffolder now picks that port rather than assuming 4000.
  const ingest = value("EVESTACK_DASHBOARD_URL");
  let url = "http://localhost:4000";
  if (ingest) {
    try {
      url = new URL(ingest).origin.replace("127.0.0.1", "localhost");
    } catch {
      // Keep the default; a malformed value is not worth failing over.
    }
  }

  const user = value("EVESTACK_AUTH_USER") ?? "evestack";
  const password = value("EVESTACK_AUTH_PASSWORD");

  let healthy = false;
  try {
    const response = await fetch(new URL("/api/health", url), {
      signal: AbortSignal.timeout(3000),
    });
    healthy = response.ok;
  } catch {
    healthy = false;
  }

  stdout.write("\n");
  heading("dashboard", healthy ? "" : "not running yet");
  stdout.write("\n");
  stdout.write(`      ${c.brandBold(url)}\n`);
  if (password) {
    stdout.write(`      ${c.dim("sign in")}  ${c.bold(user)} ${c.dim("/")} ${c.bold(password)}\n`);
  } else {
    stdout.write(
      `      ${c.yellow("EVESTACK_AUTH_PASSWORD is not set")}${c.dim(", so every route answers 503.")}\n`,
    );
  }
  stdout.write("\n");

  if (!healthy) {
    stdout.write(`  ${c.dim(`${g.arrow} `)}${c.bold("docker compose --profile dashboard up -d")}\n\n`);
    stdout.write(
      `  ${c.dim("Then `evestack open` again. `evestack status` says what else is down.")}\n\n`,
    );
    return 1;
  }

  // Say that it is alive, and say what just happened to the browser.
  //
  // The restyle dropped the old `healthy` line and replaced it with nothing, so
  // the happy path ended on the password with no confirmation and no trailing
  // context — a live run of `evestack open --no-open` printed three lines and
  // stopped, which reads like it was cut off. Both branches now end in a
  // sentence about the state of the world.
  if (argv.includes("--no-open")) {
    stdout.write(`  ${c.green("Answering.")}${c.dim(" Run `evestack open` without --no-open to launch it.")}\n\n`);
    return 0;
  }
  stdout.write(`  ${c.green("Answering.")}${c.dim(" Opening it now…")}\n\n`);
  launchBrowser(url);
  return 0;
}

/**
 * Hand the URL to the desktop and forget about it.
 *
 * Detached and unref'd so the CLI exits immediately instead of waiting on a
 * browser process, and failures are silent because the URL is already on screen
 * — a stack trace about `xdg-open` would be worse than no browser.
 */
function launchBrowser(url) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // Already printed above.
  }
}
