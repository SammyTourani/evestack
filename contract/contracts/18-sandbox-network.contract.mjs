/**
 * `networkPolicy: "deny-all"` must still isolate the container.
 *
 * templates/default/agent/sandbox/sandbox.ts overrides eve's default on purpose,
 * and its comment states the mechanism as a fact: *"This template defaults to
 * `deny-all` instead, which starts the container with `--network none`."* That is
 * the only thing standing between model-authored shell code and the LAN, the
 * router, a cloud instance's metadata endpoint and the internet — and nothing
 * checked it.
 *
 * It is the shape of failure the auth contract exists for, one layer down. eve's
 * own default is `allow-all`; the isolation comes from a single strict-equality
 * check on the string `"deny-all"` inside eve. Rename that value, move the field,
 * or reorder the argument construction upstream, and the flag is silently not
 * passed. Nothing throws. Nothing typechecks differently. The sandbox just
 * quietly has the network, and the template's stated default becomes a comment
 * describing something that no longer happens.
 *
 * ─ Why this drives the real function instead of grepping for a string ─
 *
 * eve ships minified. `grep '--network'` against dist would pass on a build where
 * the flag is constructed but unreachable, and would fail on a build that renamed
 * a local variable while behaving identically. So this imports the module that
 * builds the `docker run` argv and calls it with a fake Docker CLI that records
 * what it was asked to run. That is eve's real code path, and the assertion is on
 * what would actually reach Docker.
 *
 * It reaches past the exports map to do it, which is a cost worth naming: this
 * contract can break on an eve refactor that moved the file without changing any
 * behaviour. That is the correct trade here. A false red on an internal move is a
 * ten-minute update to this file; a false green on network isolation is a
 * sandbox with egress and nobody knowing.
 */
import { join } from "node:path";

/** The internal module that assembles the `docker run` argv. */
const CONTAINER_MODULE = "dist/src/execution/sandbox/bindings/docker-container.js";

/** Where eve resolves its own defaults for the Docker backend. */
const OPTIONS_MODULE = "dist/src/execution/sandbox/bindings/docker-options.js";

/** Records what it is told to run and reports success, so nothing touches Docker. */
function recordingCli() {
  const calls = [];
  return {
    calls,
    run: async (args) => {
      calls.push(args);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

function argvFor(startDockerContainer, cli, initialNetworkPolicy) {
  return startDockerContainer({
    containerName: `contract-${initialNetworkPolicy}`,
    role: "test",
    tags: {},
    image: "alpine:3",
    options: { env: {} },
    initialNetworkPolicy,
    cli,
  }).then(() => cli.calls[0] ?? []);
}

/** The value of `--network` in an argv, or null when the flag is absent. */
function networkFlag(argv) {
  const index = argv.indexOf("--network");
  return index >= 0 ? (argv[index + 1] ?? "") : null;
}

const denyAllIsolatesTheContainer = {
  id: "sandbox/deny-all-still-means-no-network",
  title: 'networkPolicy "deny-all" puts --network none on the docker run argv',
  assumption:
    'eve\'s Docker backend turns networkPolicy "deny-all" into `docker run --network none`, and passes ' +
    "no network flag for allow-all.",
  evestackUse:
    "templates/default/agent/sandbox/sandbox.ts sets deny-all as the default for every scaffolded agent, " +
    "against eve's own allow-all, and documents the --network none mechanism as the reason it is safe to " +
    "let a model drive a shell. If that mapping changes, model-authored code silently regains access to " +
    "the LAN, the router and a cloud instance's metadata endpoint. Nothing would error: the flag simply " +
    "would not be passed.",

  async check(eve, t) {
    const containerPath = join(eve.root, CONTAINER_MODULE);
    t.ok(
      eve.fileExists(CONTAINER_MODULE),
      `eve still ships ${CONTAINER_MODULE}, where the docker run argv is built`,
      eve.fileExists(CONTAINER_MODULE) ? {} : { actual: "not found — find where it moved to" },
    );
    if (!eve.fileExists(CONTAINER_MODULE)) return;

    const container = await import(containerPath);
    t.equal(
      typeof container.startDockerContainer,
      "function",
      "startDockerContainer is still the function that starts a sandbox container",
    );

    // The assertion the whole file exists for.
    const denied = await argvFor(container.startDockerContainer, recordingCli(), "deny-all");
    t.equal(networkFlag(denied), "none", 'deny-all passes --network none to docker run');

    // And its opposite, so this cannot pass on a build that hardcodes the flag
    // for everything — which would be a different bug wearing the same green tick.
    const allowed = await argvFor(container.startDockerContainer, recordingCli(), "allow-all");
    t.equal(
      networkFlag(allowed),
      null,
      "allow-all passes no network flag, leaving Docker's default bridge",
    );

    // `run` is what makes the argv a container start rather than an inspect.
    t.equal(denied[0], "run", "the recorded argv is a `docker run`");

    // eve's default being the permissive one is the reason the template overrides
    // it. If upstream ever flips to deny-all, that override stops being
    // load-bearing and the comment explaining it should change with it.
    const options = await import(join(eve.root, OPTIONS_MODULE));
    const resolved = options.resolveDockerSandboxOptions({});
    t.equal(
      resolved.networkPolicy,
      "allow-all",
      "eve's own default is still allow-all, which is why the template overrides it",
    );
  },
};

export default [denyAllIsolatesTheContainer];
