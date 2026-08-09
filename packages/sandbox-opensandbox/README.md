# @evestack/sandbox-opensandbox

Run an eve agent's sandbox on [Alibaba OpenSandbox](https://github.com/alibaba/OpenSandbox) —
Apache-2.0, self-hosted, and deployable on a gVisor / Kata / Firecracker runtime if your server
is configured for one.

eve ships four backends: `vercel()` (hosted, metered), `docker()`, `microsandbox()`, and
`justbash()`. This is a fifth, for when you want to run the sandbox host yourself on Apache-2.0
software instead of paying Vercel.

**Be precise about the isolation, because it is the reason people reach for OpenSandbox.** Which
runtime a sandbox lands on is decided by the OpenSandbox **server's** configuration, not by
anything this adapter sends: the client SDK (v0.1.11) has no runtime selector, and this adapter
therefore neither requests nor verifies one. It inherits whatever the server was configured with.
On the plain Docker runtime that is container namespaces — the same isolation `docker()` gives
you, without the server. **So do not pick this over `docker()` for untrusted code unless you have
independently confirmed your server runs a secure runtime**; nothing in this package can tell you
whether it does, and it was never tested against one (see [Status](#status)).

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

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `image` | `"ubuntu"` | Container image. Must contain bash — eve checks during setup. |
| `domain` | SDK default (`localhost:8080`) | OpenSandbox server host, with or without a scheme. |
| `apiKey` | SDK default (`OPEN_SANDBOX_API_KEY`) | API key for that server. |
| `timeoutSeconds` | server default | Idle lifetime. eve reattaches by id, so a short value is safe. |
| `networkPolicy` | server default (open) | Egress policy, fixed for the sandbox's life. See below. |

There is no `workingDirectory` option. 0.2.0 had one and it did nothing: it was handed to
`createDirectories` and then ignored, because paths and commands both hardcoded `/workspace`. It
is gone rather than wired up, because eve pins `/workspace` as the anchor for relative paths on
*every* backend, and moving it here would break the guarantee that lets one authored tool run on
Docker, Vercel and this. For a per-command directory, `run({ workingDirectory })` is eve's own
option and this adapter now reads it — 0.2.0 read a field named `cwd`, which eve never sends, so
every command ran in `/workspace` no matter what was asked for.

## How it behaves

- **Reattaches before creating.** eve keys sandboxes to durable sessions, so the sandbox id is
  persisted and reused. A server restart lands back in the same filesystem instead of silently
  handing the agent an empty one. If the sandbox was reaped upstream, a fresh one is created.
- **`shutdown()` pauses rather than kills.** eve reattaches on the next turn; killing would
  discard a `/workspace` the session still owns. It falls back to `kill()` if pause fails.
- **A null exit code is reported as failure**, not success — `137`, the conventional
  "killed" code. OpenSandbox reports no exit code when a command did not complete (a
  server-side timeout kill, an OOM, a stream that just ends), and telling the model a killed
  command succeeded is the worst available answer. Through 0.3.0 it *was* reported as `0`,
  despite this bullet: the coercion read `exitCode ?? (error ? 1 : 0)`.
- **`removePath` and `spawn` are implemented natively.** `removePath` refuses a non-empty
  directory unless you pass `recursive: true` (OpenSandbox's `deleteDirectories` has no
  non-recursive mode, so the check happens client-side) and refuses a missing path unless you
  pass `force: true`. `spawn` streams stdout and stderr as the server sends them, so a
  long-running process does not buffer its whole output first.
- **`kill()` kills the process, not the connection.** A spawned command is wrapped so it
  records its pid, and `kill()` runs a second command inside the sandbox that SIGKILLs that
  pid and every descendant — the same `/proc`-walking script eve's own `docker()` backend
  uses. Through 0.3.0 `kill()` only aborted the local SSE connection, which sends the server
  nothing at all; whether the command then died was up to execd. `wait()` after a successful
  `kill()` resolves with `137`, and a `kill()` whose request never reached the sandbox throws
  rather than reporting a termination that may not have happened.

  That first claim rests on an ordering it is easy to get backwards. The kill is a round trip and
  the server kills the process *before* it answers, so the spawned command's stream dies while
  `kill()` is still waiting on the response. The intent is therefore recorded before the request
  goes out, not after it comes back. Written the other way round — which is how it was first
  written — a kill that worked perfectly took the "the stream broke unexpectedly" path: `wait()`
  rejected with the stream's error and both output streams errored under any reader, the exact
  opposite of the sentence above. `test/adapter.test.mjs` pins it with a stub whose kill command
  ends the spawned stream before its own response lands.
- **`setNetworkPolicy()` throws** — see below. It is the one part of eve's session contract this
  backend cannot honour. A policy fixed at creation is supported, as `networkPolicy`.

### `prewarm`, `bootstrap()` and `seedFiles` are NOT supported, and now say so

`prewarm` captures nothing, and a sandbox that declares a `bootstrap()` hook or `seedFiles` is
**refused**: `create()` throws eve's `SandboxTemplateNotProvisionedError`.

That is a deliberate change from 0.2.0, which accepted the same sandbox, silently dropped both,
and started every session from a bare image while the build log said only "no template snapshot
captured; sessions start cold". The consequence was not a cold start — it was an agent whose
`bootstrap()` installed nothing and whose seed files were absent, with nothing anywhere saying
so. OpenSandbox does have snapshots (`createSnapshot` / `listSnapshots`, plus `snapshotId` on
create), so this is buildable; until it is built, refusing beats degrading.

If your sandbox has no `bootstrap()` and no seed files, eve never asks for a template and nothing
here changes.

### Network policy: fixed at creation, and `setNetworkPolicy()` throws

Every eve network policy implies a default action — `"deny-all"`, or an allow-list, which denies
everything it does not name. OpenSandbox fixes a sandbox's `defaultAction` when the sandbox is
created: the run-time egress API is `patchEgressRules` / `deleteEgressRules`, and its own docs say
the current default action is preserved. Patching an allow-list onto a sandbox whose default is
still *allow* would report success having restricted nothing — on the one call whose entire
purpose is to restrict. Per-domain `transform` header injection is not expressible either; that is
OpenSandbox's Credential Vault, a different model.

So `session.setNetworkPolicy()` rejects, the way eve's own `justbash()` backend rejects it. For a
policy that has to change mid-turn, use `vercel()` or `microsandbox()`.

A policy that holds for the sandbox's whole life *is* supported, because creation is where
OpenSandbox accepts one:

```ts
opensandbox({ networkPolicy: { allow: ["github.com", "*.npmjs.org"] } });
opensandbox({ networkPolicy: "deny-all" });
```

It is honoured completely or not at all. An allow-list becomes `defaultAction: "deny"` plus one
allow rule per domain; anything with no OpenSandbox equivalent — `subnets` (its egress model does
not support IP/CIDR) or a per-domain `transform` / `forwardURL` / `match` rule — **throws when the
backend is constructed** rather than being quietly dropped. A restriction that is half-applied is
worse than one that is refused.

Two consequences worth knowing:

- **Passing it pins a sandbox that still exists.** The policy is recorded with the sandbox id, and
  `create()` refuses to reattach to a sandbox that was created under a different one — that
  sandbox's egress cannot be changed to match, so reattaching would run the agent under the old
  policy while your source says otherwise. Changing the policy means starting a new session.

  Two limits on that refusal, both of which it was missing at first and both of which turned a
  guard into an outage. It is checked **after** the reconnect attempt and only for a sandbox that
  was actually recovered: a session whose sandbox has been reaped upstream has nothing to diverge
  from, and now gets a fresh one under the new policy instead of throwing on every turn for ever.
  And `allow-all` and no policy at all are the same egress — "passing an empty object or null
  results in allow-all behavior at startup", the SDK's own `NetworkPolicy` schema — so writing
  `networkPolicy: "allow-all"` down explicitly is a no-op, not something that detaches every live
  session. Only a real change of egress (to or from `deny-all` or an allow-list) refuses.
- **Misspelling it is an error, not a shrug.** `opensandbox()` rejects any option it does not
  implement. Before, `opensandbox({ initialNetworkPolicy: "deny-all" })` built a sandbox with
  wide-open egress and said nothing — and a caller who asked for a locked-down network and
  silently got an open one has no way to tell from the outside.

## Status

**Verified against a live OpenSandbox server** (`uvx opensandbox-server`, Docker runtime, v0.1.11
SDK): create, `run` with exit codes, text file read/write, `captureState`, `shutdown`, and
reattach-after-shutdown with the workspace intact.

Running it found two bugs that types alone could never have caught, both now fixed:

- **stdout lost every newline.** OpenSandbox returns one message *per line* with the newline
  stripped, so `printf "a\nb\nc\n"` arrived as `[{text:"a"},{text:"b"},{text:"c"}]` and the
  original join produced `"abc"`. Every multi-line command the model ran came back mashed
  together.
- **Reattach silently created a new sandbox.** `shutdown()` pauses, and `connect()` fails on a
  paused sandbox — so the adapter fell through to `create()` and handed the session a brand new,
  empty filesystem while reporting success. That is the worst kind of bug: a durability
  guarantee that looks fine and quietly is not. It now falls back to `resume()`, and the
  reattached id matches the captured one.

Then fixing the first one overshot: the separator was appended after the *last* line too, so
`printf %s x` returned `"x\n"` where eve's Docker backend returns `"x"`. Output now matches
Docker's on every interior newline, with one honest exception — a **trailing** newline is
unrecoverable, because it is stripped from every message, so `printf 'a\nb'` and `printf 'a\nb\n'`
arrive identically and both come back as `"a\nb"`. It is dropped rather than guessed at: guessing
wrong corrupts the short outputs, which are most of them. That is what `test/translate.test.mjs`
pins, along with `resolvePath`.

Three more were found by testing the session surface against a **stubbed** SDK — the adapter's
own code runs, only the wire is fake (`test/adapter.test.mjs`), which is how anything that needs a
sandbox became testable at all. Each is pinned by a case that fails on 0.3.0:

- **A command that never completed reported success.** `exitCodeOf` returned `0` for a null exit
  code whenever there was no error object, so a timed-out or OOM-killed command came back to the
  model as `exitCode: 0` — while this README said the opposite.
- **`kill()` killed nothing.** It called `AbortController.abort()` and made no further request to
  the sandbox at all, leaving termination to whatever execd does when a client hangs up; `wait()`
  then rejected with `AbortError` instead of reporting a terminated process.
- **A network-policy option was accepted and dropped.** `opensandbox({ initialNetworkPolicy:
  "deny-all" })` called `Sandbox.create` with `{"image":"ubuntu"}` and reported nothing. There was
  no `networkPolicy` option to spell correctly either; there is now, and an unknown option throws.

Two more were found by reviewing those fixes before any of them shipped, and are pinned the same
way. `kill()` recorded its intent *after* the round trip, so a successful kill made `wait()`
reject (see the `kill()` bullet above). And the new reattach guard ran before the reconnect ladder
and compared policy keys as raw strings, so a reaped sandbox plus a newly-added policy was a
permanently unusable session — `Sandbox.create` calls: 0 — and adding an explicit
`networkPolicy: "allow-all"`, which changes nothing about the sandbox, refused to reattach to
every session that existed.

Not exercised against a live server: gVisor / Kata / Firecracker isolation (the server reports
"secure runtime is not configured" under Docker Desktop on macOS, so all of the above was tested
on the plain Docker runtime), `spawn` and its `kill()`, the `networkPolicy` wire call,
`removePath`, and the stream / encoding / line-range variants of the read and write methods.
Those are written against eve's and OpenSandbox's declarations and covered by unit tests with a
stubbed SDK, not against a running server. In particular the kill path assumes a Linux `/proc`
and a `bash` in the image, the same assumption eve's `docker()` backend makes. Please open an
issue with what breaks.

## Build

```bash
pnpm --filter @evestack/sandbox-opensandbox build
pnpm --filter @evestack/sandbox-opensandbox typecheck
pnpm --filter @evestack/sandbox-opensandbox test
```

Apache-2.0.
