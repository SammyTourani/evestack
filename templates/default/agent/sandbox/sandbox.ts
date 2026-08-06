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
 * endpoint, and the internet. This template defaults to `"deny-all"` instead,
 * which starts the container with `--network none`.
 *
 * That costs the agent nothing structural — model calls, Postgres, Composio and
 * every channel run in the app runtime, on the other side of the sandbox
 * boundary. It costs the *shell*: `curl`, `git clone`, `pip install`,
 * `npm install` and `apt-get` all fail with no route. A general assistant may
 * legitimately need those, so this is a default, not a prohibition:
 *
 *   EVESTACK_SANDBOX_NETWORK=allow-all
 *
 * There is no middle setting here — the Docker backend honors only these two
 * values, and domain allow-lists need `microsandbox()`. An authored tool that
 * needs egress for one step can also call `sandbox.setNetworkPolicy("allow-all")`
 * on the live handle and put it back afterwards.
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

export default defineSandbox({
  // The factory form, not `docker({...})` directly: eve invokes it lazily on
  // first framework access and memoizes the result, which is what its docs
  // prescribe for create options read from the environment. Called eagerly at
  // module load, these two would be resolved before eve has finished loading
  // .env/.env.local.
  backend: () =>
    docker({
      image: process.env.EVESTACK_SANDBOX_IMAGE?.trim() || SANDBOX_IMAGE,
      networkPolicy: resolveNetworkPolicy(),
    }),
});
