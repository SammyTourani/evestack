# @evestack/sandbox-opensandbox

Run an eve agent's sandbox on [Alibaba OpenSandbox](https://github.com/alibaba/OpenSandbox) —
gVisor isolation, Apache-2.0, self-hosted.

eve ships four backends: `vercel()` (hosted, metered), `docker()`, `microsandbox()`, and
`justbash()`. This is a fifth, for when you want kernel-boundary isolation without paying
Vercel. OpenSandbox intercepts syscalls with gVisor rather than relying on container
namespaces alone.

**Use Docker unless you have a reason not to.** It needs no server, it is already the evestack
default, and it is sufficient for code you wrote. Reach for this when the agent executes code
you do not trust.

## Install

```bash
pnpm add @evestack/sandbox-opensandbox
```

```ts title="agent/sandbox/sandbox.ts"
import { defineSandbox } from "eve/sandbox";
import { opensandbox } from "@evestack/sandbox-opensandbox";

export default defineSandbox({
  backend: opensandbox({
    image: "ubuntu",
    domain: process.env.OPENSANDBOX_DOMAIN,
    apiKey: process.env.OPENSANDBOX_API_KEY,
  }),
});
```

You need a reachable OpenSandbox server. See its
[deployment docs](https://github.com/alibaba/OpenSandbox) for Docker and Kubernetes runtimes.

## How it behaves

- **Reattaches before creating.** eve keys sandboxes to durable sessions, so the sandbox id is
  persisted and reused. A server restart lands back in the same filesystem instead of silently
  handing the agent an empty one. If the sandbox was reaped upstream, a fresh one is created.
- **`shutdown()` pauses rather than kills.** eve reattaches on the next turn; killing would
  discard a `/workspace` the session still owns. It falls back to `kill()` if pause fails.
- **A null exit code is reported as failure**, not success. OpenSandbox returns `null` when a
  process is killed rather than exiting, and telling the model a killed command succeeded is
  the worst available answer.
- **`prewarm` captures nothing** and reports `reused: false`. OpenSandbox supports snapshots,
  but this version does not use them, so first use pays a cold start. Reporting honestly beats
  a build log claiming template state that was never captured.

## Status

The adapter is written against the real `@alibaba-group/opensandbox` SDK types (v0.1.11) and
typechecks against them, but **it has not been exercised against a live OpenSandbox server** —
the machine this was built on could not spare the memory to run one. Treat it as a starting
point rather than a proven path, and please open an issue with what breaks.

Apache-2.0.
