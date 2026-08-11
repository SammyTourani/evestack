# findings.md — cape-town-v1 stranger test

Format: `[SEVERITY] where — what I did — expected — actual`

Status: **Parts 0, 1 complete. Part 2 onward blocked** (see BLOCKER-ENV below — environmental,
not a product defect). Everything here is doc-level, found before installing anything.

---

## CORRECTION — "`eve eval` is broken" was my own wedged agent, and I escalated it to a blocker

The evals were never broken. **The shipped suite runs green on a freshly scaffolded project on
the $0 Ollama path** — four clean scaffolds, six runs, five green:

```
EVALS 4 · smoke 1/1 · deny-survives 4/4 · sandbox 3/3 · memory 5/5
Results: 4 passed (4 total)   Gates: 13 passed   Completed in 40.2s
```

The reporting run left an artifact, and I verified all of it directly:

```
target.kind : remote                     <- --url mode, not a fresh scaffold
target.url  : http://127.0.0.1:2000/     <- the long-lived agent
started     : 06:05:48.742
completed   : 06:06:18.777               <- exactly 30.035s
eval        : smoke failed | Channel handler failed.
```

Three things make it conclusive:

1. `COMMAND_HOOK_READY_TIMEOUT_MS = 3e4` in eve's `workflow-runtime.js` — 30s, the bound on
   waiting for the session workflow to publish its command inbox hook. The HTTP layer accepted
   the request and **the session workflow never started.**
2. `Channel handler failed.` is a **generic mask**, not a diagnosis: `channel-dispatch.js`
   catches any throw and returns `{error:"Channel handler failed.", errorId, ok:false}` with a
   500. The real error goes only to the agent's own log.
3. `:2000` is the agent **I `kill -9`'d during Part 8A**, which `evestack doctor` had already
   reported as "1 run stranded behind a job that can never be claimed". Restarting it healed the
   problem — the identical eval then passed in 6.0 seconds.

**The auth hypothesis is disproven, not merely unconfirmed.** `eve dev` grants via `localDev()`,
so Basic never applies. On a *built* server it does, and it fails fast with a clear
`401 {"code":"unauthorized"}` — nothing resembling a 30-second `Channel handler failed`.

**How the error happened, because the chain matters more than the conclusion.** My own 8A test
deliberately wedged that agent. A later agent ran evals against that same damaged stack. It
reported the tier broken. I escalated it to a release blocker and wrote it into `decisions.md`
as D2 — without asking why an eval was being run against the stack I had personally sabotaged
two hours earlier. I had even written, in the integration plan, that this stack was "no longer
trustworthy as a measurement surface." I just did not apply my own warning backwards to a
finding I had already accepted.

**Claim 14 is TRUE**, not FALSE: the shipped evals run, and a promoted eval runs. The one part
still unverified is promoting a session that genuinely *went wrong*, because nothing on the $0
path has failed on its own.

### What actually is wrong — two real defects, found while disproving the first

- **`npx eve eval` refuses to run whenever the agent is running.** On a clean scaffold with
  `npm run dev` up — which is exactly the state the quickstart leaves you in — it exits 1 with
  "A dev server is already running for this eve agent." `--url` works, and the project already
  records `EVESTACK_AGENT_PORT`, so nothing needed to be asked of the user.
- **`eve eval` has no preflight.** It bypasses `scripts/dev.mjs`, so a stopped Postgres or a
  missing schema produce exactly the two unreadable errors that script exists to prevent, and
  nothing checked for `nomic-embed-text`, which `memory.eval.ts` needs for 5 of the 13 gates.

Both now fixed behind `npm run eval`. Also found live: `CONTRIBUTING.md`'s Setup was missing
`pnpm -r --if-present run build`, without which `@evestack/budget` is unbuilt and the template
cannot bundle at all.

### A bug the fix introduced, caught by the agent that wrote it

Moving `stop()` into `checks.mjs` hit `export { C, c, g } from "./ui.mjs"` — which exports the
names without binding them locally, so `stop()` threw `ReferenceError: C is not defined`
**on the error path only**, invisible to every green run. It was found, fixed, and a test now
exists specifically so that path can go red. Worth recording as the pattern: the dangerous edit
is the one that only breaks the code that runs when something else has already gone wrong.

## SECURITY — highest severity finding in this test

**[BROKEN] The scaffolded project silently copies your `~/.npmrc`, credentials and all, into a
directory you do not know exists.**

Verified by me directly on the live stack, not just reported:

```
$ find ~/evestack-stranger-test/cold/my-agent/.eve -name .npmrc
.eve/dev-runtime/snapshots/msmr6z2i-…/source/.npmrc
.eve/dev-runtime/snapshots/msmrfqa9-…/source/.npmrc
.eve/dev-runtime/snapshots/msmqruky-…/source/.npmrc

$ shasum ~/.npmrc            → 20c0dcf588743f5857f42729af07778bb8be2f0b
   all three copies          → 20c0dcf588743f5857f42729af07778bb8be2f0b
```

Byte-identical. On this machine that file carries a registry `_auth` credential for a private
company npm mirror. Three copies of it now sit inside a scaffolded agent project.

**Root cause chain, every link proven:**

1. `create-evestack` never runs `git init`, and no doc tells you to.
2. eve's `resolveDevelopmentSourceRoot` walks up looking for `.git` / `pnpm-workspace.yaml`,
   finds the user's **dotfiles repo in `$HOME`**, and sets the dev source root to the home
   directory.
3. `WORKSPACE_METADATA_FILE_NAMES` includes **`.npmrc`**, so `~/.npmrc` becomes both a watch
   target and a **copy** target.
4. Separately, `resolveLockfileSearchDirectories` adds five non-existent lockfile paths per
   ancestor up to `$HOME`; chokidar watches the parent of a non-existent target, so it ends up
   watching `$HOME`.
5. The doubled path I saw in the log (`/Users/…/Users/…/.npmrc`) is a genuine **chokidar 5.0.0**
   bug, reachable only because a symlink became a top-level watch target.

**What limits the blast radius:** `.eve/` is in the generated `.gitignore`, so it will not be
committed, and nothing leaves the machine. This is credential *duplication*, not exfiltration.

**The fix is one line on evestack's side: `git init` in the scaffolder.** Proven — with a
`.git` at the app root the source root collapses to the project, watch targets drop from 20 to
5 (all in-project), and nothing from `$HOME` is copied. That single change also kills the
home-directory rebuild noise and the doubled-path log line. Still reproducible on eve `0.31.3`,
so it is not fixed upstream; an upstream issue is drafted in `investigations.md` and is not a
duplicate of anything open on `vercel/eve`.

This started as a cosmetic "the dev watcher logs a weird path" note. It is the most serious
thing in this report.

---

## CORRECTION — I generalised "qwen3 won't call the gated tool" from a sample of two

I reported that qwen3 "would not call" the gated `forget` tool, based on two failed attempts,
and filed it as the free model and the approvals demo not composing. Measured properly across
repeated cold sessions:

- my exact prompt — **5 of 8 parked**, 3 answered in prose
- the same prompt with the `reason` argument supplied — **5 of 5 parked**

So it calls the tool roughly two times in three, and both of my attempts landed in the failing
third. The friction is real but narrower than I described: `forget` takes a **required free-text
`reason`**, and the failures are the runs where the model had to invent one the user's sentence
never supplied. Still a model limitation rather than a gate bug — but "won't call it" was a
categorical claim built on n=2, and it was wrong.

Making `reason` optional was considered and rejected on good grounds: that reason is what the
human approving actually reads, so buying one retry costs unjustified delete requests forever.
eve exposes no `toolChoice`, so nothing can force the call.

## RESOLVED — claim 10: the audit log names the installation, not a person

Previously CAN'T TELL because nothing could park an approval on the $0 path. A new
`npm run demo:approval` parks reliably (6 of 6), and I read the resulting row directly:

```
tool_name | option_id | approver | approver_via | remote_addr | decided_at
forget    | approve   | evestack | basic        | 172.23.0.1  | 2026-08-10 06:09:23.86+00
```

The schema is better than the claim needed — `approver`, `approver_via`, `remote_addr`,
`user_agent`, `request_id`, `turn_id`, and a genuinely timezone-aware `decided_at`.

**But `approver` is `evestack`, the single `EVESTACK_AUTH_USER` the scaffolder generates.** There
is one shared credential per installation, so "who decided what" resolves to *the installation,
plus a network address* — you could tell two machines apart, never two people sharing the
password. The dashboard's own copy is upfront about the cause: "eve's protocol carries no
identity, so this is the only place that records who."

Verdict: **TRUE in mechanism, with the honest caveat that "who" is an installation.** That is
exactly the distinction the test plan was probing for, and the product does not oversell it.

## NEW `[PROVEN]` — `turn.completed` fires while an approval is still parked

So `completed` in the session list does not mean the turn finished. Found while building the
approvals demo. Affects how the sessions list and any completion-based metric should be read.

## NEW `[PROVEN]` — the sandbox fix has an unshipped half

`.env.example` now documents `EVESTACK_DOCKER_SOCKET`, but the **generated
`docker-compose.yml` has no socket mount and not even a commented-out one**, so a user who sets
the variable gets "Docker did not answer" rather than the container list. The documented path
cannot work as written.

## NEW `[PROVEN]` — the template's dynamic imports never did anything

`agent/schedules/heartbeat.ts` used dynamic imports for three channels with a comment claiming
it avoided loading unconfigured ones. eve registers every file under `agent/channels/`
regardless, so it saved nothing — and the build printed three `[INEFFECTIVE_DYNAMIC_IMPORT]`
warnings naming the template's own files.

## NEW `[PROVEN]` — the schema version counter is not a safe migration guard

The most consequential thing found in the whole batch, and nobody was looking for it. Two agents
reported contradictory states for the same bug; both were right, ninety minutes apart.

Sequence, all verified by me on the live database:

1. The trace agent migrated it to `spans v4` and installed a resolver that inherits
   `workflow.run.id`. I confirmed it: `resolved_turn_id` carried real run ids (29, 12, 8, 4
   spans) where every row had read `turn_0`.
2. The **old 0.3.1 dashboard container was still pointed at that database**, and on its next
   boot it did `CREATE OR REPLACE` and put the **old resolver back**.
3. Fresh spans arriving after that carry `turn_0` again — 14 of them now.

The database currently reports:

```
schema_version   spans v4          <- says migrated
resolve_span_ancestry()            <- is the OLD function
resolved_turn_id 'turn_0' × 14     <- the bug, live again
```

**The version counter says v4 while the function is v3 behaviour, so the migration will never
re-run.** The version gate believes it is already applied. Anyone who upgrades, then briefly
starts an older image — a rollback, a stale compose file, a second project pinned to an older
tag — is left permanently on the old resolver with a marker claiming otherwise, and no error.

The trace agent predicted the revert and called it "inherent to the version-counter scheme, not
new". That is right, and it is exactly why it deserves fixing rather than accepting: a
`CREATE OR REPLACE` from an older image should either be prevented, detected, or made to
decrement the marker. Right now the guard silently lies.

**This does not invalidate the trace fix** — that fix is correct and proven. It means the fix
cannot be trusted to stay applied.

## CORRECTION — the 2.5 minutes of silence was not the scaffolder's to fix

I filed "`npx evestack create` prints nothing for 2.5 minutes on a slow registry" against
`create-evestack`. Disproved by a real run: **the silence was `npx` resolving the `evestack`
package itself, before a single byte of evestack's code executes.** Nothing in that package can
fix it. It needs a sentence in the docs about what `npx` does before the wizard appears.

There *is* a real silent window inside their code — the dependency install — and that one is now
fixed: the install row escalates at 15s / 45s / 120s, naming the registry host it is actually
talking to (read from `<pm> config get registry`), and a network failure now prints a block that
names the host instead of a bare stack trace. Verified against an unroutable registry.

## NEW `[PROVEN]` — a dead stdin silently answered "yes" to a 200 MB download

Found by the scaffolder agent by accident, and it is the same defect class as the empty-Enter
one I reported, but worse. On a pty whose stdin dies mid-wizard, `confirm()` returns its
**default**, so the step-4 bring-up question answered *yes* on nobody's behalf: it started
containers and began a ~230 MB pull. The agent had to `docker compose down -v` a stack it never
asked for. Both action-taking confirms are now guarded by an explicit `closed()` check that can
distinguish "user pressed Enter" from "stdin hit EOF" — which nothing could do before, which is
why re-asking was unsafe to write in the first place.

## NEW `[PROVEN]` — `evestack attach` has the same credential leak, unfixed

`attach.mjs` does not create a `.git`, so **an attached project leaks `~/.npmrc` exactly as a
scaffolded one did.** The scaffolder fix does not cover it. Left unfixed deliberately: attach's
contract is "additive, never overwrites, prints an undo line for everything it writes", and
running `git init` inside someone's existing project may violate that. Needs a decision.

**The scaffolder fix itself is proven by controlled A/B**, same project, same eve 0.30.8:
with `.git` present, `find .eve -name .npmrc` returns nothing and the snapshot source is
project-only; delete `.git` and rerun, and one copy appears with sha1 `20c0dcf5…`, byte-identical
to the real file.

**Cleanup done:** I deleted every leaked copy under `~/evestack-stranger-test` — there were
**ten** by then, not the three I first found, because the other agents' test runs each produced
more. The real `~/.npmrc` is untouched.

## NEW `[PROVEN]` — `evestack attach` prints a false security warning

Found by the copy agent, verified by me in the main checkout. Needs an owner decision, not a
copy edit.

`packages/create-evestack/attach.mjs:63` sets `const MIN_EVE = "0.30.2"`, and its own doc
comment four lines above contradicts itself:

> "Below **0.30.2**, eve's `localDev()` matched an unanchored `/^127\./` against the
> attacker-controlled Host header, so `127.evil.com` obtained an unauthenticated principal.
> Fixed upstream in **0.30.0** and confirmed on 0.30.2"

Below 0.30.2 is vulnerable, *and* it was fixed in 0.30.0. Both cannot be true. Everything else
in the repo picks 0.30.0 — `SECURITY.md:183` says "**Pin `eve` `>=0.30.0`**",
`docs/support.mdx:122` uses 0.30.0, and all four published peer ranges say `>=0.30.0`. Only
`README.md:178` sides with the constant ("Vercel fixed it upstream in 0.30.0. Pin `^0.30.2` or
newer") — and it states both in one sentence.

The consequence, at `attach.mjs:388-393`: a user on eve **0.30.0 or 0.30.1** — versions where
this project's own SECURITY.md says the bug is fixed — is told

> "Below 0.30.2 eve's `localDev()` matched an unanchored `/^127\./` against the Host header, so
> `127.evil.com` got an unauthenticated principal. Upgrade before anything but your own laptop
> can reach this agent."

That asserts an exploitable auth bypass on versions that do not have one. Crying wolf about
authentication is corrosive in a project whose pitch is self-hosting.

**Recommended shape of the fix** (someone with the history should choose): keep 0.30.2 as a
conservative floor if that is genuinely the lowest version anyone verified, but change the
warning to say what is true — *"not verified below 0.30.2"* — and reserve the exploit language
for `< 0.30.0`, which is where SECURITY.md puts it.

---

## CORRECTION — my disk figures were wrong by 20×

I reported the stack used "~2 GB of images and 1.5 GB of volume". The images figure holds
(~2.0 GB attributable, matching the observed 2.01 GB delta). **The 1.457 GB volume was
`kind-control-plane`, an unrelated Kubernetes cluster that was already on the machine.** I read
`docker system df` totals without attributing them.

evestack's real volume cost is **68 MB per project empty, 78 MB after a light session**. Honest
planning numbers, measured:

| | |
|---|---|
| One project, API key | **≈ 2.4 GB** (2.0 GB images + 70 MB volume + 300 MB project dir) |
| One project, $0 Ollama path | **≈ 7.9 GB** (+5.5 GB for qwen3 and nomic-embed-text) |
| Each additional project | **≈ 0.5 GB** (own sandbox template 157 MB, own volume, own node_modules) |

Two growth items worth documenting: spans are 1.55 KB each and self-prune at 30 days, but the
`workflow` schema never prunes itself; and the per-project `eve-sandbox-template:*` image
(665 MB for the first, +157 MB each after) is **never cleaned up by anything** and is the third
largest item on disk. `docs/` gives no absolute disk figure anywhere.

Also corrected: the dashboard image is **231.3 MB amd64 / 228.2 MB arm64** compressed, measured
from the GHCR manifest. So all three published figures are wrong — "~200 MB" and "~204 MB" are
understatements, not just "~400 MB" being an overstatement.

---

## Blocked

**[BLOCKER-ENV] npm — ran `npx evestack create my-agent` on the 48 GB machine — a project
scaffolded — nothing at all: no output for 150s, then I interrupted it.**
Root cause is this machine, not evestack: `~/.npmrc` (generated by `ws-cli`, marked
"do not edit") pins the registry to Wealthsimple's mirror
`https://reposerver.w10external.com/repository/npm/` with `min-release-age=5`.
`create-evestack@0.9.1` was published **2 hours before this test started**, so the mirror
serves `dist-tags: {latest: 0.9.1}` with **zero versions available** — a 404 on the only
version it will admit exists. The corporate resolver (100.64.0.1) also blackholes
`registry.npmjs.org` entirely, and blocks it by raw IP too, so there is no `curl --resolve`
fallback. Public DNS (1.1.1.1 / 8.8.8.8) resolves it fine from this box, so it is a policy
block on the VPN path.
*Not a finding against the product. Recorded because it is why Parts 2–9 are empty.*

---

## BROKEN — feature doesn't work

**[BROKEN] `/api/fleet` and the Overview banner — killed the agent mid-turn, leaving one run
genuinely stranded — a wedged warning — `wedged: 0`, `Failure rate 0%`, and no banner at all.**

This looks like a return of the failure mode commit `920a439` calls *"panel reported calm while
blind"*.

Setup: started a long turn, `kill -9`'d the whole agent tree mid-generation, confirmed `:2000`
was down and the run row was left `status = running`.

What the dashboard said:

```
/api/fleet   {"ok":true,"wedged":0,"idle":0,"awaitingHuman":0,"unknown":0,
              "entries":[],"checked":0,"unchecked":0}
Overview     Turns 4 · Failure rate 0% · p95 20s · Spend $0.00     (no banner)
```

What `evestack doctor` said about the same database, at the same moment:

```
✗ FAULT  1 run is stranded behind a job that can never be claimed
         wrun_01KZN0EEQDSCPHQM5YHCRQYM6P  running  turnWorkflow  1 job  0 claimable
         Restart the agent to let boot recovery enqueue a fresh claimable job…
verdict  1 fault: 1 run is stranded behind a job that can never be claimed.
exit 1
```

**Severity caveat — read this before acting on it.** I could not prove this is a defect, and
the most likely explanation is benign. `/api/fleet` reported `"checked":0` at *every* point in
the session, including when the stack was perfectly healthy. `doctor --help` documents
`--idle=MINUTES … how long a session must be quiet before it is worth probing (default: 30)`.
My oldest open session was **21 minutes** old when I stopped. So the honest reading is that the
fleet probe has an idle threshold and **nothing had been quiet long enough to check yet** — in
which case `wedged: 0` is not a lie, it is "not looked at yet".

That makes this a **design finding rather than a confirmed bug**, and it is still worth fixing:

- The blind window is invisible. Nothing on the Overview says "no session is old enough to have
  been checked". A user whose agent just died sees `Failure rate 0%`, no banner, and a clean
  dashboard, and has no way to know the health signal simply has not run yet.
- The endpoint already carries an `unknown` field and leaves it at `0`. `checked: 0` with
  `unknown: 0` reads as "I checked and found nothing", not "I have not checked".
- `doctor` found the stranded run **instantly**, with no idle threshold in the way. So the
  information was available the whole time; only the dashboard waits.

The README's screenshot alt-text advertises the banner this would eventually produce —
*"8 sessions wedged — a turn started and never finished, nothing in eve will notice or retry
it"* — so the feature clearly exists. I never saw it fire, and I cannot say from the outside
whether that is the threshold working as designed or the detection not working at all.
**Someone who can read the source should settle which.**

### CORRECTION — the "permanent phantom run" claim was wrong

I wrote, without qualification, that the killed turn's row never recovered and that `/sessions`
would show it as running forever. **That is false.** I checked at 22:02 and it was still
`running`; it completed at **05:12:52 UTC**, about ten minutes later — 16m 42s after it was
killed. Boot recovery did repair it. Verified directly:

```
wrun_01KZN0EEQDSCPHQM5YHCRQYM6P | completed | started 04:56:10.226 | completed_at 05:12:52.799
```

I called a run permanently stranded after watching it for twenty minutes. It needed longer than
that, and I should have said "not recovered yet" rather than "never recovers". The remaining
`running` rows are `workflowEntry` and `sessionTimeoutWorkflow` for live sessions, which are
supposed to stay open.

**Also resolved: the wedge detection is not broken.** Two deliberate gates in
`packages/dashboard/lib/fleet.ts`: `IDLE_BEFORE_SUSPECT_MS = 30 * 60 * 1000` (line 144) and
`STUCK_TURN_MS = 60 * 60 * 1000` (line 234). A killed turn cannot be reported wedged before
T+60m, so `checked: 0` at 21 minutes was the correct answer. Confirmed empirically against the
shipped code with fixtures at 21m (`checked 0`), 45m (`checked 1, active 1`) and 90m
(**`wedged 1`** — the banner fires). `doctor` was instant because it asks a different question:
it reads the graphile_worker job queue for runs with zero claimable jobs, with no time gate and
no agent probe.

So my original instinct to downgrade this from "bug" to "design finding" was right, and the
design finding narrows to: **the 30/60-minute blind window is real, undocumented, and invisible
in the UI.**

### What that investigation *did* turn up — three real bugs, now fixed

- **`summarize()` never reported `active`**, so `wedged + idle + awaitingHuman + unknown` could
  come out *less than* `checked` with nothing accounting for the difference (measured:
  `checked: 2`, counters summing to 1).
- **The banner rendered nothing when an open turn was unjudged.**
- **The `unchecked` line was unreachable.** It sat behind an early return that only fired once
  something else was already wrong, so "N further sessions were not checked" could only appear
  when the sweep had *already* found a fault — exactly backwards from when you need it.

### NEW `[PROVEN]` — a crashed agent makes the failure rate look *better*

Found while investigating the above, and confirmed in source. `packages/dashboard/lib/metrics.ts:188`:

```sql
CASE WHEN outcome IN ('failed', 'no_model_call') THEN 1 ELSE 0 END
```

That average is the failure rate. A `running` or `wedged` turn matches neither arm, so it
scores **0 — a success** — while still counting in the denominator. Every stuck turn therefore
*lowers* the reported failure rate. This is the substance of what I was reaching for with the
"calm while blind" finding, and it is real, but it lives in the metric, not the fleet probe.

Deliberately not fixed yet: `TURN_FAILED_SQL` is shared by `/monitors`, `/api/metrics` and the
alert engine, and the comment above it says the alignment is intentional so those three "cannot
disagree about the error rate". Changing it is a product decision, not a side effect.

### NEW `[PROVEN]` — the same wrong-advice bug exists in `status`

`packages/evestack-cli/src/status.mjs:182` turns *every* connect failure into "not answering"
with the fix `docker compose up -d postgres`, including an auth rejection — the identical
mistake that made `doctor` unusable. Not fixed, because it changes user-facing rows.

### RESOLVED — claim 17's "prints the SQL" half is TRUE

Previously CAN'T TELL because I never saw SQL emitted. Proven on a purpose-built fixture with a
job that was both dead and blocking: `doctor --sql --probes=0` emitted 53 lines of pure SQL on
stdout, nothing on stderr, exit 1. Piping it into `psql` produced `BEGIN / UPDATE 1 / COMMIT /
pg_notify`, the job returned to `attempts=0, is_available=t`, and a re-run printed "Nothing to
remediate", exit 0. Both halves of the claim now hold.

Partial credit: `/sessions` is honest at row level — the stranded run shows outcome `running`
with duration `— *`. It is the aggregate health signal that goes quiet.

**And the fix path works.** Restarting the agent printed
`[world-postgres] Re-enqueued 9 active run(s) on startup`, exactly as the website promises.

---

**[BROKEN] `/sessions/[id]` vs `/traces/[id]` — opened the same session on both pages, same
minute, same Postgres — the same answer — one says the session has no spans, no transcript and
an unknown tool count; the other renders the full waterfall, the tool's arguments and its
result.**

One real message (`Remember this exact phrase: quokka-orbit-9.`), one turn, one tool call.

`/sessions/wrun_01KZMZMV6C5QRYHBMBPVPE7Q05` says:

```
No spans on any of the 1 runs; steps and costs are complete.
TOOLS OFFERED / CALLED     14/—
No spans were exported for this turn, so time to first chunk, time per output
chunk and the count of tool calls are unknown — not zero.
Transcript:  No transcript for this turn
Prompts, completions and tool payloads live only on spans, and none were
exported for this run.
```

`/traces/wrun_01KZMZMV6C5QRYHBMBPVPE7Q05` — same id — says:

```
SPANS 90 · TRACES 1 · MODEL CALLS 2 · TOOL CALLS 1 · TOKENS IN/OUT 6,383 / 363

Tool calls — what the agent ran, and what came back · 1
  TOOL remember   at (UTC) 04:42:21.864   took 332ms   turn turn_0
  ARGUMENTS  { "content": "quokka-orbit-9", "tags": [] }
  RESULT     { "saved": true, "id": 1 }

Model calls · 2  (full message history and responses rendered)
```

And `/traces` (the list) shows a third answer for that same session: **12 spans, 2 model calls,
1 tool call**.

So the dashboard tells you three different things about one session: 12 spans, 90 spans, and no
spans.

**Root cause, from its own Postgres.** `evestack.spans` holds 170 rows. Twelve of them resolve
to this session, and they carry:

```
resolved_session_id = wrun_01KZMZMV6C5QRYHBMBPVPE7Q05     <- correct
resolved_turn_id    = turn_0                              <- a literal string
```

But the turn on the session page is the workflow run `wrun_01KZMZMVCNDMRM3XFZE1TCVQHF`. The
turn card joins on that run id; the spans are keyed `turn_0`. The two never meet, so the entire
per-turn trace surface blanks out. The trace page even prints `turn turn_0` on screen, so the
mismatched key is visible in the UI.

**DEEPER ROOT CAUSE — this is not a dashboard join bug, it affects every exporting install.**

My diagnosis above ("the session page joins on the wrong key") was correct but shallow. The
actual cause is that **eve's two tracers disagree about what a turn id is**:

- `agent.turn.id` carries the turn's real `wrun_…`
- `ai.settings.context.eve.turn.id` carries `turn_0`, an ordinal

and only the second reaches an external OTLP collector — which is to say, **every install that
exports anything**. Counted on this database:

```
spans carrying agent.turn.id                    →   0
spans carrying ai.settings.context.eve.turn.id  →  22
```

Zero. The attribute the dashboard needed is on no span at all once you export. So this was never
a mis-typed join; the correct value simply never arrives, and the dashboard has to reconstruct
it. The fix inherits `workflow.run.id` down the trace and swaps it in where the declared turn id
is an alias, with guards so a real `wrun_` id is never overwritten. Measured across all 866 live
spans: **53 turn values changed, 0 session values changed, 0 nullness changes.**

**Verified the fix held on the live database** (the old 0.3.1 container is still pointed at it,
and did not revert the resolver): `resolved_turn_id` now carries real run ids — 29, 12, 8 and 4
spans across four turns — where every row previously read `turn_0`.

**The same bug class bit `environment`.** The fact table read only `eve.environment`, which on
this install is present on 4 spans, against 22 carrying `ai.settings.context.eve.environment`.
That is the `—` I filed separately as a minor cosmetic issue; it was the same two-vocabulary
defect. (W2's report said `eve.environment` was on zero spans — on this database it is on four,
which does not change the conclusion but is worth stating accurately.)

**Why this one matters most.** The session page is the page the README sells
("Sessions — every run on your machine … tool counts") and it is where a user goes when
something went wrong. On that page the product currently reports that it has no idea what the
agent did, while holding a complete record of it one click away.

Two mitigations worth stating, because they are real design merit:
- It **does not lie**. It says "unknown — **not zero**" and explains that payloads live on
  spans. A lesser dashboard would have rendered `0 tools` and looked fine.
- The 158 unattributed spans are correctly explained on `/traces` as plumbing, not loss.

---

**[BROKEN] `evestack doctor` — ran it on a freshly scaffolded, fully healthy stack, seconds
after `evestack verify` printed "Everything works." — a read-only forensics report — "password
authentication failed for user \"evestack\"".**

Two of the seven commands, same directory, same minute, flatly contradict each other:

```
$ npx evestack verify
      ✓ postgres    reachable at 127.0.0.1:5433
      ✓ schema      workflow tables exist
  Everything works.

$ npx evestack doctor
Cannot reach Postgres at postgres://evestack:***@localhost:5433/evestack
  password authentication failed for user "evestack"
Set WORKFLOW_POSTGRES_URL, or start one:  docker compose up -d postgres
```

`status` also connects fine and reports "postgres :5433 0 runs". So `doctor` is the only
command that cannot reach the database.

**It is not a credentials problem.** I checked both generated files and the server:

- the password inside `.env.local`'s `WORKFLOW_POSTGRES_URL` and `EVESTACK_DB_PASSWORD` in
  `.env` are **identical** (24 chars, same value)
- Postgres accepts that password directly (`psql -U evestack` inside the container, both
  values, both fine)

**Handing the URL to it explicitly fixes it completely:**

```
$ WORKFLOW_POSTGRES_URL="$(grep ^WORKFLOW_POSTGRES_URL= .env.local | cut -d= -f2-)" npx evestack doctor
  ▚ doctor   read-only · nothing here writes to your database
  postgres   postgres://evestack:***@127.0.0.1:5433/evestack
  ...
  Nothing is currently costing you a run.
```

So `doctor` never loads `.env.local`. Note the host in the two runs: the failing one says
**`localhost`**, the working one says **`127.0.0.1`** — the failing path is a built-in default
connection string, not the generated one. `doctor --help` confirms the intent: `--url` defaults
to `$WORKFLOW_POSTGRES_URL` then `$DATABASE_URL`, and nothing populates either from the env file
that `create` wrote.

This is the same failure mode `docs/quickstart.mdx:60-66` warns about for `db:bootstrap` —
*"that CLI loads `.env` through dotenv and never looks at `.env.local`"* — reproduced inside
evestack's own CLI, for the one command the README singles out by name.

Three things make it worse than a broken flag:

1. **The suggested fix is wrong.** "or start one: `docker compose up -d postgres`" — Postgres
   is already up and healthy. A stranger will run that, see nothing change, and conclude their
   database is broken while `verify` insists it is fine.
2. **It is the only command with no project awareness.** Run from `/tmp`, `status`, `verify`,
   `open` and `tour` all print a clear *"This is not an evestack project"* with the fix.
   `doctor` prints the same Postgres auth error instead — it never even looks for a project.
3. **It blocks the only claim about it.** Claim 17 ("Read-only forensics… Prints the SQL; never
   writes") cannot be exercised out of the box.

Credit where it is due: it does *not* lie about the failure. Exit code is `2`, which
`doctor --help` documents as "could not look". And once it connects, the report is the best
output in the whole CLI — it names `default_transaction_read_only=on` at the server, explains
why it reads `graphile_worker._private_jobs` rather than the public `jobs` view, and ends with
a plain-English verdict.

---

## WRONG — works, bad information

**[WRONG] docs/quickstart.mdx:24 and the npm README — ran the scaffolder and counted the
prompts — the two questions those docs promise — the CLI asks four, and says so on screen.**
Verified against the running binary, not just by reading. `npx evestack create my-agent`
prints:

```
  ▚ Where  · step 1 of 4
    → ~/evestack-stranger-test/cold/my-agent
  ▚ Model  · step 2 of 4
      1  OpenAI     gpt-5-mini        best tool-calling per dollar
      2  Anthropic  claude-sonnet-5   strong tool-calling
      3  Ollama     qwen3             local, $0, needs RAM headroom
? Choose 1, 2 or 3:
```

So **four is correct** and it is the quickstart and the npm README that are wrong:

- `README.md:30` — "Four questions — where, which model, tools, and whether to bring it up" ✅
- `docs/cli.mdx:53` — "Four questions, all asked before any work starts", enumerated ✅
- `docs/quickstart.mdx:24` — "You'll be asked for a model provider … and whether to enable
  Composio's one-click tool sign-in" ❌ (two)
- npm README — "asks for a model provider and (optionally) a Composio key" ❌ (two)

The quickstart is the page the website links as *the* getting-started path, and the npm README
is what you read on the package page before installing. Both undercount the prompts and neither
mentions step 4, "bring it up", which is the one that decides whether you have four more
commands to run afterwards. That is also why `README.md:33` ("nothing left to paste") and the
quickstart's four manual commands look like they describe different products — they are
describing opposite answers to a step-4 question the quickstart never tells you exists.

**[WRONG] README.md:30-33 vs docs/quickstart.mdx — compared the two descriptions of what
happens after `create` — the same install flow — they describe materially different products.**
README: answering yes to the last question "starts Postgres, creates the schema, pulls the
dashboard and then offers to start the agent, **so there is nothing left to paste**."
quickstart: never mentions that offer, and walks you through `docker compose up -d postgres`,
`npm run db:bootstrap`, `npm run dev`, `docker compose --profile dashboard up -d` by hand.
One says zero commands after `create`; the other says four. This is the single most important
thing a first-time user needs to know and the two docs disagree.

**[WRONG] npm README vs the installer itself — looked up how big the dashboard pull is — one
number — four surfaces, three numbers, and the biggest one is on the page you read first.**
- The running installer, step 4 of 4: `? Start Postgres, create the schema and pull the
  dashboard? (~200 MB) (Y/n)` — **this is the number the product tells you at the moment you
  decide**
- `docs/cli.mdx:50`: "nobody is there to say no to a 200 MB pull" ✅ agrees
- `docs/quickstart.mdx:116`, `docs/self-hosting.mdx:329`: "~204 MB compressed" — close enough
- npm README: "does not pull **~400 MB**" ❌ double the real figure

On a metered connection the npm README is the number you'd act on, and it is the one that is
wrong. Confirmed against the binary, not just by reading docs.

**[WRONG] npm README vs README.md:73 / website — compared the Composio toolkit count across
all three surfaces — one number — "1,070 toolkits" (site hero, site §03, GitHub README) vs
"1,000+ tools" (npm README).**
Small, but claim 15 in the ledger is specifically about the 1,070 figure, and the package page
a stranger installs from quotes a different one.

---

**[WRONG] The installer's finish diagram — chose Ollama, the $0 local path — an accurate
picture of what leaves the machine — it says the local model is "the only thing that leaves
this machine".**

```
  └─→ ollama qwen3 — the only thing that leaves this machine
```

Ollama is a local process on `127.0.0.1:11434`. On the path I picked, **nothing leaves the
machine at all** — I confirmed it: zero non-loopback connections from any node or docker
process, and every model span is `fetch POST http://127.0.0.1:11434/…`. The line is correct for
OpenAI and Anthropic and wrong for the third option, and it undersells the product's own
headline claim to the one user who has fully achieved it.

**[WRONG] `/integrations` — the toolkit count, on the page where you would act on it — one
number — a fourth different one.** "One browser flow signs your agent into **1,000+ apps**."
Full tally across surfaces: **1,070** on the site hero, site §03, the GitHub README, and the
installer's own step-3 prompt; **1,000+** on the npm README and this page; **1000+** in the
agent's runtime log. The marketing number and the product number disagree.

---

## CONFUSING — works, unclear

**[CONFUSING] `/traces` vs `/traces/[id]` — read the span count for one session on both — the
same count — 12 on the list, 90 on the detail.** Both are defensible (session-attributed spans
versus spans in the trace) and the detail page explains the distinction in prose, but the two
numbers sit one click apart with the same label, `SPANS`.

**[CONFUSING] Agent startup — read the log the docs tell you to watch — a clean boot — a
security warning about `eval`.**

```
node_modules/@vercel/otel/dist/node/index.js [EVAL] Use of direct `eval` function is
strongly discouraged as it poses security risks and may cause issues with minification.
```

It is a bundler notice about a dependency, printed on every boot and again on every rebuild.
A stranger reading "poses security risks" during first run has no way to know it is benign.

**[CONFUSING] `/sessions` — looked at my own runs — a value in every column — `environment`
and `tools called` are both `—` on every row.** `tools called` is the trace-linkage bug above.
`environment` appears to be simply unset by the scaffold, and nothing on the page says what
would set it.

---

## ROUGH — works, unpleasant

**[ROUGH] The gated-tool demo does not work on the recommended free model.** `/approvals` tells
you how to try it: *"The template ships `forget` behind `approval: always()` if you want
something to try it with."* On the $0 Ollama path the product also recommends, qwen3 would not
call it — twice, including when told *"Call the forget tool right now with id=1. Do not reply
with text."* Both turns completed with zero tool spans.

I checked this is not a product bug before reporting it: `gen_ai.tool.definitions` on the model
call span **does** contain `forget`, so the approval gate is not stripping the tool from what
the model is offered. It is a qwen3 limitation — the same model called `remember` unprompted
minutes earlier. But the effect is that the two things the product recommends to a newcomer,
the free model and the approvals demo, do not compose. Claim 10 is unreachable on the $0 path.

**[ROUGH] eve's dev watcher watches your home directory, and mangles the path.** Upstream eve
rather than evestack, but it is what a user sees:

```
[eve:dev] change detected (5 events: unlink /Users/sammytourani/Users/sammytourani/.npmrc,
add /Users/sammytourani/.gemrc, add /Users/sammytourani/.npmrc, add /Users/sammytourani/.yarnrc,
add /Users/sammytourani/.yarnrc.yml), rebuilding authored artifacts...
```

Unrelated dotfile changes triggered a project rebuild, and the first path is doubled.

---

**[CONFUSING] evestack.vercel.app — read the landing page top to bottom — a consistent count of
what I have to type — four different counts on one page.**
"Running in four steps" (§09 heading) / "Five commands, with their real receipts" (§09 subhead)
/ "prints the three commands that finish the job" (§01) / "npx evestack create, then four
commands" (compare table) / footer: "Five commands, and it's running on your machine."
The npm README's own setup block is six commands. The GitHub README implies one.

**[CONFUSING] evestack.vercel.app "Verified numbers" block — tried to check the cited source —
a link to FINDINGS.md — the block says "one real user message, measured in Postgres — see
FINDINGS.md" and FINDINGS.md is not linked anywhere on the page.**
It exists at the repo root, but the page never says that and never links it, so the one block
on the site that offers evidence is the one you can't follow up.

---

## Notes for the maintainer (not product findings)

**The test plan itself has drifted from the product in two places.**

1. **Claim 18 — "tested against every eve release since 0.29.5" — is not a claim the docs make
   any more.** Nothing in `README.md` or `docs/` says it. The closest is
   `docs/registry.mdx:40`: "That verification was run against eve 0.29.5. `templates/default`
   now pins `^0.30.8`" — which is a much narrower statement about one registry verification.
   Suggest deleting the row or rewording it to what the docs actually promise.

2. **The eve pin in the plan's machine notes checks out** — `templates/default/package.json`
   pins `"eve": "^0.30.8"`. But the plan says "0.31.3 has a known boot failure (PR #36)", while
   commit `3d318ce` ("The 0.31.3 blocker was our own probe, plus four more the hunt confirmed",
   #40) reads like that diagnosis was overturned. Worth re-checking before the next tester is
   told not to upgrade for that reason.

**The machine was not clean when I started.** Two processes from the Aug 6 round were still up:
an `eve dev` agent on :2000 **still answering HTTP 200 from `~/evestack-stranger/my-agent`, a
directory that no longer exists**, and a `next start` dashboard on :4000 served out of the repo
working tree. No evestack Postgres container or volume survived, so there was no data to lose,
and I stopped both trees to get a clean baseline. Left `ss-live-map` on :3000 alone.

**One early signal for claim 8C (security from outside), not yet a finding.** That leftover
:4000 dashboard was bound to `*:4000`, not loopback, and answered `401` when I curled it from
this machine's LAN address (192.168.1.183). The agent on :2000 was correctly loopback-only
(connection refused from the LAN address). That was the dev/`next start` path out of the repo,
**not** the Docker path a stranger gets, so it proves nothing yet — but it is the first thing
to check once the stack is up, because 8C calls a reachable port a BLOCKER.
