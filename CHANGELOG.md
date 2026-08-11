# Changelog

Seven npm packages and one container image ship out of this repository, each
versioned independently, so this file is grouped by **package** rather than by
date. Within a package, newest first.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The
projects are pre-1.0 and follow [SemVer](https://semver.org/) with the pre-1.0
reading the repository has actually used: a behaviour change that could break
something scripting these commands is a **minor**, not a patch.

## How to read this file

- **Every `###` heading is exactly the git tag for that release** — `create-evestack@0.8.0`,
  `@evestack/mcp@0.2.0`. That is deliberate and load-bearing in two places: the string
  is also a valid `npm install` spec (`npm i create-evestack@0.8.0`), and
  `.github/workflows/publish-dashboard.yml` extracts release notes by matching the
  heading literally. See [RELEASING.md](RELEASING.md#tag-convention) for the convention
  and for the two tags that predate it.
- Most releases have **no tag** — a minority of the headings below have one. A heading is
  therefore the *name a tag would have*, not proof one exists. RELEASING.md lists the tags
  that exist, and `git tag` is the check that is never stale.
- **Dates are `America/Los_Angeles`**, the timezone every commit in this repository is
  stamped in. npm records its `time` field in UTC; those timestamps are converted here,
  so a date can be one day earlier than the value `npm view <pkg> time` prints.
- Commit hashes are given for anything a reader might want to check. `git show <hash>`;
  the commit messages in this repository are long and carry the measurements.

## How this was reconstructed

Written on 2026-08-09, after the fact, for six days of history that had no changelog.
It is derived, not remembered:

```bash
npm view create-evestack time            # the authoritative publish record
git log --oneline <bump>..<next-bump> -- packages/<dir>
git tag -l
```

Every version below is a version npm or GHCR actually serves, cross-checked against the
commit that moved the `version` field in that package's `package.json`. Where the
boundary between two versions cannot be established from the tree — no tag was cut, so
the only evidence is that a commit's timestamp falls before or after the registry's
publish timestamp — the entry says so instead of guessing.

Entries for 2026-08-04 are thinner than the ones that follow. That is the day the
repository was created (7548849, 04:24) and five of these packages were first written; the
commits are large, and which of them was inside a given tarball is not cleanly recoverable.
They are summarised rather than itemised, deliberately.

---

## Unreleased

**`@evestack/dashboard@0.4.0` is waiting to be published.** Its entry is written up in full
under its own section below; this is the pointer, because the pending state is the dangerous
one. The tree installs **spans v4** and **facts v2**, and the newest image GHCR serves is
`0.3.1`, which installs spans v3 and facts v1 — so until that image ships, the schema work
is unreachable for every user, and anyone reading a version number alone cannot tell the two
schemas apart. That is the condition the bump ends and the publish completes.

The five packages that were queued here — the scaffolder, the CLI, `@evestack/mcp`,
`@evestack/budget` and `@evestack/sandbox-opensandbox` — went to npm on 2026-08-09 and their
entries have moved down into their own sections; the dashboard image followed at `0.3.0`,
then `0.3.1`.

What remains below ships in no artifact. It is recorded because the *symptom* reached
users even though the code never did — the state this section exists to make visible,
since a package whose version matches the registry while its code does not is the one
condition every check in RELEASING.md reports as green.

### Changed but not yet versioned

- **`contract/`** — 1b63559 and 06274c4 repaired a probe that was writing rows eve's
  `WorkflowRunSchema` rejects, which bricked a development database for four days.
  Ships in no published artifact; recorded here because the *symptom* reached users as
  "the database that would not boot", and docs/troubleshooting.mdx carries the repair.

---

## `create-evestack`

The `npm create` entry point. Carries `templates/default` inside it, so a change to the
template ships as a change to this package.

### create-evestack@0.9.2 — 2026-08-09

#### Changed

- The scaffolded compose file pins `ghcr.io/sammytourani/evestack-dashboard:0.3.1`, up
  from `:0.3.0`. `:0.3.0` stays pullable, but a project scaffolded on it answers **502 on
  every new chat** against an eve 0.31.x agent — that is the fix `0.3.1` carries, so this
  bump is the one that puts it in front of new projects.

> **The third of these in one day**, and the pattern is the point rather than the
> incident: `0.9.0` pinned `:0.2.0` and went stale within the hour, `0.9.1` pinned `:0.3.0`
> and went stale within two. The scaffolder pins a tag deliberately — pinning `latest`
> would hand new projects an untested pairing — and the cost of that choice is a bump
> every time the image moves. `publish-dashboard.yml`'s version job is what makes the cost
> visible instead of silent: it refuses to build while the two disagree.

### create-evestack@0.9.1 — 2026-08-09

#### Changed

- The scaffolded compose file pins `ghcr.io/sammytourani/evestack-dashboard:0.3.0`, up
  from `:0.2.0`. `:0.2.0` is not withdrawn and stays pullable.

#### Fixed

- `npm run verify` told an operator whose dashboard reports no version that it was "at
  least as old as 0.2.0". The `version` field on `/api/health` was added in `3d318ce`,
  which shipped in the **0.3.0** image — so an image without it is older than 0.3.0, and
  0.2.0 was the newest release that could still be missing the field rather than the
  oldest. Off by one release, in the direction that made a stale image sound newer.

> **Why this exists at all.** `0.9.0` was published an hour before the dashboard was cut
> at `0.3.0`, so it pins `:0.2.0` — correct when published, stale within the hour.
> `publish-dashboard.yml`'s version job caught it and refused to build: "Every scaffolded
> project would pull a tag this release does not publish." The gate stopped the release
> rather than shipping a mismatch, which is the whole reason it counts written-out tags
> instead of trusting one.

### create-evestack@0.9.0 — 2026-08-09

#### Added

- The generated `docker-compose.yml` bind-mounts the project's own `skills/` directory
  into the dashboard and sets `EVESTACK_SKILLS_DIR` (30b4de4). Without it the dashboard's
  Skills page scanned the image's own bundled skill instead of yours — so it always
  showed the same one entry, on every install.
- `npm run verify` in a generated project asks the running dashboard what version it is
  (`/api/health`) and compares it against the tag the project's own compose file pins
  (f76a0d1). Warn, never fail: running a newer or locally built image is legitimate.

#### Changed

- The scaffolded compose file pins `ghcr.io/sammytourani/evestack-dashboard:0.2.0`
  (751ac5c), up from `:0.1.0`. `:0.1.0` is not withdrawn and stays pullable.

#### Fixed

- `evestack attach` read a CRLF `.env.local` as **empty** and therefore added a second
  Postgres to a project that already had one, splitting session history across two
  databases with neither half complete (a693659). `readEnvFiles` split on `"\n"` and
  matched with a `$`-anchored regex without the `m` flag; measured, 0 of 2 lines parsed
  on CRLF against 2 of 2 on LF. A `.env` written on Windows, or checked out with
  `core.autocrlf=true`, was enough.
- A generated project missing `db:bootstrap` reported "workflow tables created" anyway
  (83af3bb).
- The canary the env-name contract looked for was an `EVESTACK_`-prefixed name that
  nothing sets (fc5dea7).

### create-evestack@0.8.0 — 2026-08-09

> **Upgrade note — historical.** `0.8.0` was published at 00:30 and 30b4de4 landed at
> 00:43 — twelve minutes and forty-six seconds later. Every project scaffolded from npm
> in the ten hours `0.8.0` was `latest` therefore has a compose file with **no skills
> bind-mount** (the dashboard's Skills page scans the image's own bundled skill) and pins
> the dashboard at `:0.1.0`. Both were fixed in `0.9.0`, published the same day at 10:54;
> npm has served a fixed version since. This still applies to a project already scaffolded
> from `0.8.0` — a project is a copy, so re-scaffolding is what picks the fix up. Confirmed
> at the time by running the published package into a clean directory and reading the
> compose file it wrote (af49a2a).

#### Changed

- Terminal output: colour is decided once, from whether stdout is a TTY, instead of by
  three separate colour tables that never asked (f420897).

#### Fixed

- The npm README still told people the dashboard image does not exist (d4ea07e).
- A flag that gated nothing, and the reason the env-name contract could not see it
  (c023c45).
- `db:bootstrap` treated an absent `.env.local` as an error rather than as a
  configuration (f758fbe).
- The two commands people mistype now explain themselves, and the first run stops
  guessing ports (b39d6d7, 8fd73d3).

### create-evestack@0.7.0 — 2026-08-06

#### Security

- The generated Postgres password was written into a file that was then committed to git
  (2789517).

#### Fixed

- `--help` wrote files (2789517).
- `npx create-evestack` answered a wrong directory with a stack trace (bb4293c).
- A built agent listened on a port nothing was looking at (83c5999).
- The branch that explains a hallucinated memory id was the one that threw (a7c78a6).
- A failed heartbeat could not be recorded as failed, and a disabled one still ran hourly
  (8eb17e5).
- Five defects found by re-verifying the whole stack, one of which kills the agent
  (bc36a4a).
- The heartbeat's two advertised selling points were not implemented, in four documents
  (2d03a6a).

#### Changed

- The first run works, and explains itself (659d9cf).

#### Removed

- Unreachable release-toggle branches (a97354f).

### create-evestack@0.6.0 — 2026-08-06

#### Security

- The agent's database was published to the network with a known password (e2fb418).

#### Changed

- One command. The dashboard is **pulled** from GHCR instead of built locally
  (bbdc68e) — the change that removed the biggest piece of setup friction in the project,
  and the reason `publish-dashboard.yml` exists.
- The scaffolder stopped apologising for a dashboard image that is now published
  (f2f0d48).

#### Fixed

- Prerelease users were told `0.30.1-beta.1` is newer than `0.30.2` (c795283).

### create-evestack@0.5.0 — 2026-08-05

Tagged `create-evestack@0.5.0`, and the [GitHub release][r050] carries the longest-form
account of what changed here. It sat as an unpublished draft from 2026-08-06 until it was
published on 2026-08-09 — visible to nobody but the maintainer for three days, which
RELEASING.md calls the worst of the three states a release can be in.

[r050]: https://github.com/SammyTourani/evestack/releases/tag/create-evestack%400.5.0

#### Security

- Sandbox egress is denied by default and the sandbox image is pinned (f21a399).

#### Fixed

- The tool-approval middleware was rewritten for `@ai-sdk/provider` 4.0.5, under which a
  denial carries `providerOptions.openai.approvalId` — the old rewrite dropped it
  (f21a399).
- **Every span the generated project exported was silently dropped.** The exporter sent
  no credential, so every span 401'd — and `@vercel/otel`'s fetch-based exporter treats a
  401 as a resolved promise, reports success to the batch processor and drops the batch.
  A misconfigured token was indistinguishable from "no traces yet". The template now
  sends the shared secret and probes once at boot, so a refused credential says which
  side is wrong (9f46b69).
- The wizard offered "OpenAI or Anthropic" and implemented only OpenAI. All three
  providers are now real choices that write their own key variable (9f46b69).

#### Changed

- One hero line, the same sentence on all four surfaces (ef40b13, 893cac8).

### create-evestack@0.4.0 — 2026-08-05

Tagged `create-evestack@0.4.0`.

#### Fixed

- **The advertised $0 local-model path never booted.** Choosing "Ollama (local)" wrote
  `EVESTACK_MODEL=qwen3` and a comment saying no API key was needed, but never
  `EVESTACK_PROVIDER=ollama`. The agent defaults the provider to `openai`, so the model
  name went to the wrong provider and the agent died before serving a request (7ba9dd3).
- **Every project claimed the compose project name `evestack`**, so a second scaffold —
  or a scaffold beside the cloned repo, which the printed next steps tell you to set up —
  was the *same* Compose project, and two agents shared one database. The name now
  derives from the project directory (7ba9dd3).
- A fresh install reported five npm advisories; now zero (f409414). All five were
  `undici`, reached two ways: `@workflow/world-local` exact-pins 7.28.0 (lifted by a
  narrow nested override), and `@ai-sdk/openai` was pinned `^2.0.0`, two majors behind
  the SDK it plugs into — `^4.0.0` matches `ai@7`, so this is a correctness fix as much
  as a security one.
- The `anthropic` provider the agent already imports is now declared (ba280ea).

#### Added

- The RAM warning for local models appears in the wizard, not only in the README
  (f409414). Loading a 5.2 GB model on top of Docker, Postgres, the dashboard and the
  agent does not degrade gracefully.

### create-evestack@0.3.1 — 2026-08-04

#### Fixed

- eve 0.30.6: survive the denial that killed every session (f771d5b).
- A Slack bug that structure could not catch, found while packaging the Slack, Discord
  and Telegram channels (49d56b4).

### create-evestack@0.3.0 — 2026-08-04

#### Added

- The eve contract suite, and `@evestack/budget` as a template dependency (30c296d).

### create-evestack@0.2.0 — 2026-08-04

#### Changed

- eve 0.30.2, and the auth patch it made obsolete is gone (eb0eaee).
- Ships what `0.1.1` was bumped for but never published: a gated tool with approvals that
  actually render (8f66c20), and telling scaffolded users the dashboard exists (5eba712).

### create-evestack@0.1.1 — never published

Bumped in 4967594 at 12:42 and superseded by `0.2.0` ten minutes later. npm has no such
version; it is listed only so the gap between git and the registry is not read as a
missing entry.

### create-evestack@0.1.0 — 2026-08-04

First working scaffolder (82ed0f1). Also in this window, by timestamp against the
registry's 11:19 publish: Composio wired into the agent and UTC timestamp parsing fixed
(22d41e2), the smoke/sandbox/memory eval suite (45c79a8), never selecting a local model
implicitly plus two real Ollama bugs (178fc93), and a pre-publish QA pass that closed an
auth bypass and every packaging defect found (35f739a).

The split between this version and `0.1.1` is inferred from commit timestamps either side
of the registry's publish time. No tag was cut, so it cannot be established exactly.

### create-evestack@0.0.1 — 2026-08-04

A name reservation, published at 05:32 within three seconds of `evestack@0.0.1`. It does
not correspond to any commit in this repository. Do not install it.

---

## `evestack`

The CLI — `create`, `status`, `tour`, `open`, `verify`, `attach`, `doctor`. Depends on
`create-evestack`, so it publishes last.

### evestack@0.4.0 — 2026-08-09

#### Changed

- `evestack tour` no longer treats silence as consent. Off a TTY it exits 3 instead of
  sending a billable model call (920a439). This is a **behaviour change for anything
  scripting it**, which is why the bump is minor rather than patch.

#### Fixed

- The four output defects the `0.3.0` redesign left behind — the stderr colour fix and
  two `--json` defects among them — and `evestack status` against a scheme-less dashboard
  URL (920a439).
- The npm README advertised three of seven commands — it predated the redesign that
  added `status` and `tour`, so the two commands that redesign was built around were
  invisible on the page most people land on first (920a439).

### evestack@0.3.0 — 2026-08-09

> **Upgrade note — superseded.** npm serves `0.4.0`. This version predates the `tour`
> consent gate: off a TTY, `evestack tour` treated silence as a yes and sent a billable
> model call. Fixed in `0.4.0`, published the same day at 10:54 (af49a2a) — so this
> applies only if something is pinned to `0.3.0`.

#### Changed

- Terminal output honours whether stdout is a TTY (f420897).

#### Fixed

- `evestack doctor` called finished conversations wedged (67f044f).

### evestack@0.2.0 — 2026-08-06

#### Fixed

- Carries the same `0.7.0`-era fixes as the scaffolder it wraps: the committed Postgres
  password and `--help` writing files (2789517), five stack-verification defects
  (bc36a4a), and a first run that works and explains itself (659d9cf).

### evestack@0.1.0 — 2026-08-06

First real CLI: `evestack doctor`, which explains why a durable job is dead (489874a),
and the one-command path in which the dashboard is pulled rather than built (bbdc68e).

### evestack@0.0.1 — 2026-08-04

A 196-byte name reservation with no `bin` field, published at 05:32 within three seconds
of `create-evestack@0.0.1`. It predates every line of `packages/evestack-cli`, whose
first commit is 489874a on 2026-08-05. Do not install it; `npx evestack` resolved to this
until `0.1.0` landed.

---

## `@evestack/mcp`

The MCP server. Standalone — nothing else published names it, so it can go out at any
point in the release order.

### @evestack/mcp@0.3.0 — 2026-08-09

Cut as a minor, not the patch this was first queued as. It was a patch while the change
was README-only; the output cap below is a new feature with a new environment variable and
a behavioural change to every tool result, and shipping that as `0.2.1` would tell every
consumer's version range it was safe to take without reading anything.

#### Added

- **A cap on how much one tool result can put in a model's context**, default 64 KiB
  (~16k tokens), configurable through `EVESTACK_MCP_MAX_OUTPUT_BYTES`. Before it, the size
  of a tool result was a property of how much history the deployment had rather than of
  anything this server decided: `list_approvals` against a busy install measured 113,289 B
  (~28k tokens) with no arguments at all. Results are never silently shortened — the
  payload stays valid JSON, `_truncated` is the first key so a model reading top-down meets
  it before the data, and `cuts` names every array and string that lost content. A
  truncated audit log mistaken for a complete one answers "who approved this?" with
  "nobody did".

#### Fixed

- The README — which is the npmjs.com page — said `list_approvals` "does not exist yet".
  The route was added in 5c49f3a on 2026-08-05, four days before that sentence shipped
  (920a439).

### @evestack/mcp@0.2.0 — 2026-08-06

#### Added

- A `test` script. The package had none, so `pnpm -r test` skipped it **entirely** —
  including a hand-rolled JSON-RPC framer, a hand-rolled schema validator, and the
  read-only tool gate the README leads with. 54 tests (b0fcf07).

#### Fixed

- The server pointed at a route that no longer carries the data (e83fbc1).
- `#initialized` is enforced in the handshake rather than ignored — the client name
  arrives there and becomes the User-Agent recorded against an approval (b0fcf07).
- The README documented `/api/health`; the server reads `/api/health/detail` (b0fcf07).

### @evestack/mcp@0.1.0 — 2026-08-05

First release (51d2b85), alongside the fix to the trace tier that had never worked.

---

## `@evestack/budget`

Spend caps. A **template dependency** — it must exist on npm before `create-evestack`
does.

### @evestack/budget@0.2.1 — 2026-08-09

#### Fixed

- **The spend cap undercharged every cache write.** `costUsd()` takes five arguments —
  `(model, input, output, cacheRead, cacheWrite)` — and `hook.ts` called it with four, so
  `cacheWriteTokens` fell to its `= 0` default on every step and a write was billed at the
  plain input rate (b9a00a7). eve reports the number and `pricing.ts` has always accepted
  it; only the call site dropped it. Cache reads and writes are *parts* of `inputTokens`
  rather than additions to it, so the miss is the gap between two rates, not a whole extra
  charge. Measured against the shipped catalog on 1M input tokens of which 400k were cache
  writes: `anthropic/claude-sonnet-5` charged $2.000 against a correct $2.200 (−10%);
  `openai/gpt-5-mini` charged $0.250 against a correct $0.250 (no difference), because it
  publishes no separate write rate and `pricing.ts` falls back to the input rate. So the
  bug undercharges on Anthropic and is a no-op on the default provider, which is why it
  survived. Cost is what the cap is measured against, so an Anthropic prompt-caching
  workload passed its limit before anything tripped.

  Patch rather than minor: no surface moved and nothing scripting this package sees a
  different shape — the only behaviour change is that a cap now trips where it should
  always have. Pinned by a source-text assertion, because the hook needs Postgres and a
  live session to run and a four-argument call is exactly the shape that regressed.

  Still not fixed: `budget_steps` has no `cache_write_tokens` column, so the count is not
  stored per step — only its **cost** is now correct. Adding the column means a migration
  against tables created with `CREATE TABLE IF NOT EXISTS`, which is more than this bug
  needs.

### @evestack/budget@0.2.0 — 2026-08-06

> **Upgrade note — superseded.** npm serves `0.2.1`; this is no longer what a fresh
> install gets. `0.2.0` undercharges every cache write: `hook.ts` calls `costUsd()` with
> four of its five arguments, so an Anthropic prompt-caching workload is billed about 10%
> under and passes its cap before anything trips. OpenAI models are unaffected. Fixed in
> `0.2.1`, published 2026-08-09 (b9a00a7). Still live in any project whose lockfile still
> resolves `@evestack/budget` to `0.2.0`; the template's range is a caret, so an install
> that is allowed to move the lockfile picks the fix up on its own.

#### Fixed

- **The cap could never trip on the documented Anthropic setup.** `config.ts` resolved an
  unset model to `gpt-5-mini` regardless of provider, so `EVESTACK_PROVIDER=anthropic`
  with the model unset — exactly what `.env.example` documents — asked for
  `anthropic/gpt-5-mini`, which is in no pricing table. `findPrice` returned null, cost
  was 0, and the $2 session and $10 daily caps could never fire. With the fail-closed
  value `.env.example` recommends (`=stop`), the opposite: the first step is marked
  exceeded and no turn can ever complete (028c3f8).
- **A typo'd timezone failed every turn.** `EVESTACK_BUDGET_TIMEZONE` was read with no
  trim and no validation, and the day key was computed *outside* the `try` guarding
  `recordStep`, so a `RangeError` escaped the hook — and eve treats a thrown hook as a
  real turn failure. Verified throwing on `""`, `"UTC "` (a trailing space from `.env` or
  compose), `"GMT+2"` and `"America/Torono"` (028c3f8).
- Two defects from the whole-stack re-verification, one of which kills the agent
  (bc36a4a), and the first test coverage for the spend cap (37e7f11).

#### Changed

- eve 0.30.6 → 0.30.8 (b0936a2).

### @evestack/budget@0.1.0 — 2026-08-04

First release, with the eve contract suite (30c296d).

---

## `@evestack/composio`

Composio tool access. A **template dependency**.

### @evestack/composio@0.2.0 — 2026-08-06

#### Added

- A `test` script — the package had none, so `pnpm -r test` skipped it entirely. 20 tests
  (b0fcf07).
- `src/resolver.ts`: the session-selection logic (no key / the live one / nothing while a
  failure cools off) split out of the closure that was handed straight to
  `defineComposioTools`, where the only way to reach it was a real Composio handshake
  (b0fcf07).

#### Changed

- eve 0.30.6 → 0.30.8 (b0936a2).

#### Removed

- The dead `COMPOSIO_EXECUTE_TOOL` slug (b0fcf07).

### @evestack/composio@0.1.1 — 2026-08-04

#### Fixed

- eve 0.30.6, and the denial that killed every session (f771d5b).

### @evestack/composio@0.1.0 — 2026-08-04

First release (ac6d4da), published one minute before `create-evestack@0.1.0` — the
dependency order this repository has followed since.

---

## `@evestack/schedules`

Cron schedules and the heartbeat. A **template dependency**.

### @evestack/schedules@0.2.0 — 2026-08-06

#### Fixed

- A cron written in capitals stopped the agent booting, and `describeCron` still
  over-reported (6b79571).
- The Schedules page could report a schedule running 1,440× more often than it does
  (6338e3f).
- Run duration recorded the seconds field twice instead of the elapsed time (0241ccd).
- The heartbeat's two advertised selling points were not implemented, in four documents
  (2d03a6a).

#### Changed

- eve 0.30.6 → 0.30.8 (b0936a2).

### @evestack/schedules@0.1.0 — 2026-08-05

First release, out of the work that added schedules, skills, fleet health and attach
(3b708c6).

---

## `@evestack/sandbox-opensandbox`

The OpenSandbox backend adapter. Standalone.

### @evestack/sandbox-opensandbox@0.4.0 — 2026-08-09

Three defects found by testing the session surface against a **stubbed** SDK, and two more
found by reviewing those fixes before they shipped. `test/adapter.test.mjs` is what made
any of it visible: everything in `index.ts` needs a live OpenSandbox server to run, so none
of it could be pinned by a test until the wire was faked. Each fix below is pinned by a
case that fails on `0.3.0`.

Unlike every other entry in this file, this one carries **no commit hashes — the work is
uncommitted in this checkout**, in `src/index.ts`, `src/translate.ts`, `README.md`,
`test/translate.test.mjs` and a new `test/adapter.test.mjs`. Commit before publishing:
`npm publish ./packages/sandbox-opensandbox` packs the working tree, so otherwise `0.4.0`
on npm is a version that exists in no commit and these bullets cite nothing checkable.

#### Added

- **`networkPolicy` on the backend.** OpenSandbox fixes a sandbox's `defaultAction` when
  the sandbox is created — that is why `session.setNetworkPolicy()` still rejects — so
  creation is the only point at which a policy can be honoured, and now it is:
  `opensandbox({ networkPolicy: "deny-all" })` or an allow-list, translated to
  OpenSandbox's `{defaultAction, egress}` model and passed to `Sandbox.create`. Honoured
  completely or not at all — `subnets` (its egress model has no IP/CIDR) and per-domain
  `transform` / `forwardURL` / `match` rules **throw when the backend is constructed**
  rather than being dropped, because a restriction that is half-applied reports success
  with the hole still open.
- The policy is recorded alongside the sandbox id, and `create()` refuses to reattach to a
  sandbox created under different egress: that sandbox's rules cannot be changed to match,
  so reattaching would run the agent under the old policy while the operator reads the new
  one in their source. Two limits on that refusal, both of which it lacked at first and
  both of which turned a guard into an outage — it is checked *after* the reconnect ladder
  and only for a sandbox actually recovered (a session whose sandbox was reaped upstream
  has nothing to diverge from, and now gets a fresh one under the new policy instead of
  throwing on every turn for ever: reproduced against the earlier build as `create() THREW
  ... Sandbox.create calls: 0`), and `allow-all` compares equal to no policy at all, since
  the SDK's own schema says an empty or null policy is allow-all at startup. Writing
  `networkPolicy: "allow-all"` down explicitly is a no-op, not something that detaches
  every live session.
- `test/adapter.test.mjs`, the stubbed-SDK harness described above.

#### Changed

- **Breaking:** `opensandbox()` now **throws on any option it does not implement**
  (`assertKnownOptions`), where `0.3.0` accepted and ignored it. TypeScript's
  excess-property check catches `opensandbox({ typo: 1 })` written as an object literal
  and catches nothing else, so **an untyped JavaScript caller, a spread
  (`opensandbox({ ...config })`), or a config loaded from JSON that was passing extra keys
  silently will now fail at construction** — that is the compatibility break in this
  release, and it has no other announcement. It is deliberate because of the case that
  motivated it: verified against `0.3.0`, `opensandbox({ initialNetworkPolicy:
  "deny-all" })` called `Sandbox.create` with `{"image":"ubuntu"}` and said nothing, and a
  caller who asked for a locked-down network and silently got an open one has no way to
  tell from the outside. A misspelling that looks network-related is named as such in the
  error.
- `setNetworkPolicy()`'s rejection message no longer says a creation-time policy "is not
  exposed yet"; it points at `opensandbox({ networkPolicy })`.
- The README documents the option, the kill path and the exit-code contract, and says
  which of them are covered only by the stubbed SDK rather than by a live server.

#### Fixed

- **A command that never completed reported success.** `exitCodeOf` was
  `execution.exitCode ?? (execution.error ? 1 : 0)`, so a null exit code with no error
  object returned **0**. The SDK returns null for exactly the cases where the command did
  *not* complete — a server-side timeout kill, an OOM-killed container, an SSE stream that
  simply ends — so a killed command was reported to the model as a success. It now returns
  `137` (128 + SIGKILL), the number Linux, Docker and eve's own `docker()` backend surface,
  so a reader that only asks `exitCode !== 0` sees failure and a reader of the number sees
  "killed". The function's own doc comment and the README both already claimed the fixed
  behaviour. Reproduced on `0.3.0`: an execution of `{exitCode: null, error: undefined}`
  came back from `session.run()` as `{"exitCode":0}`. Applies to `run()` and to `spawn()`.
- **`kill()` did not kill.** It called `AbortController.abort()` and made no further
  request to the sandbox at all — that closes *our* SSE connection, and whether execd then
  reaps the command is a server-side detail the SDK does not promise; it ships a separate
  termination API precisely because hanging up is not a kill. Measured against the previous
  build with a stubbed SDK: `kill()` made zero further calls to the sandbox, and `wait()`
  afterwards **rejected with `AbortError`** rather than reporting a terminated process. A
  spawned command is now wrapped to record its pid, and `kill()` runs a second command
  inside the sandbox that SIGKILLs that pid and every descendant, using the same
  `/proc`-walking script as eve's `docker()` backend. `wait()` after a successful `kill()`
  now **resolves** with `137`; a `kill()` whose request never reached the sandbox throws,
  rather than reporting a termination that may not have happened. Not the SDK's own
  `commands.interrupt()`: it is `DELETE /command?id=<sessionId>` against a bash session
  this backend does not use, and a termination call aimed at the wrong id is a kill that
  silently does nothing.
- The kill's intent is recorded **before** the round trip, not after. The server kills the
  process before it answers, so the spawned command's stream dies while `kill()` is still
  awaiting the response — written the other way round, which is how it was first written, a
  kill that worked perfectly took the "the stream broke unexpectedly" path: `wait()`
  rejected and both byte sinks errored under any reader, the exact opposite of the README's
  claim. A count rather than a flag, so two concurrent kills cannot undo each other.
- **Network-policy options were accepted and never reached the sandbox.** There was no
  correctly-spelled option to pass one with, and anything that looked like one was dropped
  in silence — see `networkPolicy` and `assertKnownOptions` above. This is the one class of
  failure a caller cannot detect from outside the sandbox, which is why both halves of the
  fix refuse rather than degrade.

### @evestack/sandbox-opensandbox@0.3.0 — 2026-08-06

> **Upgrade note — superseded.** npm serves `0.4.0`; this is no longer what a fresh
> install gets. Three things in `0.3.0` are worse than they read. A command that never
> completed — a timeout kill, an OOM, a stream that ends — comes back to the model as
> `exitCode: 0`; `kill()` closes the local connection and sends the sandbox nothing, so
> `wait()` rejects instead of reporting a terminated process; and a network-policy option
> is accepted and dropped, producing a sandbox with wide-open egress and no complaint. The
> README shipped with `0.3.0` already described the first as fixed. All three were fixed in
> `0.4.0`, published 2026-08-09, which also makes an unrecognised option throw. Still live
> for anyone still installing `0.3.0` — this package is standalone, so nothing upgrades it
> for you.

The largest correctness release of any package here. All of b0fcf07.

#### Removed

- **Breaking:** the `workingDirectory` *option* on the backend. It was public and did
  nothing — it created the directory and then ran everything in `/workspace`. Removed
  rather than wired, because eve pins `/workspace` as the relative-path anchor on every
  backend. `run({ workingDirectory })` is the real per-command knob, and it now works.

#### Fixed

- **Three methods eve declares non-optional did not exist**: `spawn`,
  `setNetworkPolicy`, `removePath`. A tool deleting a sandbox file got
  `session.removePath is not a function`. Reading eve's `.d.ts` to implement them turned
  up four more: `run()` destructured `cwd` where eve passes `workingDirectory`, so
  **every** command ignored the directory it was given; `readFile`/`writeFile` were bytes
  where eve's contract is a `ReadableStream`; `useSessionFn` returned synchronously where
  eve returns a Promise; and `abortSignal`, `encoding` and `startLine`/`endLine` were
  dropped silently, with a missing file never returning eve's documented `null`.
- `prewarm` silently discarded `bootstrap()` and `seedFiles`, and `create` ignored
  `templateKey`, so an author's install hook and seed files vanished and every session
  came up bare Ubuntu. Nothing threw; the log said "no template snapshot captured" and
  the README called the cost "a cold start". `create` now throws eve's
  `SandboxTemplateNotProvisionedError`, structurally.
- `joinOutput` appended a newline that was never in the output, so `printf %s x` returned
  `"x\n"` where eve's Docker backend returns `"x"` — contradicting both the function's
  own comment and the README's "byte for byte".
- eve was not given back the key it reattaches sandboxes by (96bc9ef).
- The README sold gVisor isolation at the top and admitted at the bottom that it was
  never exercised. The client SDK has no runtime selector, so the adapter neither
  requests nor verifies one; the top of the page now says what the caveat said.
- Contract 09 asserted the members this wrapper implements are a *subset* of eve's
  declarations, which is structurally blind to the failure that actually happened. It now
  derives the required set from eve's declaration and checks both directions. Falsified:
  renaming `removePath` makes it fail with "never defines removePath".

#### Changed

- eve 0.30.6 → 0.30.8 (b0936a2).

### @evestack/sandbox-opensandbox@0.2.0 — 2026-08-04

#### Fixed

- Two real bugs, found by verifying the adapter against a live OpenSandbox server rather
  than against its types (03c0cf0).

### @evestack/sandbox-opensandbox@0.1.0 — 2026-08-04

First release (952f0f9).

---

## `@evestack/dashboard`

`private: true` on npm. It ships as a multi-arch container image,
`ghcr.io/sammytourani/evestack-dashboard:<version>` (`linux/amd64` and `linux/arm64`),
built and pushed by `.github/workflows/publish-dashboard.yml` on a tag push. The version
here is the image tag. Dates are the git tag's, not npm's.

### @evestack/dashboard@0.4.0 — unreleased

A minor, not a patch, and the reason is the schema. This image installs **spans v4** and
**facts v2**; every published image up to and including `0.3.1` installs spans v3 and facts
v1. Two different schemas under one version number is the state this bump exists to end —
`0.3.1` had been serving both, because the release gate checks that the written-out tags
*agree* with each other, not that the number *increments* when the schema moves.

<Warning>
  **Rolling back to `0.3.1` or earlier over a v4 database is not a clean downgrade, and this
  release cannot stop it.** The guard added here lives in *this* image's SQL and only refuses
  to run when `installed > target`. An older image has no such guard: `sql/traces.sql` moves
  the spans marker forward only (`WHERE version < EXCLUDED.version`), but its
  `CREATE OR REPLACE FUNCTION resolve_span_ancestry` sits at file top level and runs
  unconditionally — so the marker stays at 4 while the v3 resolver replaces the v4 one, and
  because the marker never moved, no later migration re-applies it. `sql/facts.sql` has no
  such `WHERE`, so its marker does decrement (2 → 1) and the fact tables are dropped and
  rebuilt on the way down. Measured on a controlled single-variable rollback: `facts` went
  2 → 1 and the resolver's md5 changed while `spans` stayed at 4. Re-upgrading repairs both.
  Pull forward, not back.
</Warning>

#### Changed

- **The dashboard schema moved: spans v3 → v4, facts v1 → v2.** The version markers are the
  release-visible part of the span-resolution and fact-tier work below; the bump is what
  makes them addressable by a tag instead of hiding behind one that already means something
  else.
- **Every migration is now gated on the version marker before it touches DDL, not just
  data.** An image older than the database it finds leaves it strictly alone and says so,
  rather than half-downgrading it in silence.

#### Fixed

- **A trace split across two overlapping ingest batches kept the `turn_0` alias.** An
  `AFTER STATEMENT` trigger runs inside the transaction that fired it, before that
  transaction commits — and no snapshot shows another transaction's uncommitted rows. So
  when the batch carrying the children and the batch carrying the enclosing
  `workflow.run.id` span are in flight at once, neither can see the other: both commit, and
  the finished trace on disk is one no transaction ever saw. (An earlier entry here said the
  trigger "only sees its own statement's snapshot". That was wrong — a volatile plpgsql
  function takes a fresh snapshot per query — and it mattered, because it made the failure
  sound certain when it is a race: 31 of 40 overlapping traces went stale, not 40.) The session page then reported "No spans on any of the 1
  runs" for a turn whose tool call `/traces/<id>` rendered in full. `insertSpans` now
  re-resolves the traces it touched from its own transaction once every chunk has committed,
  so the last writer to commit is the one whose walk sees the finished trace. The trigger
  stays — it is the only thing that resolves a write that did not arrive through
  `insertSpans`. Measured: 40 traces delivered as two overlapping batches left 93 stale spans
  across 31 of them.
- **Seven more surfaces where a check that could not run reported the reassuring value.**
  The fleet banner returned `null` on a failed sweep, which its own contract reads as
  "nothing is open"; `lib/sandboxes.ts` skipped containers Docker would not describe and
  then counted them in "All 6 running sandboxes are network-isolated" on a PAGE-severity
  alert; the failing-streak query ranked over unresolved runs, so a worker that died
  mid-run sat on top of twenty failures and produced streak 0; failed chart queries
  degraded to the empty result a genuinely quiet window earns; `/evals` rendered "Ended
  badly: 0" from a swallowed count; and `/api/budget` classified errors by substring, so
  permission-denied answered "No budget data yet" at HTTP 200. Each now carries an explicit
  unreadable/unknown state.
- **`/api/health` distinguishes its not-ok states,** so a client can tell an unconfigured
  dashboard from one that cannot reach Postgres from one that is older than its own
  database. `evestack status` reads that body instead of blaming credentials for all four.

### @evestack/dashboard@0.3.1 — 2026-08-09

#### Fixed

- **Every new chat and every fork answered 502 against an eve 0.31.x agent**, and
  `docs/upgrading.mdx` was telling self-hosters to `npm install eve@latest` — which is
  `0.31.3`. `createSession` required a `continuationToken` in the create response;
  0.30.8's docs say the response "returns `sessionId` and the `continuationToken`", and
  0.31.3's say "session message and control request/response bodies do not accept or
  return continuation tokens". The token moved to the `session.waiting` stream event,
  which is where it becomes meaningful — a session that has not parked has nothing to
  continue from. The session id is the handle; the token was never required here, and
  every caller that needs one already resolves it from the durable stream. Now accepted
  as absent, so the dashboard works against both lines. The fix was written and reviewed
  in PR #36 a day earlier and stranded there behind a version bump.
- **`/schedules` was up to 25 hours wrong, and `pinned`, in a zone whose daylight-saving
  change is not a whole hour.** `0 2 * * *` in `America/St_Johns` standing on
  2026-10-31T20:00Z projected 2026-11-02T05:30Z against the runner's 2026-11-01T05:30Z.
  The 0.3.0 fix stepped over the whole repeated interval, which is right for a reading
  inside it — New York's `30 1 * * *` — and wrong for one on its far edge, which has not
  happened yet and occurs exactly once. The test is now the candidate rather than the
  interval: look ahead at the new offset and step over the window only when what is found
  inside it is a reading the clock has already spent. Verified against the runner across
  five zones and both transitions; `America/St_Johns`, `Australia/Lord_Howe`,
  `Pacific/Chatham` and `Europe/Berlin` now have no confidently-wrong answer at all.

<Note>
  One known case remains, unfixed and stated rather than hidden: in `America/New_York`,
  `0 2 * * *` evaluated the day AFTER a spring-forward projects an hour late while still
  reporting `pinned`. One disagreement in 180 differential cases per zone. The other
  disagreements in that sweep are the runner's own fall-back quirk — `nextFire()` can
  return an instant earlier than its `after` argument during the repeated hour — where
  the page is right and the oracle is wrong.
</Note>

### @evestack/dashboard@0.3.0 — 2026-08-09

The second release of the day, and cut for the reason the first one was: `0.2.0` shipped
in the morning and the audit's remaining findings landed in `3d318ce` that afternoon, so
the image tag and the source tree once again named the same version while containing
different code. Bumping is what stops that from being a standing condition rather than an
incident.

A minor, not a patch: the schedule projection moved from the browser to the server and
changes what the page displays, and `/api/health` grew a field.

#### Security

- `safeNextPath` rejected the `//` and `/\` prefixes, but the WHATWG URL parser strips
  tab, LF and CR *before* parsing, so the string the browser resolves is not the string
  that was validated. `/signin?next=/%09/evil.example` sent the operator off-site
  immediately after they typed the deployment password. Measured against Node's own
  implementation for all three characters (b9a00a7).

#### Fixed

- **`/costs` counted turns that never called a model as unpriced spend.** `priced` is a
  three-state column — `TRUE` priced, `FALSE` no catalog entry, `NULL` no model call
  (`sql/facts.sql:155`) — and `r.priced !== true` folded the last two together. The
  warning banner then read "N turns ran a model with no catalog price ()" with an empty
  parenthetical, because a turn that called no model has no model name to list. The same
  fold was corrected in `lib/alerts.ts`, where it produced a spurious `firing` alert.
- **"Most expensive sessions" on `/costs` was empty on every install since it shipped.**
  `session_id` is `groupable: false` in the catalog, `compileMetricQuery` threw, and
  `ranked()`'s caller caught everything and returned `[]`, so a broken panel rendered as
  "Nothing to rank" — indistinguishable from a quiet month. The query now takes an
  explicit `topN: true`, and `MetricQueryError` is re-thrown rather than swallowed
  (38076ca).
- **`/schedules` computed the next fire in the reader's browser timezone.** The number is
  now projected server-side, and the agent's zone is derived from the fires that schedule
  actually recorded rather than assumed — so two people in different places are shown the
  same instant, and it is the instant the runner will use.
- **`/schedules` projected a daylight-saving fall-back a full day early, and marked it
  confident.** Standing on 01:30 EDT the page offered the 01:30 EST repeat an hour later;
  the runner fires the next day, because Vixie does not re-run a reading the clock
  repeats. `pinned: true` suppresses the UI's hedge, so it was drawn as a firm answer.
  Verified against `@evestack/schedules`' own `nextFire()` rather than against a
  description of it, and pinned by a differential test over both transitions.
- **A schedule named `__proto__` lost its next fire silently.** `nextFires[name] = value`
  on a plain object sets the prototype instead of creating a property when the key is
  `__proto__`, and the name is chosen by the operator. Built with `Object.fromEntries`
  now, which creates an ordinary own key.
- **The wedged-turns alert used a 15-minute threshold** while `facts.sql`, `lib/fleet.ts`
  and the `wedged` outcome all use `STUCK_TURN_MS` = 1 hour, so it counted turns the fleet
  banner called healthy and linked to a shorter list than the number it reported
  (b9a00a7). Its `threshold` field, rendered as "healthy: …", separately asserted "none
  stalled" whatever the count was; it now states the condition it actually tests.
- **`/memory` capped at 200 rows without saying so.** The total was already shown; what
  was missing was any marker that the list itself had ended early.
- **Several claims about what an unconfigured dashboard serves were wrong**, in
  `lib/auth.ts`, `proxy.ts`, `app/api/health/route.ts`, the README and `.env.example`.
  It does not answer 503 on every route: `PUBLIC_PATHS` holds three paths and `proxy.ts`
  gates the tier on method, so four path/method combinations get through — `GET /signin`
  renders the misconfiguration with no form on it, the two `/api/auth` routes are
  POST-only and answer a bare 405, and `GET /api/health` reaches its own handler, which
  returns `503 {"status":"unconfigured"}`.

#### Added

- **`/api/health` reports the dashboard's own `version`**, on every branch including the
  failures. Nothing could previously ask a *running* dashboard what it was — `evestack
  verify` printed the same line against the current image and against the four-day-old
  one — which is the whole reason the `0.1.0` image went 51 commits stale unnoticed
  (f76a0d1).
- Tests for two surfaces that decided something consequential and had none: `evaluateAlerts`
  (every `DeliveryStatus` branch, the threshold boundary, empty versus stale facts) and the
  approvals decision path.

### @evestack/dashboard@0.2.0 — 2026-08-09

Tagged `dashboard-v0.2.0`, under the old convention. "51 commits, 149 files,
+25,621 / −1,524" since the `0.1.0` image, by the release commit's own count (751ac5c).
Nothing here was broken; the release had simply never been cut, and no verification tier
could see it because all four validate the checkout rather than the artifact.

> **Upgrade note.** `create-evestack` on npm is still `0.8.0` and writes `:0.1.0` into
> every compose file it generates, so until the scaffolder is republished this release
> reaches people who clone the repo and people who track `:latest` — not `npx
> create-evestack` users. A deliberate half-step. `:0.1.0` stays pullable.

#### Added

- The `/sessions` list — the page in the README's own hero screenshot. The `0.1.0` image
  shipped only `/sessions/[id]`, so the route the screenshot shows was a 404 in the image
  everyone was running (295a878).
- `/costs` (e3204e1), `/sandboxes` (e92b7c1) and `/charts` (ecb17e3).
- `/api/alerts` and `/api/metrics/query`, the fact tables underneath every chart, and the
  query API (ecb17e3, 991b6d0).
- Nine monitors that actually deliver, with a third state that is not OK (7528a72,
  991b6d0, 82a316d).
- The design system pass: preflight, one measure, and the states every page shares
  (ef181b0, 57b2ffe).

#### Security

- Sign-in stopped redirecting the browser to the address the server is bound to
  (c2dc9f0).
- Forking replayed turns the operator never agreed to run (5699fcd).

#### Fixed

- Ten defects in the data layer, four of them silent (d15c962).
- A failure rate that could read 200% (1dcc9f3); `count()` claiming to be dollars
  (6043533); three ways the query API answered confidently and wrongly (5c135f5).
- The endpoint that distinguishes a wired exporter from a silent one reported silent
  (23ce653).
- "Nothing happened" and "I cannot see" no longer render the same (cc89fec).
- The wedged-turns alert could not fire outside UTC (be42dcd).
- `getPool().end()` left the dead pool in the global (d128c87).
- Ten stale claims across README, docs, `llms.txt` and site copy, adjudicated against the
  code — 107 falsifiable claims read, 10 false (920a439).

### @evestack/dashboard@0.1.0 — 2026-08-05

Tagged `dashboard-v0.1.0`. The first published image, built from d4aee43. Multi-arch from
the start.

Everything before it — sessions, the run tree, the control API, OTLP ingest and
integrations (ac6d4da), pgvector long-term memory and trace export (88241fd), browser
chat (d2a9717) — was only reachable by cloning the repository and running
`docker build`. It is folded into `0.1.0` rather than itemised: nothing was released
before it, so there is no "changed since" to describe.
