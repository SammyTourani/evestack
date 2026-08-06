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
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
export const DASHBOARD_IMAGE_TAG = "0.1.0";
export const DASHBOARD_IMAGE = `ghcr.io/sammytourani/evestack-dashboard:${DASHBOARD_IMAGE_TAG}`;
/**
 * True since 2026-08-05, when `dashboard-v0.1.0` published
 * `ghcr.io/sammytourani/evestack-dashboard:0.1.0` as a multi-arch manifest
 * (linux/amd64 + linux/arm64). Verified against the registry anonymously: HTTP
 * 200, both platforms present — so it is public and a stranger can pull it.
 *
 * This one boolean is what stands between "one command" being a claim and being
 * a fact. While false, the scaffolder and `attach` print a build-it-yourself
 * apology and the generated compose file carries a NOT PUBLISHED YET comment.
 * Flipping it before the image exists would make all of that read as true while
 * every user's `--profile dashboard` ended in `manifest unknown`, so it moves
 * only after the tag lands, never in the same commit that cuts the release.
 */
export const DASHBOARD_IMAGE_PUBLISHED = true;

export const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m",
};
export const say = (s = "") => console.log(s);
export const step = (s) => say(`${C.cyan}▚${C.reset} ${s}`);
export const ok = (s) => say(`  ${C.green}✓${C.reset} ${s}`);
export const warn = (s) => say(`  ${C.yellow}!${C.reset} ${s}`);
export const dim = (s) => say(`  ${C.dim}${s}${C.reset}`);

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
    // EOF is not consent. `ask` answers "" both when someone pressed Enter and
    // when stdin closed under it, and mapping "" to the default meant Ctrl-D at
    // a Y/n prompt read as yes — which, on the offers this wizard makes, starts
    // a runtime nobody agreed to start. Enter still takes the default; a closed
    // stdin declines whatever was asked, because nobody was there to answer.
    if (stdinClosed) return false;
    return a === "" ? def : a.startsWith("y");
  };

  // pause/resume are handed out so a caller that spawns a child with
  // `stdio: "inherit"` can stop readline reading the same stdin the child is
  // about to read. Without it the interface and the child race for keystrokes
  // and each gets some of them, which looks like a hung installer.
  return {
    ask,
    confirm,
    pause: () => rl?.pause(),
    resume: () => rl?.resume(),
    close: () => rl?.close(),
  };
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
    // `on`, not `once`. destroy() can emit a second error, and a socket error
    // with no listener is an uncaught exception that takes the process with
    // it — in a probe whose entire job is to fail quietly. done() is
    // idempotent through res(), so extra calls are harmless.
    socket.on("error", () => done(false));
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
