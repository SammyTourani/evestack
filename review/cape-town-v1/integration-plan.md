# integration-plan.md — merging ten worktrees

Nothing is committed to `cape-town-v1` yet. Ten agent worktrees hold the work, nine of them
uncommitted, one (`ae70739d2`) already committed on its own branch.

## Merge order — code first, copy last

Copy touches everything, so it must land on final code or it will be reconciled twice.

| # | Branch suffix | Lane | Top-level paths |
|---|---|---|---|
| 1 | `a8aca7cda` | W1 `evestack doctor` | `packages/evestack-cli` |
| 2 | `a500f6a80` | W2 span↔session join | `packages/dashboard`, `contract` |
| 3 | `a8cddeab8` | W3 fleet honesty | `packages/dashboard` |
| 4 | `af5e700e2` | D1 schema guard + D4a failure rate | `packages/dashboard`, `contract` |
| 5 | `a5262b482` | W5 scaffolder UX + `git init` | `packages/create-evestack` |
| 6 | `ae1565ed7` | D3 eve floor + D4b attach | `packages/create-evestack`, `README.md`, `docs` |
| 7 | `ae70739d2` | W6 template noise (**committed**) | `templates/default` |
| 8 | `a4193c7a3` | D2 eval blocker | `templates`, `docs`, `CONTRIBUTING.md`, `.github` |
| 9 | `a5c99df04` | W7 missing tests | `contract`, `packages` |
| 10 | `ad8f06e1b` | W4 copy and numbers (33 files) | everything |

## Known conflict points — resolve deliberately, do not accept either side blindly

1. **`packages/dashboard/sql/traces.sql` version target.** W2 (#2) bumps spans to **4** for the
   resolver migration. D1 (#4) adds a downgrade guard and carries the target literal **twice**
   (the guard runs ~350 lines before the migration, and plpgsql cannot export a constant).
   After merging both, **all occurrences must read 4**. `packages/dashboard/test/schema-guard.test.mjs`
   fails if they disagree — that test is the single best guard on this merge, keep it.
2. **`README.md`** — W4 (#10) rewrites many lines; D3 (#6) changes only line 178 to
   `Pin \`eve\` \`>=0.30.0\`.` Keep D3's value, W4's surrounding prose.
3. **`docs/self-hosting.mdx`** — D3 fixes `:63` and `:203` to `>=0.30.0`. W4 may touch the same
   file for other reasons. The floor must end at 0.30.0 everywhere; see `decisions.md` D3.
4. **`packages/create-evestack/ui.mjs` ↔ `templates/default/scripts/ui.mjs` must stay
   byte-identical** — there is a test asserting it, and `scripts/sync-template.mjs` is the
   mechanism. W5, W6 and W4 all touch this pair's neighbourhood.
5. **`packages/create-evestack/create.mjs`** — W5 (#5) adds `git init` + `warnNoGit()`; D4b (#6)
   adds the ancestor-aware equivalent to `attach.mjs` only and deliberately shares nothing.
   Confirm no duplicated helper after both land.
6. **`contract/contracts/20-fleet-port.contract.mjs`** pins `IDLE_BEFORE_SUSPECT_MS` and
   `STUCK_TURN_MS` equal to the CLI's copies in `packages/evestack-cli/src/sessions.mjs`. W3 (#3)
   and W1 (#1) both live near it.
7. **`contract/runtime/probes/08-metric-query.probe.mjs`** — D1/D4a (#4) updated its failure-rate
   assertions; W7 (#9) also reports it failing for anti-vacuity reasons on a small database. Both
   are right; reconcile rather than pick.
8. **`CHANGELOG.md`** — only W4 (#10) touches it, deliberately, to avoid a guaranteed conflict.

## Acceptance gate before anything merges to `cape-town-v1`

- `node contract/run.mjs` green, and the assertion **floor must not drop** (baseline 508; W2 and
  D1/D4a each added one, W6 added two — expect ~511+, never fewer).
- `pnpm -r test` green, allowing for the two known pre-existing failures:
  `packages/evestack-cli/test/status.test.mjs` "a dashboard URL with no scheme falls back" (fails
  whenever anything listens on `:4000` — non-hermetic, W7 flagged it) and
  `packages/dashboard/test/schedules-next-fire.test.mjs` (unbuilt `@evestack/schedules` dist;
  `pnpm --filter @evestack/schedules build` fixes it).
- A clean scaffold from the merged tree: four prompts, `git init`, no `.npmrc` under `.eve`,
  `evestack verify` green, `evestack doctor` working without an explicit URL, a real turn, and
  the session page showing the tool call.

## Rebuild the reproduction stack afterwards

The current one at `~/evestack-stranger-test/cold/my-agent` is a mixed state — `spans v4` marker,
v3 resolver, old `0.3.1` container — and is no longer trustworthy as a measurement surface. Tear
it down and scaffold fresh from the merged tree.

Also tear down the agent test beds: five projects are currently running on ports 4000–4004 /
5433–5437, plus sandbox containers. Only `cold/my-agent` is referenced by the deliverables.

## Incidental result worth keeping

Five independently scaffolded projects ran side by side throughout this work and took
**4000/5433, 4001/5434, 4002/5435, 4003/5436, 4004/5437** with no collisions and no cross-talk.
That is Part 9B at five times the scale the plan asks for, unplanned, and it held — stronger
evidence for the port-selection claims (ledger rows 25/26) than the deliberate two-project test.
