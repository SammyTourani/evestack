/**
 * The sandbox egress policy is what the template says it is.
 *
 * `agent/sandbox/sandbox.ts` sets `networkPolicy: "deny-all"` and documents an
 * `EVESTACK_SANDBOX_NETWORK=allow-all` escape hatch. Nothing checked either
 * claim. The file compiles under both values and the registry copy is
 * byte-compared to it, but nothing ever started a container to see what the
 * shell can reach. A typo in the value, an eve release that stops honouring the
 * option, or a garbage-collected image digest would all ship green.
 *
 * This drives the real file through the real Docker backend on the path the
 * runtime uses for this template: no bootstrap(), no seeded
 * `sandbox/workspace/`, therefore `templateKey: null` — which starts the
 * container on the bridge and then disconnects it from every network.
 *
 * The allow-all case is the negative control, and it is the important half. On
 * a runner with no outbound network of its own the deny assertion passes for
 * entirely the wrong reason, and a probe that cannot tell "policy blocked it"
 * from "there was nothing to block" is measuring nothing.
 *
 * Loopback is asserted for the mirror-image reason: "deny-all broke the
 * sandbox" and "deny-all removed egress" are different outcomes, and the eve
 * docs build on the second one — spawn a server, talk to it over 127.0.0.1.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const runCli = promisify(execFile);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TEMPLATE = join(ROOT, "templates", "default");
const SANDBOX_MODULE = join(TEMPLATE, "agent", "sandbox", "sandbox.ts");

/** eve resolves its own Docker binary this way, so the probe agrees with it. */
const DOCKER_BIN = process.env.EVE_DOCKER_PATH ?? "docker";

/** A public host, reachable from CI, that is not a package registry. */
const CURL = 'curl -sS -m 20 -o /dev/null -w "http=%{http_code}" https://example.com';

/** Prints the two retry knobs the template sets under deny-all and only there. */
const READ_KNOBS = "echo npm:$npm_config_fetch_retries,pip:$PIP_RETRIES";

/** Never throws: a failed inspect should be reported, not crash the probe. */
async function inspectContainer(name) {
  const args = ["container", "inspect", "--format", "{{json .NetworkSettings.Networks}}", name];
  const done = await runCli(DOCKER_BIN, args, { encoding: "utf8" }).catch((error) => ({
    stdout: String(error.stdout ?? ""),
  }));
  return done.stdout.trim();
}

async function removeContainer(name) {
  await runCli(DOCKER_BIN, ["rm", "-f", name], { encoding: "utf8" }).catch(() => {});
}

/**
 * Opens one sandbox from the definition the template actually ships.
 *
 * `definition.backend` is re-invoked per call rather than resolved once,
 * because the factory reads process.env at the moment eve calls it and that
 * timing is part of what is under test.
 */
async function openSandbox(definition, policy, sessionKey) {
  const before = process.env.EVESTACK_SANDBOX_NETWORK;
  if (policy === null) delete process.env.EVESTACK_SANDBOX_NETWORK;
  else process.env.EVESTACK_SANDBOX_NETWORK = policy;
  const backend = typeof definition.backend === "function" ? definition.backend() : definition.backend;
  try {
    return await backend.create({
      runtimeContext: { appRoot: TEMPLATE },
      sessionKey,
      tags: {},
      templateKey: null,
    });
  } finally {
    if (before === undefined) delete process.env.EVESTACK_SANDBOX_NETWORK;
    else process.env.EVESTACK_SANDBOX_NETWORK = before;
  }
}

export default {
  id: "sandbox/deny-all-is-the-policy-that-ships",
  title: "the shipped sandbox really has no egress, and the escape hatch really opens it",
  needs: ["docker"],
  why:
    "agent/sandbox/sandbox.ts defaults the Docker sandbox to deny-all and advertises " +
    "EVESTACK_SANDBOX_NETWORK=allow-all as the way out. Both were documented, neither was ever " +
    "run. A deny-all that does not deny is a security claim the docs make and the stack does " +
    "not keep. An escape hatch that does not open leaves a scaffolded agent unable to fetch " +
    "anything at all, with no way to fix it.",

  async available() {
    if (!existsSync(SANDBOX_MODULE)) return [SANDBOX_MODULE + " is missing"];
    if (!existsSync(join(TEMPLATE, "node_modules", "eve"))) {
      return ["templates/default/node_modules/eve is missing - install the workspace first"];
    }
    try {
      await runCli(DOCKER_BIN, ["version", "--format", "{{.Server.Version}}"]);
    } catch (error) {
      return ["no reachable Docker daemon: " + error.message];
    }
    // The allow-all control needs somewhere to reach. A host that is itself
    // offline makes this probe unmeasurable rather than failing, and saying so
    // is honest where a red X would be a lie about the code.
    try {
      await fetch("https://example.com", { signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      return ["the host cannot reach https://example.com, so the allow-all control is unmeasurable"];
    }
    return [];
  },

  async run(t) {
    const definition = (await import(pathToFileURL(SANDBOX_MODULE).href)).default;
    const suffix = randomUUID().slice(0, 8);
    const denyKey = "probe-egress-deny-" + suffix;
    const allowKey = "probe-egress-allow-" + suffix;
    const handles = [];

    try {
      // The negative control, first. If this fails there is no outbound network
      // on this host at all and the deny half below proves nothing.
      const allow = await openSandbox(definition, "allow-all", allowKey);
      handles.push(allow);
      const allowCurl = await allow.session.run({ command: CURL });
      const reachable = allowCurl.stdout.includes("http=200");
      t.ok(reachable, "allow-all: the shell reaches the public internet", reachable ? {} : {
        expected: "http=200",
        actual: (allowCurl.stdout + allowCurl.stderr).trim(),
      });
      if (!reachable) t.note("every deny assertion below is unmeasurable on a host with no egress");

      // The shipped default.
      const deny = await openSandbox(definition, null, denyKey);
      handles.push(deny);

      const denyCurl = await deny.session.run({ command: CURL });
      const blocked = !denyCurl.stdout.includes("http=200");
      t.ok(blocked, "deny-all is the default: the shell cannot reach the public internet", blocked ? {} : {
        expected: "a failed request",
        actual: denyCurl.stdout.trim(),
      });

      const resolverFailed = /Could not resolve host/i.test(denyCurl.stderr);
      t.ok(resolverFailed, "deny-all: egress dies on DNS, the message troubleshooting.mdx documents", {
        actual: denyCurl.stderr.trim(),
      });

      const networks = await inspectContainer(denyKey);
      const detached = networks === "{}";
      t.ok(detached, "deny-all: the session container is attached to no Docker network", detached ? {} : {
        expected: "{}",
        actual: networks,
      });

      // Not a footnote. The eve docs build a whole pattern on spawning a server
      // in the sandbox, so deny-all has to cost egress and not networking.
      const loopback = await deny.session.run({
        command:
          "python3 -m http.server 8931 >/dev/null 2>&1 & sleep 1; " +
          'curl -sS -m 5 -o /dev/null -w "http=%{http_code}" http://127.0.0.1:8931/',
      });
      const loopbackWorks = loopback.stdout.includes("http=200");
      t.ok(loopbackWorks, "deny-all: loopback still works, so spawn-and-talk-to-it is unaffected", {
        actual: (loopback.stdout + loopback.stderr).trim(),
      });

      // The retry knobs, which the template sets under deny-all and only there.
      // Without them one npm install the model tries costs 70s of wall clock to
      // fail, and eve enforces no per-command timeout to cut it short.
      const denyKnobs = await deny.session.run({ command: READ_KNOBS });
      const knobsSet = denyKnobs.stdout.trim() === "npm:0,pip:0";
      t.ok(knobsSet, "deny-all: the npm and pip retry loops are switched off in the container env", {
        actual: denyKnobs.stdout.trim(),
      });

      const allowKnobs = await allow.session.run({ command: READ_KNOBS });
      const knobsUnset = allowKnobs.stdout.trim() === "npm:,pip:";
      t.ok(knobsUnset, "allow-all: those knobs are left alone, where a retry is the right answer", {
        actual: allowKnobs.stdout.trim(),
      });

      // The caveat every doc now carries. eve reuses one container per durable
      // session and never re-applies the policy, so flipping the variable does
      // not reach a session that already exists. .env.local, sandbox.ts and
      // troubleshooting.mdx all say "start a new session" because of this. If
      // eve ever fixes it, this check fails and that advice comes back out.
      const reattached = await openSandbox(definition, "allow-all", denyKey);
      handles.push(reattached);
      const reattachedCurl = await reattached.session.run({ command: CURL });
      const stillBlocked = !reattachedCurl.stdout.includes("http=200");
      t.ok(
        stillBlocked,
        "allow-all does not reach a session container that already exists - the documented caveat",
        stillBlocked ? {} : { actual: "egress opened on reattach, so the start-a-new-session advice is now wrong" },
      );
    } finally {
      for (const handle of handles) await handle.shutdown().catch(() => {});
      await removeContainer(denyKey);
      await removeContainer(allowKey);
    }
  },
};
