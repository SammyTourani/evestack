# HANDOFF — cape-town-v1 stranger test and the fixes it produced

**For a reviewer picking this up cold, human or agent. Nothing here is pushed to `main`.**

## What this is, in one paragraph

An acceptance test run as a stranger against the shipped product, then seventeen fix agents
across two rounds, then two integration passes, then a correction round that audited this
packet's own claims. The branch has **diverged** from `main` — it is not simply ahead — and
`464a85f` is the merge-base, not `main`'s tip. There is no commit count in this document on
purpose; every one written here has been wrong within a day. Ask instead:

```bash
git rev-list --left-right --count main...HEAD   # was `1 29` at 2d4e86d
```

`main` holds one commit this branch does not (`fe4adb3`, the topology-table fix, which also
exists here as `3fdaadc` — see the cherry-pick table below). A reviewer planning the merge needs
that side of it too.

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

- `node contract/run.mjs` → **23 contracts, 545 assertions, green** *(re-measured at `8528cd4`;
  this line said 530, which was true at `412c761` and has moved twice since — re-run it rather
  than quoting it)*. Floor raised from 508; no entry was ever lowered.
- `pnpm -r test` → **1210 tests, 1210 pass, 0 fail**, across 10 of 11 workspace projects
  *(re-measured at `8528cd4`; this line said 1161)*. The eleventh is `packages/website`:
  Playwright needs `:3000`, held by an unrelated process on the test machine. Proven
  pre-existing.
- `node --test contract/lib/*.test.mjs` → 35 pass; `contract/runtime/lib/*.test.mjs` → 22 pass.
- GitHub Actions on `8528cd4` → 9 of 9 jobs green, runtime tier included.
- Dashboard bumped **0.3.1 → 0.4.0**, because the tree now installs spans v4 / facts v2 while
  the published `0.3.1` installs v3 / v1.
- **16 commits are signed; the rest are not, and the unsigned ones are the cherry-picks** (see
  the table below — de-duplicating the pairs and re-signing are the same job). Sixteen is stable:
  they are the original fix-agent commits, carrying real `BEGIN SSH SIGNATURE` blocks (ed25519)
  in the commit object. The unsigned count is not stable, so it is given as a set, not a
  fraction.

  <details>
  <summary><strong>Why an earlier draft said "all unsigned" — the instrument, not the fact</strong></summary>

  **`git log --format=%G?` was the wrong instrument, and it fails in the direction that
  reassures.** It reports `N` for a signature it cannot *verify* as readily as for one that is
  *absent*, and this checkout has no `gpg.ssh.allowedSignersFile` — `git config --get
  gpg.ssh.allowedSignersFile` exits 1. Run the original command and git says so out loud on
  stderr while printing `N` anyway:

  ```
  $ git log --format='%G?' 464a85f..HEAD
  error: gpg.ssh.allowedSignersFile needs to be configured and exist for ssh signature verification
  N
  ```

  The instrument that does not depend on verifier config is the commit object:

  ```bash
  for c in $(git rev-list 464a85f..HEAD); do
    git cat-file commit "$c" | sed -n '1,20p' | grep -q '^gpgsig' \
      && echo "SIGNED   $(git log -1 --format='%h %s' "$c")" \
      || echo "unsigned $(git log -1 --format='%h %s' "$c")"
  done
  ```

  → **16 SIGNED, and the rest unsigned** (12 of them at `2ada44c`). Configure
  `gpg.ssh.allowedSignersFile` before making any claim about signature *validity*; presence is
  all that is asserted here, and it is all `%G?` was being used to assert. GitHub's own Verified
  badge was **not** checked from this worktree — these commits are not pushed — so do not carry
  that claim forward without looking.

  </details>

  **The unsigned ones are not a lapse, they are the cherry-picks.** Four subjects appear
  twice in this range, and in every pair the original is signed and the copy is not:

  | subject | signed original | unsigned copy |
  |---|---|---|
  | `traces: resolve a batch after it commits, not inside it` | `cc95ee6` | `42c2ef7` |
  | `health: the fifth through eleventh places a check that could not run…` | `34af1c7` | `a6d22a5` |
  | `create: the documented way to see your sandboxes needed three lines…` | `65915a9` | `0d4e1eb` |
  | `docs+ci: publish the disk numbers, put macOS in CI…` | `f3f1aa0` | `3187006` |

  (`991d4af` *Three tests that could not fail…* and `d97ad8e` *contract: three tests that could
  not fail…* are a fifth pair with a reworded subject.) A signature covers the commit object,
  parent included, so replaying a commit onto a new parent cannot carry it. **De-duplicating
  these pairs and re-signing are the same job, not two** — resolve the duplicates first and the
  signature gap mostly closes itself.
- `ghcr.io/sammytourani/evestack-dashboard:0.4.0` **does not exist on GHCR yet**. The tree pins
  it, so `docker compose pull` 404s until the release is cut.

  *Re-verified 2026-08-11 against the live registry, anonymous pull:* the tags list is still
  exactly `["0.1.0","latest","0.2.0","0.3.0","0.3.1"]`, and a manifest request for `0.4.0`
  returns **HTTP 404**. `docker-compose.yml:136` pins
  `${EVESTACK_DASHBOARD_IMAGE:-ghcr.io/sammytourani/evestack-dashboard:0.4.0}`. Still true, and
  `README.md:67-68` was corrected in round 3 to stop implying otherwise.

## Where I would look hardest if I were reviewing this

Ranked by how much damage a mistake would do.

1. **`packages/dashboard/lib/traces.ts` — the concurrent-ingest fix.** The subtlest change in
   the set. An `AFTER STATEMENT` trigger runs inside the transaction that fired it, before
   that transaction commits, and no snapshot shows another transaction's uncommitted rows — so
   when two OTLP batches for one trace overlap in flight, neither sees the whole trace and the
   turn alias sticks. The fix re-resolves after the chunks commit. It was verified under real
   concurrency, not just compiled: `contract/runtime/probes/22-concurrent-ingest-resolution`
   drives 40 traces as two overlapping batches each against a live Postgres and runs on every PR.

   > **CORRECTION — two claims in this entry were wrong, and one of them was an instruction.**
   >
   > It originally said the trigger "is pinned to its statement's snapshot". It is not: a
   > trigger function is VOLATILE, and a volatile plpgsql function takes a fresh snapshot at
   > the start of every query it runs. Measured on this schema — one read saw 0 rows and its
   > next read, 400 ms later, saw a row a concurrent session had committed in between. The real
   > mechanism is transaction visibility, not snapshot freezing, and the difference is not
   > academic: it makes the failure a **race** rather than a certainty, which is the only story
   > that fits the measurement. 40 overlapping traces left 31 stale, not 40.
   >
   > It also told reviewers "a per-trace advisory lock was tested and does *not* work". The
   > REASON given was a corollary of the false mechanism above, and nobody had run the
   > experiment — a standing instruction not to try the textbook fix, resting on nothing.
   >
   > **CORRECTED AGAIN, and this is the third draft of this paragraph.** The second draft said
   > "it was never tested, and it does work — 0 stale spans, against 3 under forced overlap
   > without it." That is also wrong, and it is wrong in the direction that matters: it would
   > send the next person to implement a lock that loses batches.
   >
   > The two claims differ because the FORCING differs, and only one forcing is the one this
   > code produces. Await the first writer's commit before issuing the second writer's insert
   > and the lock behaves as it looks — the second waits, its walk sees the first's rows,
   > nothing stale. **Issue both statements before awaiting either** — the shape `insertSpans`
   > actually produces, and the shape the phrase "overlapping batches" means here — and it
   > blocks and stays blocked. Measured on PostgreSQL 17.10: `pg_locks` reports one advisory
   > lock granted and one not, still, six seconds in, against a `deadlock_timeout` of 1s.
   > Postgres never breaks it, and is right not to: a client holding both transactions while
   > awaiting the blocked one is not a lock *cycle*, so there is nothing for deadlock detection
   > to find. The batch is lost.
   >
   > So the lock is rejected, and on stronger grounds than either earlier draft claimed: it is
   > an **availability failure under the exact concurrency it was proposed to fix**, not a
   > throughput tax. It also serializes every writer of a trace on the hottest insert path, and
   > its correctness depends on READ COMMITTED — at REPEATABLE READ the trigger really does hold
   > one snapshot for the whole transaction and waiting really would buy nothing.
   >
   > Three drafts, three claims, one of them arrived at by running both sequencings instead of
   > one. That is the lesson worth carrying out of this document: the first draft inferred, the
   > second measured one case and generalised, and only the third measured the case that
   > matters. The long version is above the trigger in `sql/traces.sql`.
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
  into `.eve/dev-runtime/snapshots/`. ~~23~~ **ten** byte-identical copies accumulated on the
  test machine and were deleted. Proven closed by A/B: with `.git`, zero copies; delete it, one
  reappears.

  *Corrected on review (round 3):* **ten** is the number, stated twice and independently —
  `findings.md:258-260` ("there were **ten** by then, not the three I first found, because the
  other agents' test runs each produced more") and `decisions.md:118-121` ("I found ten such
  copies on this machine and deleted them"). **23 appears nowhere else in this packet**, and
  nothing derives it. Since the count is evidence for a *security* claim — how far a credential
  spread before it was contained — the inflated one is the worse direction to be wrong in, and
  it is the one a reader quotes.
- **The dominant defect pattern: health signals that degrade to good news when their input is
  missing.** Eleven instances found, ~~all fixed~~ **eleven fixed and a twelfth left open —
  see `fact_tool_call.ok` under "Still open, deliberately" below.** The failure rate scored
  crashed turns as *successes* (6% and no alert where the truth was 30% and firing).
  `/api/health` answered healthy for two hours against an unreadable database. A container
  Docker could not describe was counted inside "All 6 running sandboxes are network-isolated".

  *Corrected on review (round 3):* "all fixed" was written **sixteen lines above** its own
  counter-example. "Still open, deliberately" says `fact_tool_call.ok` is `status_code <> 2`,
  so OTel UNSET records as a tool success — and names it "**Same bug as the turn failure rate,
  one view over. Not fixed.**" That is a twelfth instance of the pattern this bullet is
  counting, on the same page, and the summary line reports the set as closed.

  This is the pattern eating itself: a summary that degrades to good news when one of its
  inputs is an open item. The count is right — eleven were found and eleven were fixed — but
  "all" quantifies over the *pattern*, and the pattern has twelve known instances. Say
  "eleven fixed, one open" so the number and the quantifier cannot drift apart again.
- **`:ro` on a Docker socket is theatre.** Measured: through a read-only socket mount, as a
  non-root container user, `POST /containers/create` with `Binds: ["/:/host"]` returned
  **201 Created**. That is why the shipped comment does not use `:ro`.
- **Six of my own claims were wrong and are marked as corrections in `findings.md`**, not quietly
  edited. Five were inferences stated as measurements. The sixth was worse: I reported the eval
  tier broken when the failure came from an agent I had deliberately `kill -9`'d earlier in the
  test. If you find a seventh, that is the most useful thing you could hand back.

  *Round 3 — asked for and delivered. There were four more, and this file held three of them.*

  | # | Where | What was wrong |
  |---|---|---|
  | 7 | `claims-ledger.md`, claim 5 | Verdict right, two of three legs backwards: `rollup.ts:29-33` was quoted as the code admitting a defect when it is the code explaining why it avoided one, and `/sessions` — the one surface that handles unpriced models correctly — was named as defective. Closed in code by `ac156cd` + `2ada44c` |
  | 8 | `app/api/health/route.ts:145-148` | "Each entry was checked against the code, not assumed — `/charts` is a static demo and stays up", over a list containing `/charts`, which `findings-round2.md:439` measured as a 404 and which `app/charts/page.tsx:103` makes a 404 on purpose. A fix commit's comment, not the test's prose |
  | 9 | `claims-ledger.md`, POST-FIX tally | Claims 9, 10 and 14 scored TRUE on evidence the rows themselves disqualify, eighteen lines from the paragraph demoting 14 for exactly that. Reconciled to 11 TRUE · 2 FALSE · 6 CAN'T TELL · 1 not reached |
  | 10 | `findings-round2.md:293` | 8.0 GB for two Ollama models — an unattributed total, larger than the whole 7.4 GB directory it is a subset of. Measured figure is 5.5 GB. Same root cause as the round-1 disk CORRECTION, one round later |
  | 11 | `investigations.md:774-775` | Cited `README.md:115-118` and quoted *"qwen3 is 5.2 GB … budget both model sizes + 4 GB"*. The RAM section is at `:128-131`, and `rg -n '5\.2 GB' README.md` returns **nothing** — README never states qwen3's size. A paraphrase in quotation marks, attributed to a file that does not contain it |

  Plus the four numbers in this file, corrected above. **The recurring shape is not carelessness
  — it is a citation pointing at something adjacent to what the sentence claims.** Five of these
  eleven quote a real line that says something other than what it was quoted for, and #11 quotes
  a line that does not exist. Check the *subject* of a sentence you cite, not just that the words
  appear near it.

  **Every line-number citation added or touched in round 3 was mechanically re-verified** — each
  one was opened and checked to contain the string it was cited for. That pass caught four of
  the eleven above, including #11 and the `rollup.ts` field offset, and it is the cheapest
  reviewing step in this packet: extract `path:line`, open the span, assert the quoted substring
  is in it. Line numbers are claims and they decay silently; nothing else here decays without
  changing how it reads.

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
- **The release gate has a blind spot:** `packages/website/lib/copy.ts:524` states the image tag
  without the `evestack-dashboard:` prefix, so the gate's grep misses it — the line is
  `{ name: "dashboard image", detail: "0.4.0, matching the pin" }`. Find it with
  `rg -n 'dashboard image' packages/website/lib/copy.ts` rather than by line number.
  *(Was `:506`; round 3 added a comment block above it and moved it to `:524`. Re-cited rather
  than left to rot — a line number is a citation, and this packet has been bitten four times by
  citations that still resolve to a line but no longer to the right one.)*
- `docs/` never mentions `EVESTACK_DOCKER_SOCKET`; the repo's own `docker-compose.yml` has no
  socket mount either.

### Opened in round 3 — found while correcting the record, owned by nobody yet

- **The landing page's "Running in four steps" never starts the dashboard.**
  `packages/website/lib/copy.ts` `quickstart.steps` runs scaffold → `docker compose up -d
  postgres` + `npm run db:bootstrap` → `npm run dev` → `npm run verify`. The step that brings up
  the dashboard — `docker compose --profile dashboard up -d` — is on **neither** website
  surface: `rg -n 'profile dashboard' packages/website/` returns nothing, and the `terminal`
  artwork above it omits it too. Every other surface lists it: `README.md:36-42`,
  `create.mjs:1078-1085`, `docs/quickstart.mdx:124`. `copy.ts:106` is a comment in that same file
  reading **"THESE MUST BE THE COMMANDS THE SCAFFOLDER PRINTS"**, with a note about two commands
  that were wrong for a long time — the rule was written, and this is a third violation of it.
  A visitor following the manual path lands with no dashboard and no error, on the page whose
  own copy calls the dashboard the reason to self-host. **Not fixed here: this is structure, not
  copy, and the landing page's design is out of scope for this lane.**
- **`create-evestack@0.9.2` means two different things.** `packages/create-evestack/package.json`
  says `0.9.2` and `shared.mjs:40` pins `DASHBOARD_IMAGE_TAG = "0.4.0"`. The **published** 0.9.2
  on npm pins `"0.3.1"` — verified by unpacking the real tarball:
  `npm pack create-evestack@0.9.2 && rg -n 'DASHBOARD_IMAGE_TAG' package/shared.mjs` → `0.3.1`.
  Same version number, different code, and the difference is which image a user pulls. This is
  the exact condition `CHANGELOG.md:64-70` names as the one "every check in RELEASING.md reports
  as green". Bump the scaffolder alongside the dashboard release, or the pin and the version
  stay decoupled.
- **Contract 16 cannot see a broken link to any root-level file.** Found by mutation, not by
  reading. `contract/contracts/16-documented-paths.contract.mjs` opens *"Every path this repo
  points a reader at must exist"*, but its `PATH_PATTERN` only matches paths beginning
  `docs|packages|contract|templates|registry|scripts|.github`. Every root-level target is
  therefore unchecked — `CHANGELOG.md`, `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, `NOTICE`,
  `FINDINGS.md`, `RELEASING.md`, `CODE_OF_CONDUCT.md` — and README's own header links two of
  them (`[Changelog →](./CHANGELOG.md)`, `[License](./LICENSE)`).

  Proven both ways on the same file:

  | mutation in `README.md` | contract 16 |
  |---|---|
  | `./CHANGELOG.md` → `./CHANGELOG-NOPE.md` | **PASS, 72 assertions** — survived |
  | `docs/composio-auth.mdx` → `docs/composio-auth-NOPE.mdx` | **FAIL**, *"README.md points at `docs/composio-auth-NOPE.mdx`, and it exists"* |

  So the contract is live, not vacuous — it is *scoped*, and its own first sentence claims a
  universality it does not deliver. Either widen the pattern to root-level `*.md` (the paths are
  a `readdirSync` away, which is this contract's own stated argument for existing) or narrow the
  docstring. Do not leave them disagreeing. **Not mine to fix — `contract/` is another lane's.**
- ~~**`docs/support.mdx:124` cites the wrong line for the win32 browser branch.**~~ **Closed in
  round 4.** The correction above was itself stale by the time it was written: `8528cd4` added
  the fence block to `verify.mjs`, so the `cmd /c start` branch is at **`:651`**, not `:584-586`.
  The other two citations in that bullet were off by one (`project.mjs:357`, `tour.mjs:396`), and
  a fourth error nobody had noticed: the bullet below it quoted `shell: true` as if it were the
  literal in the source, and `rg -n 'shell\s*:\s*true'` finds that string in **no** shipped file
  — the code reads `shell: process.platform === "win32"`. `create.mjs:1110` was also wrong; the
  third occurrence is `:1185`. All fixed, and each bullet now carries the `rg` that finds the
  lines instead of relying on the number surviving.

### Opened in round 4 — a documentation lane read the new pages as a stranger and ran the commands

The pages this branch added or rewrote had never been read by anyone who was not their author.
Running every runnable command in them found six defects, four of them on `docs/uninstall.mdx`,
which is the page that tells people to delete things. All six are fixed in `docs/`; they are
recorded here because the *shape* of them recurs.

- **`uninstall.mdx` assumed every project came from `create`.** An attached project may hold
  `docker-compose.evestack.yml` beside a `docker-compose.yml` that is the user's own. Bare
  `docker compose --profile dashboard down -v` there resolves the **user's** project. Measured in
  a directory holding both files: `docker compose --profile dashboard config --volumes` printed
  `their-precious-data`. The page's "list first" safeguard did not help, because the list command
  had the same defect as the removal command — it confirmed the wrong target.
- **`config --volumes` was presented as naming the volume "exactly".** It prints the compose
  *key* (`evestack-pgdata`), which is the same string in every evestack project on the machine,
  not the real volume (`<project>_evestack-pgdata`). On a page whose whole doctrine is "remove by
  exact name", the command offered as the exact-name step did not give one.
- **`--remove-orphans` does not catch a profile-gated container.** The page said it did. Measured
  on Compose v5.1.0: `docker compose down --remove-orphans` without `--profile dashboard` leaves
  the dashboard container, says nothing about it, and then cannot remove the network
  (*"Resource is still in use"*). Compose knows that service — it filtered it out — so it is not
  an orphan.
- **Section 5's greps match on the image column,** so `pgvector` matched every container running
  `pgvector/pgvector` regardless of owner, and the page closed with *"whatever these print,
  delete it by the exact name they printed."* Run on the development machine, the first grep
  printed a hand-started database belonging to no evestack project.
- **`157 MB unique` per extra sandbox template was off by ~2400x.** `docker system df -v` reports
  `SIZE 665MB / SHARED 665.3MB / UNIQUE 65.77kB`; the 157 MB was the eve base image's CONTENT
  SIZE, a different image in a different column. It over-stated the payoff of a destructive
  cleanup.
- **`upgrading.mdx` still listed `/charts` as a page that survives the EV001 downgrade** — the
  exact claim correction #8 above removed from `app/api/health/route.ts`. The route's `available`
  list has four entries and `app/charts/page.tsx` calls `notFound()` in production. The fix
  landed in the code and not in the doc that repeats it, which is how a corrected error comes
  back.

**Contract 16's blind spot is wider than round 3 recorded.** Round 3 found that root-level files
(`./CHANGELOG.md`, `./LICENSE`) are unchecked. The same `PATH_PATTERN` also cannot see the most
common form of pointing a reader somewhere — a link from one docs page to another:

```
const PATH_PATTERN =
  /(?<![A-Za-z0-9._/-])((?:docs|packages|contract|templates|registry|scripts|\.github)\/…\.[a-z]{2,4})\b/g;
```

`](/docs/local-setup#…)` fails it twice: a `/` immediately precedes `docs`, and there is no file
extension. Proven by mutation on the page this lane was editing — `/docs/local-setup` changed to
`/docs/local-setup-NOPE` and `node contract/run.mjs` still reported
**`PASS docs/every-documented-path-exists 79 assertions`**. There are **61** such links across
`docs/`, resolving to 124 distinct targets, and none of them is covered. All 61 currently resolve
— checked by hand this round, once, which is exactly the guarantee a contract is supposed to
replace.

Three open items this lane could not fix, because they are code:

- **`docs/troubleshooting.mdx` and `templates/default/scripts/verify.mjs` disagree about how many
  source-root markers there are, on the same branch.** The doc was corrected to three (`.git`,
  `pnpm-workspace.yaml`, a `package.json` with `workspaces`) by `15e7c3b`; `8528cd4` then wrote
  the new fence check with `MARKERS = [".git", "pnpm-workspace.yaml"]` and a comment restating
  the two-marker version the doc had just fixed. Measured on a `packages/my-agent` under an
  npm-workspace root holding an `.npmrc` with a token: verify's walk returns `null` and warns
  *"no `.git` here or above… will walk to your home directory"* with the fix `git init`, while
  eve's walk stops at the workspace root — the directory whose `.npmrc` is the one that gets
  copied. So the new credential check misses npm and yarn workspaces, and the remediation it
  prints is the one thing the docs say not to do there. `docs/` now carries a warning and a
  by-hand one-liner; the walk itself needs the third marker.
- **`docs/upgrading.mdx`'s dashboard-upgrade steps cannot succeed today.** They pin `0.4.0`;
  a manifest request for it returns HTTP 404 and the published tags are
  `["0.1.0","latest","0.2.0","0.3.0","0.3.1"]`. `README.md` says so, `upgrading.mdx` did not. A
  warning has been added, but the real fix is task 29 — cut the release.

## A note on method

Where a finding says "measured", it was. Where it says "inferred", treat it as a hypothesis —
that distinction cost me six corrections and it is the thing I would most want a second reviewer
to be ruthless about. Several agents caught their own bugs before committing and said so; that
is the standard the work was held to, and it should apply to this handoff too.
