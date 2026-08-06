import { defineSandbox } from "eve/sandbox";
import { docker } from "eve/sandbox/docker";
import type { DockerSandboxNetworkPolicy } from "eve/sandbox/docker";

/**
 * The agent's isolated bash environment.
 *
 * Docker is the default because it runs anywhere and most people already have
 * it. eve keeps one long-lived container per durable session and persists
 * /workspace across turns, with no idle timeout — so this is genuinely free to
 * run 24/7 on your own machine.
 *
 * Swaps, one line each:
 *   microsandbox() — real VM isolation, domain-level network policy, and
 *                    credential brokering. macOS/Apple Silicon or Linux+KVM.
 *   justbash()     — no daemon at all, but simulated bash with no real binaries.
 *
 * What `docker()` will NOT do for you, so you plan for it elsewhere: it accepts
 * exactly `{ image, env, pullPolicy, networkPolicy }` (eve 0.30.8,
 * `DockerSandboxCreateOptions`) and builds its own `docker run` line — no
 * `--memory`, `--cpus`, `--pids-limit`, `--ulimit`, `--read-only`, `--cap-drop`
 * or `--user`. A sandbox command can therefore exhaust host RAM or fork-bomb
 * its container, and it runs as root inside it (the base image declares no
 * USER and eve's `docker exec` passes no `--user`). Cap that at the daemon —
 * Docker Desktop's resource sliders, or a daemon with cgroup defaults you set.
 *
 * There is no per-command timeout either: `run()` takes `{ command,
 * workingDirectory, env, abortSignal }` and nothing more, so a runaway command
 * ends when the turn is cancelled, not on a clock. Output is the one limit eve
 * does enforce — bash stdout/stderr is truncated to 2000 lines / 50 KiB /
 * 2000 chars per line before it reaches the model.
 */

/**
 * eve's published sandbox runtime image, pinned by digest instead of the
 * mutable `:latest` that `docker()` uses when `image` is omitted.
 *
 * `latest` moves under you. Resolved 2026-08-05 against the registry
 * (`GET ghcr.io/v2/vercel/eve/manifests/latest` → `docker-content-digest`), the
 * image behind it had been built two days earlier, on 2026-08-03. Nothing in
 * eve verifies what it pulls, and `pullPolicy` defaults to `"if-not-present"`,
 * so an unpinned install quietly keeps whatever `latest` meant on the day it
 * first ran and never looks again — the worst of both: unreproducible at
 * install, frozen afterwards. `vercel/eve` publishes no version tags at all
 * (only `latest`, `main`, and per-commit `sha-*`), so a digest is the only
 * stable reference on offer. This one is a multi-arch OCI index — linux/amd64
 * and linux/arm64 — so it resolves on both.
 *
 * Re-pin after upgrading eve, and read the diff rather than trusting the tag:
 *
 *   docker pull ghcr.io/vercel/eve:latest
 *   docker inspect --format '{{index .RepoDigests 0}}' ghcr.io/vercel/eve:latest
 *
 * `pullPolicy` is deliberately left at its default: a digest cannot move, so
 * `"always"` would re-pull identical bytes on every template build.
 */
const SANDBOX_IMAGE =
  "ghcr.io/vercel/eve@sha256:368c2b50ff5826c4b85e8080d3406e6b9f0a90fe6c4ec34f75472df8e3e25937";

/**
 * Egress for model-authored code.
 *
 * eve's documented default is `"allow-all"` (its `docs/sandbox.mdx`, "Network
 * policy"), which puts the container on Docker's default bridge: a shell the
 * model drives reaches your LAN, your router, a cloud instance's metadata
 * endpoint, and the internet. This template defaults to `"deny-all"` instead —
 * which is what eve's own docs prescribe for anything non-public, sensitive,
 * regulated, or in production.
 *
 * How it is enforced, because the mechanism is what decides the failure text:
 * this sandbox declares no `bootstrap()` and seeds no `sandbox/workspace/`
 * files, so eve opens the session with `templateKey: null` — and on that path it
 * starts the container on the bridge, runs its base setup, then runs
 * `docker network disconnect --force bridge <container>`. The container ends up
 * on no network at all: `lo` only, no default route. (`--network none` at
 * `docker run` time is the *other* path, taken only once a sandbox has a
 * bootstrap or seed files.) Either way `/etc/resolv.conf` keeps listing the
 * host's nameserver, so egress dies as a name-resolution failure rather than as
 * "network unreachable".
 *
 * Measured against the pinned image below, not predicted:
 *
 *   curl https://example.com  curl: (6) Could not resolve host: example.com
 *   git clone https://…       fatal: unable to access … Could not resolve host
 *   pip install requests      "Temporary failure in name resolution" x5, then
 *                             "No matching distribution found for requests"
 *   npm install lodash        getaddrinfo EAI_AGAIN registry.npmjs.org
 *   apt-get update            exits **0** with warnings, and the install after
 *                             it says "E: Unable to locate package X"
 *
 * Those last two are why this also has an entry in `docs/troubleshooting.mdx`:
 * pip and apt both finish on a sentence that reads like the package does not
 * exist, which is the wrong conclusion for a model to draw and act on.
 *
 * Loopback is untouched — `python3 -m http.server` and a `curl 127.0.0.1` at it
 * both work — and nothing structural is lost: model calls, Postgres, Composio
 * and every channel run in the app runtime, on the other side of the sandbox
 * boundary. What is lost is the shell's ability to fetch anything. A general
 * assistant may legitimately need that, so this is a default, not a prohibition:
 *
 *   EVESTACK_SANDBOX_NETWORK=allow-all
 *
 * That variable is read when a session's container is *created*, and eve keeps
 * one container per durable session with no idle timeout: `create()` returns
 * early on `docker container inspect` and never re-applies the policy, and the
 * `docker start` that follows a server restart brings the old policy back along
 * with the container. Setting the variable therefore does nothing for a
 * conversation you have already started, in either direction: an existing
 * session keeps the egress it was born with. Start a new session, or drop the
 * containers first:
 *
 *   docker rm -f $(docker ps -aq --filter label=eve.sandbox.role=session)
 *
 * There is no middle setting here — the Docker backend honors only these two
 * values, and domain allow-lists need `microsandbox()`. An authored tool that
 * needs egress for one step can call `sandbox.setNetworkPolicy("allow-all")` on
 * the live handle and put it back afterwards; that one does take effect on a
 * container that is already running.
 *
 * An unrecognized value is a hard error rather than a silent fall back to
 * either side, because "allow_all" and "none" are typos, not choices — and
 * guessing wrong here means either a broken shell or an open one.
 */
function resolveNetworkPolicy(): DockerSandboxNetworkPolicy {
  const configured = process.env.EVESTACK_SANDBOX_NETWORK?.trim();
  if (configured === undefined || configured === "") return "deny-all";
  if (configured === "allow-all" || configured === "deny-all") return configured;
  throw new Error(
    `EVESTACK_SANDBOX_NETWORK must be "deny-all" (default) or "allow-all", got "${configured}". ` +
      "The Docker sandbox backend supports no other values; domain allow-lists need microsandbox().",
  );
}

/**
 * Container environment, under `deny-all` only.
 *
 * Both of these turn off a fetch retry loop that cannot possibly succeed: the
 * container has no route, so every attempt fails identically, and eve enforces
 * no per-command timeout — the retries are dead time in front of a waiting
 * user. Measured on the pinned image, deny-all, same error text either way:
 *
 *   npm install lodash     70.1s  ->  0.10s   (npm_config_fetch_retries=0)
 *   pip install requests    7.7s  ->  0.15s   (PIP_RETRIES=0)
 *
 * Deliberately not set under `allow-all`, where retrying a flaky network is the
 * correct behaviour. `docker()` passes these as `-e` on `docker run`, and
 * `docker exec` inherits them, so every bash tool call sees them.
 */
function sandboxEnv(networkPolicy: DockerSandboxNetworkPolicy): Record<string, string> {
  if (networkPolicy !== "deny-all") return {};
  return { PIP_RETRIES: "0", npm_config_fetch_retries: "0" };
}

export default defineSandbox({
  // The factory form, not `docker({...})` directly: eve invokes it lazily on
  // first framework access and memoizes the result, which is what its docs
  // prescribe for create options read from the environment. Called eagerly at
  // module load, these would be resolved before eve has finished loading
  // .env/.env.local.
  backend: () => {
    const networkPolicy = resolveNetworkPolicy();
    return docker({
      env: sandboxEnv(networkPolicy),
      image: process.env.EVESTACK_SANDBOX_IMAGE?.trim() || SANDBOX_IMAGE,
      networkPolicy,
    });
  },
});
