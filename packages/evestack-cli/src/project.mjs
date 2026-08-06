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

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

/**
 * The nearest directory above `from` that looks like an evestack project.
 *
 * Walks up, because `npm run` is normally typed at a project root but
 * `evestack` is on PATH and gets typed from wherever the person happens to be —
 * very often one directory deeper, in `agent/`. Refusing there with "not an
 * evestack project" would be technically true and useless.
 *
 * `.env.local` is the marker rather than `package.json`: every scaffolded and
 * every attached project has one, and a bare `package.json` would match any
 * unrelated npm project on the way up.
 */
export function findProject(from = process.cwd()) {
  let dir = resolve(from);
  for (let up = 0; up < 8; up += 1) {
    if (existsSync(join(dir, ".env.local"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function notAProject(stderr) {
  stderr.write(
    `${C.red}evestack: this is not an evestack project${C.reset} — no .env.local here or above.\n\n` +
      `  ${C.bold}cd${C.reset} into the directory ${C.bold}evestack create${C.reset} made, or make one:\n\n` +
      `      ${C.bold}npx evestack create my-agent${C.reset}\n\n`,
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

export async function verify(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const projectDir = findProject();
  if (!projectDir) return notAProject(stderr);

  const script = findVerifyScript(projectDir);
  if (!script) {
    stderr.write(
      `${C.red}evestack: could not find the verify script.${C.reset}\n\n` +
        `  From inside the project this is also:  ${C.bold}npm run verify${C.reset}\n\n`,
    );
    return 2;
  }

  if (projectDir !== process.cwd()) {
    stdout.write(`${C.dim}  checking ${projectDir}${C.reset}\n`);
  }

  // Inherited stdio: verify prints colour, asks one question, and its exit code
  // is the answer. Capturing any of that would break all three.
  const result = spawnSync(
    process.execPath,
    ["--env-file-if-exists=.env.local", script, ...argv],
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
  const projectDir = findProject();
  if (!projectDir) return notAProject(stderr);

  const env = readEnvFile(join(projectDir, ".env.local"));
  const value = (key) => process.env[key] || env[key] || undefined;

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

  stdout.write(`\n  ${C.bold}${url}${C.reset}\n`);
  if (password) {
    stdout.write(`  ${C.dim}sign in${C.reset}  ${user} ${C.dim}/${C.reset} ${password}\n`);
  } else {
    stdout.write(
      `  ${C.yellow}EVESTACK_AUTH_PASSWORD is not set${C.reset}${C.dim}, so every route answers 503.${C.reset}\n`,
    );
  }

  if (!healthy) {
    stdout.write(
      `\n  ${C.yellow}Nothing is answering there yet.${C.reset} Start it:\n\n` +
        `      ${C.bold}docker compose --profile dashboard up -d${C.reset}\n\n` +
        `  ${C.dim}then \`evestack open\` again. \`evestack verify\` checks the whole stack.${C.reset}\n\n`,
    );
    return 1;
  }

  stdout.write(`  ${C.green}healthy${C.reset}\n\n`);

  if (argv.includes("--no-open")) return 0;
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
