# HANDOFF — cape-town-v1 stranger test and the fixes it produced

**For a reviewer picking this up cold, human or agent. Nothing here is pushed to `main`.**

24 commits ahead of `main` (`464a85f`). Everything was produced by an acceptance test run as a
stranger, then seventeen fix agents across two rounds, then two integration passes.

## Read in this order

| File | What it is |
|---|---|
| `verdict.md` | The 8 questions from the test plan, answered. Start here. |
| `claims-ledger.md` | The product's 20 public promises, each TRUE / FALSE / CAN'T TELL with evidence |
| `findings.md` | Every defect, with reproductions. Also every correction I had to make to my own earlier claims |
| `findings-round2.md` | Upgrade, uninstall, clone, scale and the visual passes |
| `decisions.md` | Four judgement calls, with the evidence behind each. **D2 is retracted — read its header** |
| `investigations.md` | Read-only research: the eve watcher bug, wedge thresholds, macOS CI, disk |
| `fix-plan.md` / `integration-plan.md` | How the work was split and merged |
| `diary.md` | Chronological, including the waiting and the false starts |

## The state you are inheriting

- `node contract/run.mjs` → **23 contracts, 530 assertions, green**. Floor raised from 508;
  no entry was ever lowered.
- `pnpm -r test` → **1161 green**. One package cannot run: `packages/website` Playwright needs
  `:3000`, held by an unrelated process on the test machine. Proven pre-existing.
- Dashboard bumped **0.3.1 → 0.4.0**, because the tree now installs spans v4 / facts v2 while
  the published `0.3.1` installs v3 / v1.
- **Commits are unsigned** (`git log --format=%G?` → `N`). 1Password was locked. Re-sign if the
  repo requires it.
- `ghcr.io/sammytourani/evestack-dashboard:0.4.0` **does not exist on GHCR yet**. The tree pins
  it, so `docker compose pull` 404s until the release is cut.

## Where I would look hardest if I were reviewing this

Ranked by how much damage a mistake would do.

1. **`packages/dashboard/lib/traces.ts` — the concurrent-ingest fix.** The subtlest change in
   the set. An `AFTER STATEMENT` trigger is pinned to its statement's snapshot, so when two
   OTLP batches for one trace overlap in flight, neither transaction ever sees the whole trace
   and the turn alias sticks forever. The fix re-resolves after the chunks commit. Verify the
   claim that it holds under concurrency, not just that it compiles — four simultaneous turns
   was the bar, and a per-trace advisory lock was tested and does *not* work.
2. **`packages/dashboard/sql/traces.sql` and `facts.sql` — the version guard.** Two literals in
   `traces.sql` must agree; `test/schema-guard.test.mjs` is the arbiter and must never be edited
   to pass. Note the guard cannot protect against a rollback to today's published image, because
   that image contains no guard. First rollback after release is unprotected.
3. **`contract/contracts/22-blind-is-not-all-clear.contract.mjs` + the dashboard test of the same
   name.** These encode the single most repeated defect in this codebase. Written over
   populations rather than instance lists, so a new alert is covered automatically. If you change
   them, keep that property.
4. **`packages/create-evestack/attach.mjs` and `create.mjs` — `git init`.** Closes a real
   credential leak (details below). The ancestor logic distinguishes a workspace root from a
   bare repo; that distinction is load-bearing, not stylistic.

## Things worth knowing that are not in the diff

- **The credential leak was real and is closed.** With no `.git`, eve resolves its dev source
  root to `$HOME`, finds the user's dotfiles repo, and copies `~/.npmrc` — auth token included —
  into `.eve/dev-runtime/snapshots/`. 23 byte-identical copies accumulated on the test machine
  and were deleted. Proven closed by A/B: with `.git`, zero copies; delete it, one reappears.
- **The dominant defect pattern: health signals that degrade to good news when their input is
  missing.** Eleven instances found, all fixed. The failure rate scored crashed turns as
  *successes* (6% and no alert where the truth was 30% and firing). `/api/health` answered
  healthy for two hours against an unreadable database. A container Docker could not describe
  was counted inside "All 6 running sandboxes are network-isolated".
- **`:ro` on a Docker socket is theatre.** Measured: through a read-only socket mount, as a
  non-root container user, `POST /containers/create` with `Binds: ["/:/host"]` returned
  **201 Created**. That is why the shipped comment does not use `:ro`.
- **Six of my own claims were wrong and are marked as corrections in `findings.md`**, not quietly
  edited. Five were inferences stated as measurements. The sixth was worse: I reported the eval
  tier broken when the failure came from an agent I had deliberately `kill -9`'d earlier in the
  test. If you find a seventh, that is the most useful thing you could hand back.

## Still open, deliberately

- **Claim 6** needs a paid provider bill. **Claim 15** needs a Composio account. The Telegram
  *delivery* half of claim 13 needs a bot token and a public HTTPS tunnel. All three need a human.
- **`fact_tool_call.ok` is `status_code <> 2`**, so OTel UNSET — what every tracer that only sets
  a status on failure emits — records as a success and is averaged into a "Tool failure rate"
  claiming 100% coverage. Same bug as the turn failure rate, one view over. Not fixed: it needs a
  nullable column and a facts schema bump that rebuilds all three fact tables.
- **`sandbox/deny-all-still-means-no-network` does not test what its name says.** It asserts
  `--network none` appears in argv; nothing starts and no packet is attempted. Runtime isolation
  *was* verified by hand and is correct. The template's own `resolveNetworkPolicy()` has no test
  and is not exported.
- **`.github/upstream/eve-dev-watcher-source-root.md`** is a drafted upstream issue, deliberately
  not filed. Searched — not a duplicate.
- **The release gate has a blind spot:** `packages/website/lib/copy.ts:506` states the image tag
  without the `evestack-dashboard:` prefix, so the gate's grep misses it.
- `docs/` never mentions `EVESTACK_DOCKER_SOCKET`; the repo's own `docker-compose.yml` has no
  socket mount either.

## A note on method

Where a finding says "measured", it was. Where it says "inferred", treat it as a hypothesis —
that distinction cost me six corrections and it is the thing I would most want a second reviewer
to be ruthless about. Several agents caught their own bugs before committing and said so; that
is the standard the work was held to, and it should apply to this handoff too.
