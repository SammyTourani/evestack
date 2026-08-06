/**
 * What has to be true before `docker compose up -d postgres` can work — asked
 * before the wizard's first question rather than discovered afterwards.
 *
 * The scaffolder used to check exactly one of these, in one line, at the very
 * end, after `npm install` had already run:
 *
 *   function hasDocker() {
 *     const r = spawnSync("docker", ["info"], { stdio: "ignore" });
 *     return r.status === 0;
 *   }
 *
 * and printed, for every falsy answer, "Docker isn't running. Start Docker
 * Desktop first." That sentence is wrong in more cases than it is right. A
 * machine with no `docker` binary is told to start an application it has never
 * installed. A Linux user is told to start a macOS application. Someone who
 * installed Docker Engine but is not in the `docker` group — the most common
 * Linux setup mistake there is — is told to start a daemon that is already
 * running. And `spawnSync` with no `timeout` means a Docker Desktop halfway
 * through starting can hang a first-run wizard with no output at all.
 *
 * So the states are separated, because they have different fixes:
 *
 *   missing       no `docker` on PATH             -> install something
 *   stopped       CLI present, daemon silent      -> start it, one command
 *   denied        daemon there, socket refused    -> a group, not the daemon
 *   unresponsive  the CLI itself did not return   -> it is probably starting
 *   running       nothing to do
 *
 * Every check below is split into a probe that shells out and a classifier that
 * is a pure function of what the probe recorded. That is not decoration: it is
 * the only way to test the "no Docker at all" branch on a machine that has
 * Docker, which is every machine this will ever be developed on.
 *
 * Dependency-free, like the rest of this package.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createConnection } from "node:net";
import { C } from "./shared.mjs";

export const DOCKER_RUNNING = "running";
export const DOCKER_STOPPED = "stopped";
export const DOCKER_MISSING = "missing";
export const DOCKER_DENIED = "denied";
export const DOCKER_UNRESPONSIVE = "unresponsive";

/** The Node the template, the `evestack` CLI and this package all declare. */
export const MIN_NODE_MAJOR = 24;

/**
 * Roughly what the whole stack occupies once it is up: the template's
 * node_modules, the pgvector image, the dashboard image (~204 MB compressed and
 * more unpacked), eve's sandbox image, and a database that only grows.
 *
 * A budget, not a measurement — those images are pulled by tag and their sizes
 * move. It is here to catch the case that is not close, which is the only case
 * a number this soft can honestly speak to.
 */
export const RECOMMENDED_FREE_BYTES = 5 * 1024 ** 3;
export const CRITICAL_FREE_BYTES = 2 * 1024 ** 3;

/** Host Postgres port in the generated compose file. */
export const DEFAULT_PG_PORT = 5433;
/** The dashboard. A control plane, published on loopback only. */
export const DEFAULT_DASHBOARD_PORT = 4000;
/** `eve dev`. Not ours to move — see checkPorts. */
export const DEFAULT_AGENT_PORT = 2000;

/* -------------------------------------------------------------------------- */
/* shelling out                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The one place a child process is spawned, so every classifier below is a pure
 * function over a recorded result.
 *
 * `timeout` is not optional and never was. The check this replaces ran
 * `docker info` unbounded, and a Docker Desktop mid-start answers that neither
 * quickly nor at all.
 *
 * `killSignal` is the other half of that, and without it the timeout is a
 * suggestion. spawnSync's timer sends the kill signal and then goes on waiting
 * for the child to actually exit, so a child that ignores SIGTERM — the default
 * — blocks the whole process for as long as it likes. Measured: a child that
 * traps TERM and sleeps 20s returned after 20s from a 700ms timeout. That is
 * precisely the hang this module was written to prevent, so the signal is one
 * that cannot be trapped.
 */
export function runCommand(command, args, { timeoutMs = 6_000, stdio } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    stdio,
  });
  return {
    // ENOENT is "not on PATH". spawnSync reports a timeout as ETIMEDOUT on some
    // platforms and as a bare `signal` on others, so both are read downstream.
    errorCode: result.error?.code ?? null,
    status: result.status,
    signal: result.signal ?? null,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

/**
 * Is this binary on PATH?
 *
 * Through `/bin/sh -c command -v`, because `command` is a shell builtin and
 * cannot be spawned. The argument is JSON-quoted rather than interpolated: it
 * is only ever called with literals today, and a helper that would execute
 * whatever it is handed is a helper waiting for its first dynamic caller.
 */
export function onPath(command, run = runCommand) {
  const result =
    process.platform === "win32"
      ? run("where", [command], { timeoutMs: 3_000 })
      : run("/bin/sh", ["-c", `command -v ${JSON.stringify(command)}`], { timeoutMs: 3_000 });
  return result.status === 0 && result.stdout.trim() !== "";
}

/* -------------------------------------------------------------------------- */
/* Docker                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `docker version --format` with both versions in one call, because it answers
 * both questions at once and answers them differently in each state. Recorded
 * against Docker 29.5.1 on macOS:
 *
 *   daemon up    exit 0, stdout "29.5.1|29.2.1"
 *   daemon down  exit 1, stdout "29.5.1|", plus a stderr line about failing to
 *                connect to the docker API and whether the daemon is running
 *
 * A failed call still reports the client and its version, which is exactly the
 * difference between "install Docker" and "start Docker" — the distinction the
 * old one-line `docker info` check could not make.
 */
export const DOCKER_VERSION_ARGS = [
  "version",
  "--format",
  "{{.Client.Version}}|{{.Server.Version}}",
];

/** Stderr that means the socket is there and this user may not have it. */
const PERMISSION_DENIED = /permission denied/i;

export function classifyDocker(result) {
  if (result.errorCode === "ENOENT") {
    return { state: DOCKER_MISSING, clientVersion: null, serverVersion: null, detail: null };
  }
  // A killed child (the timeout above sends SIGTERM) is neither a missing
  // Docker nor a stopped one. "Docker is not running", said to someone whose
  // Docker is starting, sends them to reinstall something that works.
  if (result.signal !== null || result.errorCode === "ETIMEDOUT") {
    return { state: DOCKER_UNRESPONSIVE, clientVersion: null, serverVersion: null, detail: null };
  }

  const [client = "", server = ""] = result.stdout.trim().split("|");
  const clientVersion = client.trim() || null;
  const serverVersion = server.trim() || null;

  if (result.status === 0 && serverVersion) {
    return { state: DOCKER_RUNNING, clientVersion, serverVersion, detail: null };
  }
  const detail = firstLine(result.stderr) || firstLine(result.stdout) || null;
  if (PERMISSION_DENIED.test(result.stderr)) {
    return { state: DOCKER_DENIED, clientVersion, serverVersion: null, detail };
  }
  // Exit 0 with an empty server field is the same state with a friendlier CLI:
  // the daemon did not answer. Same fix, so the same classification.
  return { state: DOCKER_STOPPED, clientVersion, serverVersion: null, detail };
}

export function probeDocker(run = runCommand) {
  return classifyDocker(run("docker", DOCKER_VERSION_ARGS));
}

/**
 * Compose v2, probed separately and on purpose.
 *
 * It is a client-side CLI plugin: verified that `docker compose version
 * --short` still answers 5.1.3 with DOCKER_HOST pointed at a socket that does
 * not exist. So the question has an answer even when the daemon has none, and
 * it is worth asking. Every command this project prints is a `docker compose`
 * one, and a Homebrew `docker` formula installs the CLI without the compose
 * plugin, which lands a reader on "not a docker command" at step three of a
 * quickstart with nothing to suggest what to do about it.
 */
export function probeCompose(run = runCommand) {
  const result = run("docker", ["compose", "version", "--short"]);
  if (result.status === 0 && result.stdout.trim()) {
    return { present: true, version: result.stdout.trim() };
  }
  return { present: false, version: null };
}

/* -------------------------------------------------------------------------- */
/* which container runtime is actually installed                               */
/* -------------------------------------------------------------------------- */

/**
 * On macOS "start Docker" is not one command, because Docker is not one
 * product. Docker Desktop, OrbStack, Rancher Desktop and Colima all provide a
 * `docker` CLI and all start differently, so a stopped-daemon message has to
 * name the one that is on this machine.
 *
 * Kept as data, and the detection kept pure, so the ordering can be tested
 * without installing four container runtimes.
 */
export const MAC_RUNTIMES = [
  {
    id: "docker-desktop",
    label: "Docker Desktop",
    app: "/Applications/Docker.app",
    start: "open -a Docker",
    spawn: { command: "open", args: ["-a", "Docker"] },
  },
  {
    id: "orbstack",
    label: "OrbStack",
    app: "/Applications/OrbStack.app",
    start: "open -a OrbStack",
    spawn: { command: "open", args: ["-a", "OrbStack"] },
  },
  {
    id: "rancher",
    label: "Rancher Desktop",
    app: "/Applications/Rancher Desktop.app",
    start: "open -a 'Rancher Desktop'",
    spawn: { command: "open", args: ["-a", "Rancher Desktop"] },
  },
];

const COLIMA_RUNTIME = {
  id: "colima",
  label: "Colima",
  app: null,
  start: "colima start",
  spawn: { command: "colima", args: ["start"] },
};

export function detectMacRuntimes({ exists = existsSync, hasColima = false } = {}) {
  const found = MAC_RUNTIMES.filter((r) => exists(r.app));
  // Last rather than first: when a GUI runtime is installed too, that is the
  // more likely one to be how this user normally gets a daemon.
  if (hasColima) found.push(COLIMA_RUNTIME);
  return found;
}

/* -------------------------------------------------------------------------- */
/* platform                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * WSL is a `linux` platform whose Docker usually is not in the distro at all.
 * It is Docker Desktop on the Windows side, exposed into the distro by a
 * checkbox. Telling a WSL user to install a distro package when the fix is
 * "tick WSL integration for this distro" installs a second, conflicting daemon.
 *
 * Pure, so it can be tested from a recorded /proc/version.
 */
export function isWsl({ env = process.env, procVersion = null } = {}) {
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  return typeof procVersion === "string" && /microsoft/i.test(procVersion);
}

export function readProcVersion(read = () => readFileSync("/proc/version", "utf8")) {
  try {
    return read();
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* remedies                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What to tell someone, and, only where it is defensible, what to offer to run
 * for them.
 *
 * `offer` is non-null in exactly two situations, and the difference between
 * them is the whole policy:
 *
 *   start    A runtime that is ALREADY installed. Not privileged, not a
 *            download, undone by quitting the app. Offered, default YES.
 *   install  A container runtime, through a package manager the user already
 *            chose to have, with no sudo anywhere in the command. Offered
 *            after printing the exact command and what it will cost them,
 *            default NO.
 *
 * Nothing else is ever offered. A remote script piped into a root shell, any
 * sudo apt-get or systemctl, adding a user to the docker group (which is
 * equivalent to granting root), and everything on Windows are printed and left
 * to the human. That is not caution for its own sake: each one is privileged or
 * irreversible or both, and a scaffolder is not the right thing to be holding
 * the keyboard for it.
 */
export function dockerRemedy(docker, context = {}) {
  const {
    platform = process.platform,
    wsl = false,
    hasBrew = false,
    macRuntimes = [],
  } = context;

  if (docker.state === DOCKER_RUNNING) return null;

  if (docker.state === DOCKER_UNRESPONSIVE) {
    return {
      headline: "Docker's CLI did not answer in time.",
      why: "Usually that means it is still starting.",
      steps: [],
      manual: [
        "Give it a few seconds and run this again, or run `docker version` yourself to see what it says.",
      ],
      offer: null,
    };
  }

  if (docker.state === DOCKER_DENIED) {
    const version = docker.clientVersion ? ` ${docker.clientVersion}` : "";
    return {
      headline: `Docker${version} is running, but this user cannot reach its socket.`,
      why: "That is the group, not the daemon.",
      steps: ["sudo usermod -aG docker $USER", "newgrp docker      # or log out and back in"],
      manual: [
        "That group is equivalent to root on this machine: the daemon runs as",
        "root and will happily run a container that mounts /. A real decision,",
        "which is why it is not made for you here.",
      ],
      offer: null,
    };
  }

  if (docker.state === DOCKER_STOPPED) {
    return stoppedRemedy(docker, { platform, wsl, macRuntimes });
  }
  return missingRemedy({ platform, wsl, hasBrew });
}

function stoppedRemedy(docker, { platform, wsl, macRuntimes }) {
  const version = docker.clientVersion ? ` ${docker.clientVersion}` : "";
  const headline = `Docker${version} is installed, but its daemon is not answering.`;

  if (wsl) {
    return {
      headline,
      why: "Inside WSL the daemon normally lives on the Windows side.",
      steps: [],
      manual: [
        "Start Docker Desktop on Windows, then Settings, Resources, WSL integration, and enable this distro.",
        "If you meant to run a daemon inside the distro instead: sudo service docker start",
      ],
      offer: null,
    };
  }

  if (platform === "darwin") {
    const runtime = macRuntimes[0] ?? null;
    if (!runtime) {
      return {
        headline,
        why: "A `docker` CLI is on PATH but nothing behind it is providing a daemon, which is what a Homebrew `docker` formula on its own looks like.",
        steps: [],
        manual: [
          "Give it something to talk to: `brew install colima` then `colima start`, or install Docker Desktop from https://docker.com/products/docker-desktop",
        ],
        offer: null,
      };
    }
    return {
      headline,
      why: `${runtime.label} is installed on this machine.`,
      steps: [runtime.start],
      manual: macRuntimes
        .slice(1)
        .map((r) => `${r.label} is installed too. \`${r.start}\` starts that one instead.`),
      offer: {
        kind: "start",
        label: `Start ${runtime.label} now?`,
        command: runtime.spawn.command,
        args: runtime.spawn.args,
        display: runtime.start,
        // Safe to do for them: no privilege, no download, and quitting the app
        // undoes it completely. The one thing here that defaults to yes.
        defaultYes: true,
        size: null,
        // Launching is not the same as being ready. Docker Desktop takes tens
        // of seconds after the app opens, so re-probing immediately would
        // report a failure for something that is working.
        note: "It takes a few seconds to come up; `docker version` tells you when it has.",
      },
    };
  }

  if (platform === "win32") {
    return {
      headline,
      why: null,
      steps: [],
      manual: [
        "Start Docker Desktop from the Start menu and wait for the whale to stop animating.",
        "evestack is happiest run from inside WSL2 with Docker Desktop's WSL integration enabled, rather than from PowerShell.",
      ],
      offer: null,
    };
  }

  return {
    headline,
    why: null,
    steps: ["sudo systemctl start docker", "sudo systemctl enable docker    # and at every boot"],
    manual: [
      "Both need root, so they are printed rather than run for you.",
      "On a distro without systemd: sudo service docker start",
    ],
    offer: null,
  };
}

// Kept to terminal width by hand. These are printed one per line with no
// wrapping, and a 300-character "line" in a first-run wizard reads as noise.
const MAC_ALTERNATIVES = [
  "Docker Desktop is the familiar one, with a GUI and resource sliders:",
  "  brew install --cask docker    (~700 MB; a paid subscription is required",
  "  at larger companies, which is worth knowing before a work laptop)",
  "OrbStack is lighter and faster, same CLI, free for personal use:",
  "  brew install --cask orbstack",
];

function missingRemedy({ platform, wsl, hasBrew }) {
  const headline = "Docker is not installed. Postgres and the agent sandbox both need it.";

  if (wsl) {
    return {
      headline: "No `docker` command in this WSL distro.",
      why: "Almost always that is Docker Desktop not being shared into the distro, rather than Docker being absent.",
      steps: [],
      manual: [
        "Install Docker Desktop for Windows, which uses the WSL2 backend, then Settings, Resources, WSL integration, and enable this distro. Nothing gets installed inside the distro itself.",
        "https://docs.docker.com/desktop/wsl/",
      ],
      offer: null,
    };
  }

  if (platform === "darwin") {
    if (!hasBrew) {
      return {
        headline,
        why: "Homebrew is not on this machine either, so there is nothing here that could install it without guessing.",
        steps: [],
        manual: [
          ...MAC_ALTERNATIVES,
          "Colima has no GUI and no licence question. Install Homebrew from",
          "https://brew.sh, then: brew install colima docker docker-compose",
        ],
        offer: null,
      };
    }
    return {
      headline,
      why: "Homebrew is here, so one command fixes it.",
      steps: ["brew install colima docker docker-compose", "colima start"],
      manual: MAC_ALTERNATIVES,
      offer: {
        kind: "install",
        label: "Install Colima and the Docker CLI with Homebrew now?",
        command: "brew",
        args: ["install", "colima", "docker", "docker-compose"],
        display: "brew install colima docker docker-compose",
        // A download this size, onto someone else's machine, is not a default.
        defaultYes: false,
        size: "a few hundred MB, plus a ~500 MB Linux VM image on first `colima start`",
        // Why Colima rather than Docker Desktop, which is what most people
        // expect: it is the only one of the three that installs without root,
        // ships no GUI application, and carries no licence asterisk. Anyone who
        // wants Docker Desktop can have it, and it is printed first above.
        note: "Homebrew installs the CLI; it does not start a VM. Run `colima start` afterwards.",
      },
    };
  }

  if (platform === "win32") {
    return {
      headline,
      why: null,
      steps: [],
      manual: [
        "Install Docker Desktop for Windows: `winget install Docker.DockerDesktop`, or https://docker.com/products/docker-desktop",
        "It needs WSL2 enabled and a reboot, which is not something to do from inside a scaffolder.",
        "Then run evestack from inside a WSL2 distro with Docker Desktop's WSL integration enabled.",
      ],
      offer: null,
    };
  }

  return {
    headline,
    why: "Every way of installing it on Linux needs root and changes system services, so these are printed rather than run for you.",
    steps: [],
    manual: [
      "Docker's own repository, which is the build Docker supports: https://docs.docker.com/engine/install/ and pick your distro.",
      "The convenience script at https://get.docker.com is the same thing in one line. It runs as root, and it is a remote script piped into a shell; read it first if that matters to you.",
      "Distro packages are older but simpler: on Debian or Ubuntu `sudo apt-get install docker.io docker-compose-v2`, on Fedora `sudo dnf install moby-engine docker-compose`, on Arch `sudo pacman -S docker docker-compose`.",
      "Afterwards `sudo systemctl enable --now docker`, then `sudo usermod -aG docker $USER` so you can use it without sudo. That group is equivalent to root, so read the docs before you decide.",
    ],
    offer: null,
  };
}

/* -------------------------------------------------------------------------- */
/* ports                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Does something already answer on this loopback port?
 *
 * Moved here from attach.mjs, which has had this pair since it learned to pick
 * a Postgres port. `create` had no equivalent and hardcoded 5433 into both the
 * compose file and .env.local, so a second scaffold on the same machine, which
 * is the ordinary act of trying evestack twice, ended minutes later at
 * `docker compose up` with a bind failure about a port already allocated, from
 * a tool the reader did not know they were configuring.
 *
 * For `attach` the stake is higher than a confusing error. A second attached
 * project handed the port the first one already owns is pointed at the first
 * one's database, and reads somebody else's sessions without either side
 * failing.
 *
 * A connect probe, not a bind probe, and the difference matters: a port bound
 * only on some other interface is invisible here and still collides in Docker.
 * That case keeps Docker's own error. This catches the common one.
 */
export function portAnswers(port, { host = "127.0.0.1", timeoutMs = 400 } = {}) {
  return new Promise((res) => {
    const socket = createConnection({ host, port });
    const done = (answered) => {
      socket.destroy();
      res(answered);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/**
 * The first port from `start` that nothing answers on, or `start` itself if the
 * whole window is busy, at which point Docker's own error is the honest outcome
 * and inventing a port would only move the confusion.
 */
export async function freePort(start, { span = 20, answers = portAnswers } = {}) {
  for (let port = start; port < start + span; port += 1) {
    if (!(await answers(port))) return port;
  }
  return start;
}

/**
 * The two ports whose mapping this project controls, plus a look at the one it
 * does not.
 *
 * `eve dev` takes 2000 and auto-increments when it is busy, so a conflict there
 * is not an error. It is not harmless either: the dashboard's
 * EVESTACK_AGENT_URL points at 2000, so an agent that quietly landed on 2001
 * leaves a dashboard whose chat and approvals talk to whatever else is on 2000,
 * or to nothing at all. Reported, never remapped, because only eve knows where
 * it ended up and it does not know until it boots.
 */
export async function checkPorts({
  pg = DEFAULT_PG_PORT,
  dashboard = DEFAULT_DASHBOARD_PORT,
  agent = DEFAULT_AGENT_PORT,
  answers = portAnswers,
} = {}) {
  const pgPort = await freePort(pg, { answers });
  const dashboardPort = await freePort(dashboard, { answers });
  const agentBusy = await answers(agent);
  return {
    pg: { wanted: pg, chosen: pgPort, moved: pgPort !== pg },
    dashboard: { wanted: dashboard, chosen: dashboardPort, moved: dashboardPort !== dashboard },
    agent: { wanted: agent, busy: agentBusy },
  };
}

/* -------------------------------------------------------------------------- */
/* Node                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Reported, not enforced.
 *
 * Node >=24 is declared in `engines` by this package, by `evestack` and by the
 * template, and npm answers all three with an EBADENGINE warning and carries
 * on, which is a line that scrolls past inside npx output nobody reads. But
 * nothing in this repo has established what actually breaks on Node 22, and
 * refusing to scaffold over a number we have not tested against would be the
 * scaffolder inventing a requirement. So: say it clearly, once, and continue.
 */
export function checkNode(version = process.version, minMajor = MIN_NODE_MAJOR) {
  const major = Number(/^v?(\d+)/.exec(String(version))?.[1]);
  if (!Number.isFinite(major)) return { ok: true, major: null, version, minMajor };
  return { ok: major >= minMajor, major, version, minMajor };
}

/* -------------------------------------------------------------------------- */
/* disk                                                                        */
/* -------------------------------------------------------------------------- */

export function classifyDisk(freeBytes) {
  if (typeof freeBytes !== "number" || !Number.isFinite(freeBytes)) {
    // A disk check that could not run is not a finding.
    return { known: false, ok: true, critical: false, freeBytes: null };
  }
  return {
    known: true,
    ok: freeBytes >= RECOMMENDED_FREE_BYTES,
    critical: freeBytes < CRITICAL_FREE_BYTES,
    freeBytes,
  };
}

/**
 * Free bytes on the filesystem that will hold `dir`, or null if it cannot be
 * read.
 *
 * Walks up to the nearest ancestor that exists, because the caller passes the
 * project directory and the whole point is that it has not been created yet.
 * Answering "unknown" there would silently disable the check for every run,
 * and answering about the current directory would be a lie for anyone
 * scaffolding onto a different volume.
 */
export async function probeDisk(dir) {
  try {
    const { statfs } = await import("node:fs/promises");
    const stats = await statfs(nearestExisting(dir));
    // bavail is blocks available to an unprivileged user, which is the number
    // that matters here; bfree includes a root reserve we cannot touch.
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

export function formatBytes(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "unknown";
  const gb = bytes / 1024 ** 3;
  if (gb >= 10) return `${Math.round(gb)} GB`;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/* -------------------------------------------------------------------------- */
/* the whole check                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Everything above, once, into a plain object.
 *
 * Rendering lives in preflightLines() below, so the human output and anything
 * machine readable stay one diagnosis rather than two that can disagree, which
 * is the shape `evestack doctor` already uses for the same reason. Every impure
 * input is injectable, so the whole report can be produced for a machine that
 * is not this one.
 */
export async function preflight({ dir = process.cwd(), answers = portAnswers, nodeVersion = process.version, freeBytes = undefined, ...docker } = {}) {
  return {
    ...inspectDocker(docker),
    ports: await checkPorts({ answers }),
    node: checkNode(nodeVersion),
    disk: classifyDisk(freeBytes === undefined ? await probeDisk(dir) : freeBytes),
  };
}

/**
 * The Docker half on its own: state, compose plugin, and what to do about it.
 *
 * Split out because `attach` needs exactly this and nothing else. It wraps a
 * project that already exists, so it has no ports to allocate and no install to
 * offer, but it still prints `docker compose up -d postgres` at the end and had
 * no idea whether that would work.
 */
export function inspectDocker({
  run = runCommand,
  platform = process.platform,
  env = process.env,
  exists = existsSync,
  readProc = undefined,
} = {}) {
  const docker = probeDocker(run);
  // No point asking a CLI that is not there whether it has a plugin.
  const compose =
    docker.state === DOCKER_MISSING ? { present: false, version: null } : probeCompose(run);

  const wsl =
    platform === "linux" &&
    isWsl({
      env,
      procVersion: readProc === undefined ? readProcVersion() : readProcVersion(readProc),
    });
  const hasBrew = platform === "darwin" ? onPath("brew", run) : false;
  const hasColima = platform === "darwin" ? onPath("colima", run) : false;
  const macRuntimes = platform === "darwin" ? detectMacRuntimes({ exists, hasColima }) : [];

  return {
    platform,
    wsl,
    hasBrew,
    docker,
    compose,
    remedy: dockerRemedy(docker, { platform, wsl, hasBrew, macRuntimes }),
  };
}

/**
 * Is there anything here a stranger has to act on?
 *
 * Used to decide whether the block is printed at all. A green machine sees
 * nothing, because a preflight that always prints is a preflight nobody reads.
 */
export function hasFindings(report) {
  return Boolean(
    report.remedy ||
      !report.compose.present ||
      report.ports.pg.moved ||
      report.ports.dashboard.moved ||
      report.ports.agent.busy ||
      !report.node.ok ||
      !report.disk.ok,
  );
}

function firstLine(text) {
  return (
    String(text ?? "")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "") ?? ""
  );
}

/* -------------------------------------------------------------------------- */
/* rendering                                                                   */
/* -------------------------------------------------------------------------- */

const okLine = (s) => `  ${C.green}✓${C.reset} ${s}`;
const warnLine = (s) => `  ${C.yellow}!${C.reset} ${s}`;
const dimLine = (s) => `  ${C.dim}${s}${C.reset}`;
const cmdLine = (s) => `      ${C.bold}${s}${C.reset}`;

/**
 * The report as terminal lines. A pure function so the wording can be asserted
 * in a test rather than eyeballed once and then quietly rotted.
 */
export function preflightLines(report) {
  const lines = [];
  lines.push(...dockerStatusLines(report));
  lines.push(...portLines(report.ports));
  lines.push(...nodeLines(report.node));
  lines.push(...diskLines(report.disk));
  return lines;
}

export function dockerStatusLines(report) {
  const { docker, compose, remedy } = report;
  const lines = [];

  if (docker.state === DOCKER_RUNNING) {
    const version = docker.serverVersion ? ` ${docker.serverVersion}` : "";
    lines.push(okLine(`Docker${version} is running`));
  } else if (remedy) {
    for (const line of wrapNote(remedy.headline)) lines.push(warnLine(line));
    if (remedy.why) for (const line of wrapNote(remedy.why)) lines.push(dimLine(line));
    if (remedy.steps.length > 0) {
      lines.push("");
      for (const step of remedy.steps) lines.push(cmdLine(step));
      lines.push("");
    }
    for (const note of remedy.manual) {
      for (const line of wrapNote(note)) lines.push(dimLine(line));
    }
  }

  // Only worth its own line when the CLI is there to be missing a plugin. With
  // Docker itself absent, its plugins are not the reader's problem yet.
  if (docker.state !== DOCKER_MISSING && !compose.present) {
    lines.push(warnLine("`docker compose` is not available, and every command below uses it."));
    lines.push(dimLine("Compose v2 is a CLI plugin. Docker Desktop and OrbStack ship it; a"));
    lines.push(dimLine("Homebrew `docker` on its own does not: brew install docker-compose"));
  } else if (docker.state === DOCKER_RUNNING && compose.version) {
    lines.push(okLine(`docker compose ${compose.version}`));
  }

  return lines;
}

function portLines(ports) {
  const lines = [];
  if (ports.pg.moved) {
    lines.push(
      warnLine(`Port ${ports.pg.wanted} is taken, so Postgres will use ${ports.pg.chosen} instead.`),
    );
    lines.push(dimLine("Written into both docker-compose.yml and .env.local, so nothing to change."));
  }
  if (ports.dashboard.moved) {
    lines.push(
      warnLine(
        `Port ${ports.dashboard.wanted} is taken, so the dashboard will use ${ports.dashboard.chosen}.`,
      ),
    );
  }
  if (ports.agent.busy) {
    lines.push(warnLine(`Something already answers on ${ports.agent.wanted}, where \`eve dev\` wants to listen.`));
    lines.push(dimLine("eve moves itself to the next free port and prints it at startup. The"));
    lines.push(dimLine("dashboard still looks for the agent on 2000, so set EVESTACK_AGENT_URL"));
    lines.push(dimLine("to the port eve actually chose, or free 2000 before starting."));
  }
  return lines;
}

function nodeLines(node) {
  if (node.ok) return [];
  return [
    warnLine(`Node ${node.version}. evestack and eve both ask for Node ${node.minMajor} or newer.`),
    dimLine("npm prints this as an EBADENGINE warning and installs anyway, so the first"),
    dimLine("sign of trouble is usually a runtime error that names none of this."),
    dimLine("nvm install 24, or fnm install 24, or https://nodejs.org"),
  ];
}

function diskLines(disk) {
  if (!disk.known || disk.ok) return [];
  const free = formatBytes(disk.freeBytes);
  const lines = [
    warnLine(`${free} free on this disk. The whole stack wants roughly 5 GB.`),
    dimLine("node_modules, a Postgres image, the dashboard image, eve's sandbox image,"),
    dimLine("and a database that only grows."),
  ];
  if (disk.critical) {
    lines.push(dimLine("At this much free space the image pulls are unlikely to finish."));
  }
  return lines;
}

/* -------------------------------------------------------------------------- */
/* offers                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What the reader sees immediately before being asked to consent.
 *
 * The exact command, verbatim, on its own line, plus what it costs. Nobody
 * should ever be asked "shall I install Docker?" without being shown the
 * literal thing that is about to run on their machine.
 */
export function offerLines(offer) {
  const lines = ["", `  ${C.bold}This would run:${C.reset}`, cmdLine(offer.display)];
  if (offer.size) for (const l of wrapNote(`Downloads ${offer.size}.`)) lines.push(dimLine(l));
  if (offer.note) for (const l of wrapNote(offer.note)) lines.push(dimLine(l));
  lines.push(dimLine("Say no and the commands above are yours to run whenever you like."));
  return lines;
}

/**
 * How long each kind of offer is given before it is abandoned.
 *
 * A package-manager install is minutes of downloading and must not be killed
 * at the six seconds a version probe gets. Launching an application returns
 * immediately, and one that does not has failed.
 */
export const OFFER_TIMEOUT_MS = { install: 30 * 60_000, start: 60_000 };

/**
 * Run an offer the user has explicitly accepted.
 *
 * `stdio: "inherit"` on purpose: a package manager's progress, its own
 * questions, and anything it wants to say about permissions all belong on the
 * user's terminal rather than swallowed into a variable and summarised. It also
 * means `stdout` comes back empty, which is why only the exit status is read.
 *
 * `run` is injectable, so the decision logic around this is testable without
 * installing anything. What no test here can prove is that the command produces
 * a working Docker on a machine that did not have one; that is verified by
 * running it, which is exactly why it is never run without being asked.
 */
export function applyOffer(offer, { run = runCommand } = {}) {
  const timeoutMs = OFFER_TIMEOUT_MS[offer.kind] ?? 60_000;
  const result = run(offer.command, offer.args, { timeoutMs, stdio: "inherit" });
  return { ok: result.status === 0, result };
}

/**
 * Wrap prose to something a terminal can hold.
 *
 * The remedy strings above are written as sentences rather than as pre-broken
 * lines, because a sentence is what a human edits without counting columns.
 * Wrapping happens here instead, once, at the point where width is a real
 * constraint. A string that already starts with whitespace is left alone: that
 * is a deliberately indented continuation and re-flowing it would destroy the
 * shape it was given.
 */
export function wrapNote(text, width = 76) {
  const value = String(text ?? "");
  if (value === "" || /^\s/.test(value)) return [value];
  const out = [];
  let line = "";
  for (const word of value.split(/\s+/)) {
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line !== "") out.push(line);
  return out;
}

/**
 * The nearest ancestor of `dir` that exists, or `dir` itself if it does.
 *
 * Bounded by the loop's own termination condition: `dirname` of a filesystem
 * root is that root, so the walk stops there whether or not anything exists.
 */
export function nearestExisting(dir, exists = existsSync) {
  let current = resolve(dir);
  while (!exists(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}
