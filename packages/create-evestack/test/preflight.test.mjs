import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  COLIMA_RUNTIME,
  DOCKER_DENIED,
  DOCKER_MISSING,
  DOCKER_RUNNING,
  DOCKER_STOPPED,
  DOCKER_UNRESPONSIVE,
  MAC_RUNTIMES,
  OFFER_TIMEOUT_MS,
  applyOffer,
  checkNode,
  checkPorts,
  classifyDisk,
  classifyDocker,
  detectMacRuntimes,
  dockerRemedy,
  freePort,
  hasFindings,
  isWsl,
  nearestExisting,
  onPath,
  probeDisk,
  preflightLines,
  probeCompose,
  runCommand,
  wrapNote,
} from "../preflight.mjs";

/**
 * The preflight exists because of one line the scaffolder printed for a long
 * time:
 *
 *   "Docker isn't running. Start Docker Desktop first."
 *
 * It was printed for every non-zero exit of `docker info`: no Docker at all, a
 * permissions problem, a CLI that had not answered yet, and Linux, where Docker
 * Desktop is not what anybody is running. Most of what follows asserts those
 * states are now told apart, and that the two which lead to an offer lead to a
 * SAFE one.
 */

const ANSI = /\x1b\[[0-9;]*m/g;
const plain = (lines) => lines.map((l) => l.replace(ANSI, "")).join("\n");

/** A spawn result of the shape runCommand() produces. */
const result = (over = {}) => ({
  errorCode: null,
  status: 0,
  signal: null,
  stdout: "",
  stderr: "",
  ...over,
});

/* -------------------------------------------------------------------------- */
/* the five states                                                             */
/* -------------------------------------------------------------------------- */

test("no docker binary is `missing`, not `not running`", () => {
  const state = classifyDocker(result({ errorCode: "ENOENT", status: null }));
  assert.equal(state.state, DOCKER_MISSING);
  assert.equal(state.clientVersion, null);
});

test("a daemon that answers is `running`, and reports the server version", () => {
  const state = classifyDocker(result({ stdout: "29.5.1|29.2.1\n" }));
  assert.equal(state.state, DOCKER_RUNNING);
  assert.equal(state.clientVersion, "29.5.1");
  assert.equal(state.serverVersion, "29.2.1");
});

test("a CLI whose daemon is silent is `stopped`, and the client version survives", () => {
  // Recorded from a real Docker 29.5.1 with DOCKER_HOST pointed at a socket
  // that does not exist. The client half of stdout is still printed, which is
  // what makes "start Docker" distinguishable from "install Docker".
  const state = classifyDocker(
    result({
      status: 1,
      stdout: "29.5.1|\n",
      stderr:
        "failed to connect to the docker API at unix:///nonexistent/docker.sock; check if the path is correct and if the daemon is running",
    }),
  );
  assert.equal(state.state, DOCKER_STOPPED);
  assert.equal(state.clientVersion, "29.5.1");
  assert.equal(state.serverVersion, null);
});

test("a refused socket is `denied` — a group problem, not a daemon problem", () => {
  const state = classifyDocker(
    result({
      status: 1,
      stdout: "27.0.0|\n",
      stderr:
        "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock",
    }),
  );
  assert.equal(state.state, DOCKER_DENIED);
});

test("a CLI killed by the timeout is `unresponsive`, not `missing`", () => {
  // Docker Desktop mid-start. Telling this user to install Docker sends them to
  // reinstall something that is working.
  assert.equal(classifyDocker(result({ status: null, signal: "SIGTERM" })).state, DOCKER_UNRESPONSIVE);
  assert.equal(classifyDocker(result({ errorCode: "ETIMEDOUT", status: null })).state, DOCKER_UNRESPONSIVE);
});

test("exit 0 with an empty server field is still a stopped daemon", () => {
  // Some CLI and daemon combinations do not treat an unreachable daemon as an
  // error. Same situation, same fix, so the same classification.
  assert.equal(classifyDocker(result({ stdout: "29.5.1|\n" })).state, DOCKER_STOPPED);
});

test("onPath hands the shell a name, not a script", () => {
  // The real shell, on purpose. JSON.stringify was being used as a shell quoter
  // here: it escapes `"` and `\` and leaves `$` and backticks alone, so
  // `command -v "$(...)"` ran the substitution. Verified before the fix — this
  // marker file appeared. A stub for `run` could not have caught it, because
  // the argv it records looks harmless right up until /bin/sh parses it.
  const marker = join(tmpdir(), `evestack-onpath-${process.pid}-${Date.now()}`);
  rmSync(marker, { force: true });
  try {
    assert.equal(onPath(`$(touch ${marker})`), false);
    assert.equal(existsSync(marker), false, "onPath executed its argument as shell");
    // The same thing where the substitution would have produced a real answer:
    // `command -v "$(echo sh)"` used to resolve /bin/sh and report true.
    assert.equal(onPath("$(echo sh)"), false, "onPath let the shell rewrite the name");
    // And it still answers the question it is actually for.
    assert.equal(onPath("sh"), true);
  } finally {
    rmSync(marker, { force: true });
  }
});

test("the timeout is a wall-clock bound, not a suggestion", () => {
  // spawnSync sends killSignal and then keeps waiting for the child to exit, so
  // with the default SIGTERM the bound is advisory: anything that traps the
  // signal runs to completion. Measured before the fix — a 700ms timeout took
  // 20s — and that is exactly the "Docker Desktop mid-start hangs the wizard"
  // failure the whole module was written to prevent.
  const started = Date.now();
  const result = runCommand("/bin/sh", ["-c", "trap '' TERM; sleep 20"], { timeoutMs: 700 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 10_000, `the timeout did not bound the call: ${elapsed}ms`);
  // And the caller still gets a state it can act on rather than a hang.
  assert.equal(classifyDocker(result).state, DOCKER_UNRESPONSIVE);
});

test("compose is absent unless the plugin answers with a version", () => {
  assert.deepEqual(probeCompose(() => result({ stdout: "5.1.3\n" })), {
    present: true,
    version: "5.1.3",
  });
  assert.equal(probeCompose(() => result({ status: 1, stderr: "not a docker command" })).present, false);
  // Exit 0 and nothing printed is not a version.
  assert.equal(probeCompose(() => result({ stdout: "" })).present, false);
});

/* -------------------------------------------------------------------------- */
/* what we offer to do, and what we refuse to                                  */
/* -------------------------------------------------------------------------- */

const MISSING = classifyDocker(result({ errorCode: "ENOENT", status: null }));
const STOPPED = classifyDocker(result({ status: 1, stdout: "29.5.1|", stderr: "cannot connect" }));
const DENIED = classifyDocker(
  result({ status: 1, stdout: "27.0.0|", stderr: "permission denied while trying to connect" }),
);
const DESKTOP = {
  id: "docker-desktop",
  label: "Docker Desktop",
  start: "open -a Docker",
  spawn: { command: "open", args: ["-a", "Docker"] },
};

test("a running Docker produces no remedy at all", () => {
  assert.equal(dockerRemedy(classifyDocker(result({ stdout: "1|1" })), { platform: "darwin" }), null);
});

/**
 * The argv, rendered the way a shell would have to be given it.
 *
 * `display` is prose in a `This would run:` block and argv is what spawns, so
 * the two are only the same command if the prose parses back to the argv. A
 * plain join says they do when they do not: `open -a Rancher Desktop` reads as
 * three arguments, and running it opens an application called Rancher.
 */
function asShellLine(argv) {
  return argv
    .map((word) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, String.raw`'\''`)}'`))
    .join(" ");
}

test("NOTHING this offers to run contains sudo", () => {
  // The rule the whole module is organised around. Every reachable combination
  // is walked rather than the two that happen to have offers today, so adding a
  // remedy with a privileged command in it fails here rather than on a
  // stranger's machine.
  //
  // The runtime lists are the SHIPPED table, not a fixture. This walked a
  // hand-written DESKTOP object, which is the one macOS runtime whose display
  // string happens to need no quoting — so the invariant it exists to enforce
  // was never applied to Rancher Desktop or to Colima at all.
  const runtimes = [[], ...MAC_RUNTIMES.map((r) => [r]), [COLIMA_RUNTIME], [...MAC_RUNTIMES, COLIMA_RUNTIME]];
  let offers = 0;
  for (const platform of ["darwin", "linux", "win32"]) {
    for (const wsl of [true, false]) {
      for (const hasBrew of [true, false]) {
        for (const macRuntimes of runtimes) {
          for (const state of [MISSING, STOPPED, DENIED]) {
            const remedy = dockerRemedy(state, { platform, wsl, hasBrew, macRuntimes });
            if (!remedy?.offer) continue;
            offers += 1;
            const argv = [remedy.offer.command, ...remedy.offer.args];
            const line = argv.join(" ");
            assert.ok(!/\bsudo\b/.test(line), `${platform} ${state.state} would run: ${line}`);
            assert.equal(
              remedy.offer.display,
              asShellLine(argv),
              "the command shown is not the command that runs",
            );
          }
        }
      }
    }
  }
  // A silent zero here would make every assertion above vacuous.
  assert.ok(offers >= 8, `only ${offers} offers were reached`);
});

test("every runtime in the shipped table can be started by what it displays", () => {
  // MAC_RUNTIMES and COLIMA_RUNTIME are data, and data is where a display
  // string drifts from its argv without any code changing.
  for (const runtime of [...MAC_RUNTIMES, COLIMA_RUNTIME]) {
    assert.equal(runtime.start, asShellLine([runtime.spawn.command, ...runtime.spawn.args]), runtime.id);
    assert.ok(!/\bsudo\b/.test(runtime.start), runtime.id);
  }
});

test("installing defaults to no; starting something already installed defaults to yes", () => {
  const install = dockerRemedy(MISSING, { platform: "darwin", hasBrew: true, macRuntimes: [] }).offer;
  assert.equal(install.kind, "install");
  assert.equal(install.defaultYes, false, "a several-hundred-MB install must not be the default");
  assert.ok(install.size, "an install offer has to say what it downloads");

  const start = dockerRemedy(STOPPED, { platform: "darwin", macRuntimes: [DESKTOP] }).offer;
  assert.equal(start.kind, "start");
  assert.equal(start.defaultYes, true);
  assert.deepEqual([start.command, ...start.args], ["open", "-a", "Docker"]);
});

test("Linux is never offered an automated install", () => {
  // Every path there is root and system services: a repository, a remote script
  // piped into a shell, or a distro package. All printed, none run.
  const remedy = dockerRemedy(MISSING, { platform: "linux" });
  assert.equal(remedy.offer, null);
  const text = remedy.manual.join("\n");
  assert.match(text, /docs\.docker\.com\/engine\/install/);
  assert.match(text, /get\.docker\.com/);
  assert.match(text, /runs as root/);
});

test("Windows is never offered an automated install either", () => {
  const remedy = dockerRemedy(MISSING, { platform: "win32" });
  assert.equal(remedy.offer, null);
  assert.match(remedy.manual.join("\n"), /WSL2/);
});

test("macOS without Homebrew is told how, not asked", () => {
  const remedy = dockerRemedy(MISSING, { platform: "darwin", hasBrew: false, macRuntimes: [] });
  assert.equal(remedy.offer, null);
  assert.match(remedy.manual.join("\n"), /brew\.sh/);
});

test("WSL is told to tick a checkbox, not to install a second daemon", () => {
  const remedy = dockerRemedy(MISSING, { platform: "linux", wsl: true });
  assert.equal(remedy.offer, null);
  const text = `${remedy.headline}\n${remedy.why}\n${remedy.manual.join("\n")}`;
  assert.match(text, /WSL integration/);
  assert.doesNotMatch(text, /apt-get/, "installing a distro daemon beside Docker Desktop is the wrong fix");
});

test("a refused socket names the group, and warns what that group is", () => {
  const remedy = dockerRemedy(DENIED, { platform: "linux" });
  assert.equal(remedy.offer, null, "adding a user to the docker group is granting root");
  assert.match(remedy.steps.join("\n"), /usermod -aG docker/);
  assert.match(remedy.manual.join("\n"), /equivalent to root/);
});

test("a macOS box with a docker CLI and no runtime is not told to start one", () => {
  const remedy = dockerRemedy(STOPPED, { platform: "darwin", macRuntimes: [] });
  assert.equal(remedy.offer, null);
  assert.match(remedy.manual.join("\n"), /colima|Docker Desktop/);
});

test("the runtime named is one that is actually installed, and the others are mentioned", () => {
  const orbstack = {
    id: "orbstack",
    label: "OrbStack",
    start: "open -a OrbStack",
    spawn: { command: "open", args: ["-a", "OrbStack"] },
  };
  const remedy = dockerRemedy(STOPPED, { platform: "darwin", macRuntimes: [DESKTOP, orbstack] });
  assert.match(remedy.why, /Docker Desktop is installed/);
  assert.match(remedy.manual.join("\n"), /OrbStack is installed too/);
});

test("GUI runtimes are detected by their app bundle, Colima by its binary", () => {
  const found = detectMacRuntimes({
    exists: (path) => path === "/Applications/OrbStack.app",
    hasColima: true,
  });
  assert.deepEqual(found.map((r) => r.id), ["orbstack", "colima"]);
  // Colima last: when a GUI runtime is present too, that is the more likely
  // way this user normally gets a daemon.
  assert.deepEqual(
    detectMacRuntimes({ exists: () => true, hasColima: true }).map((r) => r.id),
    ["docker-desktop", "orbstack", "rancher", "colima"],
  );
});

test("an accepted offer runs exactly the command it displayed, and nothing else", () => {
  const calls = [];
  const offer = dockerRemedy(MISSING, { platform: "darwin", hasBrew: true, macRuntimes: [] }).offer;
  const outcome = applyOffer(offer, {
    run: (command, args, options) => {
      calls.push({ command, args, options });
      return result({ status: 0 });
    },
  });
  assert.equal(outcome.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].command, "brew");
  assert.deepEqual(calls[0].args, ["install", "colima", "docker", "docker-compose"]);
  // Inherited so the package manager's own output and questions reach the user
  // rather than being swallowed and summarised.
  assert.equal(calls[0].options.stdio, "inherit");
  // Minutes, not the six seconds a version probe gets.
  assert.equal(calls[0].options.timeoutMs, OFFER_TIMEOUT_MS.install);
  assert.ok(OFFER_TIMEOUT_MS.install > OFFER_TIMEOUT_MS.start);
});

test("a non-zero exit from an accepted offer is reported as a failure", () => {
  const offer = dockerRemedy(MISSING, { platform: "darwin", hasBrew: true, macRuntimes: [] }).offer;
  assert.equal(applyOffer(offer, { run: () => result({ status: 1 }) }).ok, false);
});

test("WSL is recognised from the env var or from /proc/version", () => {
  assert.equal(isWsl({ env: { WSL_DISTRO_NAME: "Ubuntu" } }), true);
  assert.equal(isWsl({ env: {}, procVersion: "Linux version 5.15.0-microsoft-standard-WSL2" }), true);
  assert.equal(isWsl({ env: {}, procVersion: "Linux version 6.8.0-generic" }), false);
  assert.equal(isWsl({ env: {}, procVersion: null }), false);
});

/* -------------------------------------------------------------------------- */
/* ports                                                                       */
/* -------------------------------------------------------------------------- */

/** Answers true for the ports named, false for everything else. */
const busy = (...ports) => async (port) => ports.includes(port);

test("a taken port is stepped over, not collided with", async () => {
  assert.equal(await freePort(5433, { answers: busy(5433, 5434) }), 5435);
  assert.equal(await freePort(5433, { answers: busy() }), 5433);
});

test("a window that is entirely busy falls back to the wanted port", async () => {
  // Docker's own bind error is then the honest outcome. Inventing a port that
  // is also taken would move the confusion rather than remove it.
  assert.equal(await freePort(5433, { answers: async () => true, span: 3 }), 5433);
});

test("Postgres and the dashboard move; the agent port is only reported", async () => {
  const ports = await checkPorts({ answers: busy(5433, 4000, 2000) });
  assert.deepEqual(ports.pg, { wanted: 5433, chosen: 5434, moved: true });
  assert.deepEqual(ports.dashboard, { wanted: 4000, chosen: 4001, moved: true });
  // `eve dev` picks its own port and auto-increments. Nothing here can tell it
  // where to land, so this is a warning, not a remapping.
  assert.deepEqual(ports.agent, { wanted: 2000, busy: true });
  assert.equal("chosen" in ports.agent, false);
});

test("a clear machine keeps the documented ports", async () => {
  const ports = await checkPorts({ answers: busy() });
  assert.equal(ports.pg.moved, false);
  assert.equal(ports.dashboard.moved, false);
  assert.equal(ports.agent.busy, false);
});

/* -------------------------------------------------------------------------- */
/* node, disk, and when to say nothing                                          */
/* -------------------------------------------------------------------------- */

test("the Node check reads the major and does not throw on nonsense", () => {
  assert.equal(checkNode("v22.14.0").ok, false);
  assert.equal(checkNode("v24.0.0").ok, true);
  assert.equal(checkNode("v26.0.0").ok, true);
  // Unparseable is not a finding: inventing a requirement out of a version
  // string we could not read would be worse than saying nothing.
  assert.equal(checkNode("something-else").ok, true);
});

test("disk is a finding only when it is genuinely short", () => {
  const GB = 1024 ** 3;
  assert.equal(classifyDisk(200 * GB).ok, true);
  assert.equal(classifyDisk(3 * GB).ok, false);
  assert.equal(classifyDisk(3 * GB).critical, false);
  assert.equal(classifyDisk(1 * GB).critical, true);
  // statfs is not available everywhere. A check that could not run says nothing.
  assert.deepEqual(classifyDisk(null), { known: false, ok: true, critical: false, freeBytes: null });
});

const GREEN = {
  docker: classifyDocker(result({ stdout: "29.5.1|29.2.1" })),
  compose: { present: true, version: "5.1.3" },
  remedy: null,
  ports: {
    pg: { wanted: 5433, chosen: 5433, moved: false },
    dashboard: { wanted: 4000, chosen: 4000, moved: false },
    agent: { wanted: 2000, busy: false },
  },
  node: checkNode("v24.0.0"),
  disk: classifyDisk(200 * 1024 ** 3),
};

test("a machine with nothing wrong produces no findings, so nothing is printed", () => {
  // A preflight that always prints is a preflight nobody reads.
  assert.equal(hasFindings(GREEN), false);
});

test("every individual problem is enough to make the block appear", () => {
  const variants = {
    "compose missing": { ...GREEN, compose: { present: false, version: null } },
    "pg port moved": { ...GREEN, ports: { ...GREEN.ports, pg: { wanted: 5433, chosen: 5434, moved: true } } },
    "agent port busy": { ...GREEN, ports: { ...GREEN.ports, agent: { wanted: 2000, busy: true } } },
    "old node": { ...GREEN, node: checkNode("v22.0.0") },
    "low disk": { ...GREEN, disk: classifyDisk(1024 ** 3) },
    "docker down": { ...GREEN, docker: STOPPED, remedy: dockerRemedy(STOPPED, { platform: "linux" }) },
  };
  for (const [name, report] of Object.entries(variants)) {
    assert.equal(hasFindings(report), true, name);
  }
});

/* -------------------------------------------------------------------------- */
/* what the reader actually sees                                               */
/* -------------------------------------------------------------------------- */

const render = (over) => plain(preflightLines({ ...GREEN, ...over }));

test("a Linux box with no Docker is never told to start Docker Desktop", () => {
  // The exact regression. One sentence, printed for every failure state, that
  // named a macOS application to a Linux user who had no Docker at all.
  const text = render({
    docker: MISSING,
    compose: { present: false, version: null },
    remedy: dockerRemedy(MISSING, { platform: "linux" }),
  });
  assert.match(text, /Docker is not installed/);
  assert.doesNotMatch(text, /Start Docker Desktop/);
  // Nor is the missing compose plugin raised as a separate problem when there
  // is no Docker for it to be a plugin of.
  assert.doesNotMatch(text, /not a docker command|Compose v2 is a CLI plugin/);
});

test("a stopped daemon on macOS names the app that is installed", () => {
  const text = render({
    docker: STOPPED,
    remedy: dockerRemedy(STOPPED, { platform: "darwin", macRuntimes: [DESKTOP] }),
  });
  assert.match(text, /is installed, but its daemon is not answering/);
  assert.match(text, /open -a Docker/);
});

test("a missing compose plugin is called out when Docker itself is fine", () => {
  const text = render({ compose: { present: false, version: null } });
  assert.match(text, /docker compose` is not available/);
});

test("the agent port warning explains the consequence, not just the conflict", () => {
  // A busy 2000 is not fatal — eve moves itself — but the dashboard keeps
  // pointing at 2000, and that is the part nobody works out on their own.
  const text = render({ ports: { ...GREEN.ports, agent: { wanted: 2000, busy: true } } });
  assert.match(text, /EVESTACK_AGENT_URL/);
});

test("no rendered line is wider than a terminal", () => {
  for (const [name, remedy] of [
    ["linux missing", dockerRemedy(MISSING, { platform: "linux" })],
    ["darwin missing", dockerRemedy(MISSING, { platform: "darwin", hasBrew: true, macRuntimes: [] })],
    ["wsl missing", dockerRemedy(MISSING, { platform: "linux", wsl: true })],
    ["denied", dockerRemedy(DENIED, { platform: "linux" })],
  ]) {
    for (const line of preflightLines({ ...GREEN, docker: MISSING, remedy })) {
      const width = line.replace(ANSI, "").length;
      assert.ok(width <= 80, `${name}: ${width} columns — ${line.replace(ANSI, "")}`);
    }
  }
});

test("wrapNote reflows prose and leaves deliberate indentation alone", () => {
  assert.deepEqual(wrapNote("one two three", 7), ["one two", "three"]);
  assert.deepEqual(wrapNote("  brew install --cask docker", 7), ["  brew install --cask docker"]);
  assert.deepEqual(wrapNote(""), [""]);
});

test("the disk check looks at the volume the project will land on", async () => {
  // The project directory does not exist yet, which is the point. Answering
  // "unknown" for every run would quietly disable the check.
  const root = nearestExisting("/definitely/not/here/at/all");
  assert.equal(root, "/");
  assert.equal(nearestExisting(process.cwd()), process.cwd());
  const bytes = await probeDisk("/definitely/not/here/at/all");
  assert.equal(typeof bytes, "number");
  assert.ok(bytes >= 0);
});
