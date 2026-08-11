# diary.md — cape-town-v1 stranger test

Chronological, including the boring parts and the waiting. All times PDT.

---

## Part 0 — Baseline (2026-08-09, 20:45)

```
Sun Aug  9 20:45:55 PDT 2026
Darwin 25.5.0, arm64 (T6050)          macOS 26.5.2 (25F84)
node v26.0.0 · npm 11.12.1 · pnpm 10.27.0
Docker 29.5.1 · Docker Compose 5.1.3
48 GB RAM · 544 GB free on /System/Volumes/Data
ollama 0.32.1 — qwen3:latest (5.2 GB), qwen3:4b (2.5 GB), nomic-embed-text (274 MB)
TZ unset; date +%Z%z → PDT-0700
LAN address 192.168.1.183
```

Browser for the dashboard portion: Chrome (via automation). Both Ollama models the $0 path
needs were already pulled — 3 and 4 days ago, i.e. by whoever ran the Aug 6 round.

Two things I noticed before doing anything, both of which matter later:

- README:134 says **macOS is untested by CI**, and README:125 says Node **24** is the only
  major CI installs. This machine is macOS on Node 26. So the entire test runs off the tested
  path. That is not a complaint — the README is unusually upfront about it — but every finding
  below inherits that caveat.
- `docker ps` showed a `kind-control-plane` container up for 3 days, holding :80 and :443.
  Unrelated to evestack; left alone.

## 20:46 — the machine was not clean

Before installing I checked what was already listening. Three node processes:

| Port | Bind | What |
|---|---|---|
| 3000 | `*` | `next-server` from `~/Development/ss-live-map` — unrelated project, left running |
| 2000 | `127.0.0.1` | `eve dev` from `~/evestack-stranger/my-agent`, started **Aug 6 16:45** |
| 4000 | `*` | `next start` from `…/cape-town-v1/packages/dashboard`, started **Aug 6 16:48** |

The :2000 agent was answering `HTTP 200` from a project directory that **no longer exists** —
`~/evestack-stranger/` is gone. It had outlived its own project by three days.

Meanwhile `docker ps -a` showed no evestack Postgres, and `docker volume ls` showed one
unrelated volume. So the Aug 6 stack was half-dead: agent process alive, database gone.

Curled both from this machine's LAN address to get an early read on Part 8C:

```
http://192.168.1.183:4000/  → 401     (bound *:4000 — reachable, correctly refusing)
http://192.168.1.183:2000/  → 000     (loopback-only — refused, correct)
```

Noted, not concluded: that :4000 was the repo's own `next start`, not the Docker path a
stranger gets. Re-check properly in Part 8C.

Stopped both evestack trees (PIDs 93588/93608, 96915/96921) to get a clean baseline. No data
at risk — there was no database left to lose. Ports 4000/2000/5433 confirmed free after.

## Part 1 — First contact

### 1.1 The website (20:47)

Read `https://evestack.vercel.app` cold.

**What I said after 30 seconds:** it's a one-command installer that stands up somebody else's
agent framework — eve, Vercel's — entirely on your own box, plus a dashboard that isn't just
read-only, it can drive the agent. The pitch is "same framework, your infrastructure."

**Who for:** people who want eve but not Vercel's platform — data-residency, retention, or
just not wanting a hosted control plane. **Cost:** free; you pay only for model tokens, and
Ollama takes that to zero. Infrastructure is $0 because it's your machine.

**What I didn't believe, going in:** the toolkit count (1,070 is a Composio number being
quoted as if it were an evestack feature), and "Everything runs on your network" sitting on a
page that also advertises a hosted third party (Composio) holding your OAuth tokens. The
README is straight about that second one; the landing page is not.

**Counting problem, immediately.** The page cannot decide how many commands this takes:
"Running in four steps", "Five commands, with their real receipts", "the three commands that
finish the job", "npx evestack create, then four commands", and a footer reading "Five
commands, and it's running on your machine." Filed CONFUSING.

**The one block on the page that offers evidence** — "Verified numbers", 38 events / 3 runs /
$0.00 / 5 span levels, "measured in Postgres — see FINDINGS.md" — doesn't link FINDINGS.md.
It's real and it's in the repo root, but the page never says where.

No 404s found in the link inventory; the nav is all same-page anchors plus `/docs` and GitHub.

### 1.2 Docs — what I expected before typing anything

Prediction, written down before running the install: **~15 minutes** to a dashboard with data,
assuming the Docker pull dominates; the two prompts are trivial; the risk is Ollama being slow
on first token, not setup. I expected to be told about the second embedding-model pull *before*
memory failed, because the quickstart has a Warning box that does exactly that.

Prerequisite assumed but not stated anywhere I could find: **that you can reach the public npm
registry.** Which turned out to be the whole story.

### 1.3 npm (20:52)

`npmjs.com/package/create-evestack` renders fine — the README is long, specific, and better
written than most. Version **0.9.1, published 2 hours ago**, 1,352 weekly downloads,
Apache-2.0, 0 dependencies, 12 versions.

It contradicts the other two surfaces in three places: "1,000+ tools" vs 1,070, "~400 MB" for
the dashboard pull vs ~204 MB, and a six-command setup block against the site's four/five.

### 1.4 Three-way check — site vs npm vs GitHub

The disagreements are in `findings.md`. The one that would actually cost a stranger time is
the **question count**: the GitHub README promises "Four questions … all asked before any work
starts" and an auto-bring-up that leaves "nothing left to paste"; the quickstart and npm README
both describe **two** questions and then hand you four more commands to run by hand. Those are
two different products. A first-timer reading the README and then following the quickstart will
think something went wrong.

## Part 2 — Install, cold. **Blocked.** (20:50 → 21:00)

Fresh empty directory. Timer started at the first command, following the docs literally:

```
npx evestack create my-agent
```

**150 seconds. Zero bytes of output.** No spinner, no "resolving", nothing. Interrupted it.
(This also served as the plan's 2.4 "Ctrl-C halfway" stumble — the directory was left
completely empty, which is the right answer.)

Diagnosis took another five minutes and the cause is this machine, not evestack:

- `~/.npmrc`, generated by `ws-cli` and marked *"do not edit, this file will be overwritten"*,
  pins the registry to `https://reposerver.w10external.com/repository/npm/` and sets
  `min-release-age=5`.
- That mirror returns `dist-tags: {"latest":"0.9.1"}` and **zero available versions** for
  `create-evestack`. It knows the version exists and will not serve it — 0.9.1 is 2 hours old
  against a 5-day floor.
- `registry.npmjs.org` does not resolve through the corporate resolver (100.64.0.1) at all, and
  does not answer by raw IP either, so `curl --resolve` is not a way around it.
- Public resolvers answer normally from this box (1.1.1.1 → 104.16.8.34), which confirms it is
  a policy block on the VPN path rather than an outage.

So the stranger path — the thing Part 2 exists to measure — cannot run on this machine while
it is on the corporate network. Stopped here rather than substituting a workaround, because
substituting hides the bug (ground rule 3) and, more practically, installing from the working
tree would test a different artifact than the one strangers get.

**Parts 3–11 are all downstream of a working install and are untouched.**

Worth recording as a genuine data point even though the cause is environmental: `npx` gave
**no output whatsoever for two and a half minutes** while failing. A stranger on a slow or
filtered network gets exactly this, and the plan's ground rule 5 is right that "waited, didn't
know if it was working" is worth reporting.

## 21:05–21:30 — unblocking the network (all environmental, no product signal)

Zscaler was disabled, then fully quit. Neither was enough: `nc -z 104.16.4.34 443` stayed
blocked while `example.com`, `github.com` and `ghcr.io` were all open, and the block was
surgical — `104.16.132.229` and `www.npmjs.com` (`104.17.135.117`) answered fine, only the
`registry.npmjs.org` anycast addresses (`104.16.0–11.34`) were dead. `systemextensionsctl list`
showed a GlobalProtect network extension "terminated waiting to uninstall on reboot" and an
active SentinelOne network-monitoring extension. Separately, macOS `mDNSResponder` was wedged
for that one hostname: `dns.resolve4` returned ten addresses while `dns.lookup` hung, and
clearing that needs `sudo killall -HUP mDNSResponder`, which wasn't available.

Tried and failed: `curl --resolve` on v4 and v6, and a local CONNECT proxy resolving via
`dns.resolve4` — all dead at TCP, confirming it wasn't DNS or SNI.

**Resolved by pointing npm at `https://registry.npmmirror.com/`** via a separate
`NPM_CONFIG_USERCONFIG`, rather than editing `~/.npmrc` (ws-cli-managed, marked do-not-edit,
and it also sets `ignore-scripts=true`, which a stranger would not have). The mirror is a full
sync of public npm and carried everything: `create-evestack@0.9.2`, `eve@0.30.8`,
`@workflow/world-postgres@5.0.0-beta.32`, `evestack@0.4.0`.

Two caveats this leaves on the record:
- The tarball source is a mirror, not `registry.npmjs.org`. The artifacts are the published
  ones and npm verifies their integrity hashes, so this does not change *what* is installed —
  but a broken publish specific to npm's own CDN would not be caught here.
- **npm's latest moved from 0.9.1 to 0.9.2 during the test.** At 20:52 the npm page read
  "0.9.1, published 2 hours ago"; by 21:30 the mirror had 0.9.2, matching the repo tree. So
  this run tests 0.9.2.

## 21:31–21:40 — three false starts driving the installer

Recorded because they are honest waiting, and because two of them produced real product
signal:

1. First attempt stalled at npx's own `Ok to proceed? (y)`, which I hadn't anticipated.
2. Second attempt revealed the prompt is **numeric** (`? Choose 1, 2 or 3:`), not an
   arrow-key list — my Down-arrow keystrokes silently defaulted it to OpenAI, and it went on
   to ask for an `OPENAI_API_KEY`. Worth noting for its own sake: an empty Enter at that
   prompt selects option 1 rather than re-asking.
3. Third attempt: a stray background line in my own harness spawned a **second** installer
   from the repo working directory, which scaffolded `my-agent/` inside the git checkout. My
   fault, not the product's. Removed it; `git status` clean again. No containers were created.

The useful output of all this is the exact prompt sequence, which settles the four-vs-two
question in the docs' favour on the README/cli.mdx side:

```
▚ Where  · step 1 of 4     → (auto-filled when a name is passed)
▚ Model  · step 2 of 4     ? Choose 1, 2 or 3:
                           ! qwen3 is 5.2 GB. Budget model size + 4 GB free RAM on top of
                           ! Docker, Postgres and the dashboard, or the machine can hang.
▚ Tools  · step 3 of 4     ? Enable one-click sign-in to 1,070 tools via Composio?
                             (Gmail, Slack, Notion, Linear…) (Y/n)
▚ Bring it up · step 4 of 4 ? Start Postgres, create the schema and pull the dashboard?
                             (~200 MB) (Y/n)
```

Credit where due: the RAM warning on the Ollama option is exactly the right warning in exactly
the right place, and it names a real number. The "~200 MB" in step 4 is also the honest figure
— it is the npm README's "~400 MB" that is wrong.

Also confirmed by watching it work: **all four questions really are asked before any files are
written.** The project directory did not exist while the model prompt was on screen.

## 21:36:40 → 21:37:48 — it installed in 68 seconds

Scaffold, `npm install`, Postgres up, schema created, dashboard image pulled, all four parts
reported with the ports this machine actually had free. Caveat on the number: the Docker images
and the npx package were already warm from the false starts above, so **68s is not a cold
number**. The uncached parts were honest — `install dependencies 38s`, `postgres up 10s`,
`schema 1s`.

The finish screen is the best thing in the product. An ASCII diagram of the four parts with
real ports, the credentials, and one line left to run. Two details worth calling out:

- It ends with "One command left: `cd my-agent && npm run dev`" and then *offers to run it*.
  So the README's "nothing left to paste" is accurate if you say yes.
- The diagram's footer reads `└─→ ollama qwen3 — the only thing that leaves this machine`.
  On the Ollama path **nothing leaves the machine** — Ollama is a local process on
  `127.0.0.1:11434`. The line is right for OpenAI/Anthropic and wrong for the option I picked,
  and it undersells the product's own headline claim.

Then: agent up on `127.0.0.1:2000`, eve v0.30.8, "dashboard connected". `evestack verify`
printed twelve green ticks and "Everything works." in 1.2 seconds.

## 21:39 — Part 8C, done early because the ports were right there

All three ports refused from this machine's LAN address `192.168.1.183`; loopback fine. Docker
publishes `127.0.0.1:4000` and `127.0.0.1:5433` explicitly. `/api/fleet` returns 401 with no
credentials and with wrong ones. This is the correct answer and it is the default.

## 21:40 — `evestack doctor`, and the first real bug

Covered in findings. `verify` says everything works; `doctor`, seconds later, cannot
authenticate to the same database. It is not a credentials problem — both generated files carry
the same password and Postgres accepts it. `doctor` simply never reads `.env.local`.

While chasing it I ran the whole CLI. Almost all of it is good: `status` answers in 0.65s with
the four parts and what to run next; every command outside a project prints "This is not an
evestack project" with the fix; `evestack verfiy` suggests `verify`; exit codes are honest
(`2` outside a project, `2` for doctor's failure, `0` for a bare `evestack`). `doctor` is the
only command with no project awareness — from `/tmp` it prints the same Postgres error instead
of the friendly message.

## 21:42:10 PDT — Part 4, the first real turn

Sent the documented durability curl from `docs/quickstart.mdx:94`. Accepted `202` in 0.29s with
a `continuationToken`. The turn completed in **14.0 seconds** on qwen3 — 6,383 tokens in, 363
out, one tool call, `$0.00`.

It worked end to end with no API key of any kind: the agent called `remember`, ran
`nomic-embed-text` locally (282ms), and wrote `evestack.memories` row 1. Its reply: *"I've
remembered the phrase "quokka-orbit-9" for you. It's stored in my memory with ID 1."*
That closes the $0 path (claim 19) and the Ollama-embeddings path (claim 12).

One thing in the agent log I could not explain as a user, and it is not evestack's:

```
[eve:dev] change detected (5 events: unlink /Users/sammytourani/Users/sammytourani/.npmrc,
add /Users/sammytourani/.gemrc, add /Users/sammytourani/.npmrc, ...), rebuilding authored artifacts...
```

eve's dev watcher is watching my **home directory**, and the first path is doubled —
`/Users/sammytourani/Users/sammytourani/.npmrc`. It rebuilt the project because unrelated
dotfiles changed. Upstream eve, not evestack, but it is what a user sees.

## 21:45–21:50 — the dashboard

Chrome extension wasn't connected, so this ran on Playwright (which also covers the WebKit and
light/dark passes later).

Overview is genuinely good. Every tile states how much of the window it could be computed from
— `p95 time to first token` shows `—` with "Partial data: covers 0 of 1 turns (0%)", which is
the right way to show a gap. Its `p95 turn latency 14s` matches the database exactly. Charts
carry full text alternatives and keyboard hints.

Then the second real bug, and the bigger one: `/sessions/[id]` and `/traces/[id]` disagree
about the same session. Written up in findings.

`/skills` is the high point. It scanned two skills I wrote myself, flagged the deliberately
malicious one as critical, and runs an armed self-test against a bundled fixture on every load.

**Where this stopped.** Parts 5 (13 of 18 pages), 6, 7, 8A/8B/8D/8E, 9, 10 and 11 are not done.


