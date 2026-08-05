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

**Verified against a live OpenSandbox server** (`uvx opensandbox-server`, Docker runtime, v0.1.11
SDK): create, `run` with exit codes, text file read/write, `captureState`, `shutdown`, and
reattach-after-shutdown with the workspace intact.

Running it found two bugs that types alone could never have caught, both now fixed:

- **stdout lost every newline.** OpenSandbox returns one message *per line* with the newline
  stripped, so `printf "a\nb\nc\n"` arrived as `[{text:"a"},{text:"b"},{text:"c"}]` and the
  original join produced `"abc"`. Every multi-line command the model ran came back mashed
  together. Output now matches eve's Docker backend byte for byte.
- **Reattach silently created a new sandbox.** `shutdown()` pauses, and `connect()` fails on a
  paused sandbox — so the adapter fell through to `create()` and handed the session a brand new,
  empty filesystem while reporting success. That is the worst kind of bug: a durability
  guarantee that looks fine and quietly is not. It now falls back to `resume()`, and the
  reattached id matches the captured one.

Not yet exercised: gVisor / Kata / Firecracker isolation (the server reports "secure runtime is
not configured" under Docker Desktop on macOS, so this was tested on the plain Docker runtime),
`prewarm` snapshots, and network policy. Please open an issue with what breaks.

Apache-2.0.
