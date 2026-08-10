# Running the agent as a service

`npm run dev` holds a terminal. Close the laptop and the agent stops, and nothing
brings it back. Postgres and the dashboard already restart themselves —
`docker-compose.yml` gives both `restart: unless-stopped` — so on a long-running
install the one component that does the work is the only one that dies.

Two files here fix that:

| File | Host | Install |
| --- | --- | --- |
| `evestack-agent.service` | Linux, systemd | `sudo cp` to `/etc/systemd/system/`, edit four lines, `systemctl enable --now evestack-agent` |
| `dev.evestack.agent.plist` | macOS, launchd | `cp` to `~/Library/LaunchAgents/`, edit the paths, `launchctl bootstrap gui/$(id -u) …` |

Each file carries its own step-by-step header and explains every non-obvious
setting inline. Read the one you need — they are short.

## Build first

A supervisor runs the **built** server, not `eve dev`:

```bash
npm run build          # eve build -> .output/
npm start              # what the unit and the plist run, by hand, once
```

Do that once by hand before you enable anything. A unit that fails at boot and a
build that never ran look identical from `systemctl status`.

## Why not a container

The obvious answer — add an `agent:` service to `docker-compose.yml` beside
Postgres and the dashboard — is the wrong one for this stack, for two reasons
that are both about what the agent actually does.

**The sandbox is the host's Docker daemon.** `agent/sandbox/sandbox.ts` uses
eve's `docker()` backend, which shells out to the `docker` CLI to create one
long-lived `eve-sbx-…` container per session. An agent inside a container can
only do that with `/var/run/docker.sock` mounted into it, and membership of that
socket is root on the host — granted to the one process in the system whose
shell commands are written by a language model. The sandbox exists to contain
that; handing it the daemon hands back everything it contained.

**There is no agent image.** Nothing publishes one, so a compose service would
need `build:`, and every deploy would build your project into an image before it
could start. The dashboard image is ~230 MB compressed and builds from the
repository root; doing that to the agent as well, on every restart, is a cost the
default should not impose.

systemd and launchd, by contrast, need nothing installed: the agent stays a
normal Node process on the host, with the Docker CLI on its PATH, exactly as it
is when you run `npm start` yourself.

## The two traps that only appear under a supervisor

**PATH.** npm puts `node_modules/.bin` on PATH; systemd and launchd do not. This
used to mean the agent refused to boot under a unit with *"eve is not installed
in this project"* on a project where it was installed perfectly well —
`scripts/start.mjs` now resolves `node_modules/.bin/eve` by absolute path, so
that one is fixed. The other half is not automatic: eve spawns the **`docker`**
CLI by name for every sandbox, and launchd's default PATH
(`/usr/bin:/bin:/usr/sbin:/sbin`) does not contain it on a Homebrew or Docker
Desktop Mac. The plist sets PATH for that reason; `EVE_DOCKER_PATH` names the
binary outright if you would rather.

The failure is partial, which makes it expensive: the agent boots, serves, answers
model calls, and fails every bash tool call with `DockerUnavailableError`.

**Log rotation.** systemd writes to the journal, which rotates itself. launchd
writes to whatever file you name and rotates **nothing** — the plist's header has
a ready-made `newsyslog.d` snippet. The containers are handled separately, in
`docker-compose.yml`'s `x-logging` block.

## Ordering

Postgres has to be accepting connections before the agent starts, but it does not
have to be up *first* — `scripts/start.mjs` is deliberately thin, exits fast, and
lets the restart policy retry. That is why the unit sets
`StartLimitIntervalSec=0`: the default rate limiter would give up after five
attempts and leave a `failed` unit waiting for a human, for a condition that
clears on its own in twenty seconds.

## Retention

`npm run db:prune` is the other half of leaving this running. Nothing prunes
eve's `workflow` schema, so runs, events and steps accumulate for as long as the
deployment lives. It is opt-in, dry-run by default, and documented in
`scripts/retention.mjs` and in the project docs under Operations. Do not put it
on a timer until you have run it by hand and read what it reports.
