# fix-plan.md — everything the cape-town-v1 stranger test surfaced

Source evidence: `.context/cape-town/findings.md`, `claims-ledger.md`, `diary.md`, `verdict.md`.

## Rules for every agent

1. **You are in your own git worktree.** Edit freely. **Do not push. Do not open a PR. Do not
   merge.** Commit inside your worktree if you like; integration is handled outside.
2. **Stay in your lane.** File ownership is listed per workstream. If a fix seems to require
   touching another lane's files, write it in your report instead of doing it.
3. **Copy strings are owned by W4 alone.** If you are not W4, do not reword user-facing prose,
   numbers, or log strings — even in your own package. Report it to W4 instead.
4. **npm is not reachable normally on this machine.** Use
   `NPM_CONFIG_USERCONFIG=/Users/sammytourani/evestack-stranger-test/npmrc` for any install.
   That points at `registry.npmmirror.com`, a full public-npm mirror.
5. **A live reproduction stack exists** at `~/evestack-stranger-test/cold/my-agent`
   (agent :2000, dashboard :4000, Postgres :5433, user `evestack`, password in `.env.local`,
   provider Ollama/qwen3). It has 12 runs, 1 memory, 565 spans, and one deliberately stranded
   run `wrun_01KZN0EEQDSCPHQM5YHCRQYM6P`. Use it. Do not delete it.
6. **Run `node contract/run.mjs`** before reporting. It has a per-contract assertion floor;
   dropping below fails. Also run whatever package tests you touch.
7. **Distinguish proven from unproven.** Items are tagged `[PROVEN]`, `[LIKELY]` or
   `[UNPROVEN — INVESTIGATE FIRST]`. Do not "fix" an `UNPROVEN` item until you have confirmed
   the behaviour is actually wrong. A fix for a non-bug is worse than no fix.
8. Report: what you changed, what you proved, what you chose not to do and why.

---

# W1 — `evestack doctor`

**Owns:** `packages/evestack-cli/**`

- **1.1 `[PROVEN]` doctor never loads `.env.local`, so it is dead on a fresh project.**
  `verify` prints "Everything works." and `doctor` then fails `password authentication failed
  for user "evestack"` against the same database, seconds later. Both generated files carry the
  same password; Postgres accepts it. The failing path prints host `localhost`, the working
  path `127.0.0.1`, so it is falling back to a built-in default connection string.
  `WORKFLOW_POSTGRES_URL=... npx evestack doctor` works perfectly. Every other command
  (`status`, `verify`, `open`, `tour`) resolves the project and its env correctly — make
  `doctor` do whatever they do.
- **1.2 `[PROVEN]` doctor has no project awareness.** Run from a non-evestack directory,
  `status` / `verify` / `open` / `tour` all print "This is not an evestack project." with the
  fix. `doctor` prints the Postgres auth error instead. It should participate in the same
  project detection.
- **1.3 `[PROVEN]` the remediation it suggests is wrong for the failure it hit.** It prints
  "Set WORKFLOW_POSTGRES_URL, or start one: `docker compose up -d postgres`" on an auth
  failure, when Postgres is up and healthy. Distinguish unreachable (ECONNREFUSED / DNS) from
  reachable-but-rejected (Postgres `28P01` / `28000`) and from wrong-database, and suggest the
  matching fix. A stranger who follows the current advice learns nothing.
- **1.4 `[UNPROVEN]` the "prints the SQL" half of the README claim was never exercised.**
  `doctor --sql` against a stranded run returned "Nothing to remediate: no job is both dead and
  blocking a live run", because an agent restart had already routed around the dead job. Build
  a fixture that reliably produces a job that is *both dead and blocking*, confirm the SQL is
  emitted and is correct, and make sure `--sql` output is copy-pasteable. Coordinate with W7,
  who owns the test fixture; you own the command behaviour.
- **1.5** While you are in here: confirm exit codes stay as documented (`0` clean, `1` fault,
  `2` could not look). They were correct in testing — do not regress them.

---

# W2 — dashboard: session ↔ span linkage

**Owns:** `packages/dashboard/**` — session detail, traces list, trace detail, and the span
queries behind them. **Do not touch** fleet/overview code (that is W3).

- **2.1 `[PROVEN]` the session page and the trace page disagree about the same session.**
  `/sessions/<id>` says "No spans on any of the 1 runs", `TOOLS OFFERED / CALLED 14/—`,
  "No transcript for this turn", and "none were exported for this run".
  `/traces/<id>` for the *identical* id renders the full waterfall, 2 model calls, and the tool
  call with `ARGUMENTS {"content":"quokka-orbit-9","tags":[]}` and `RESULT {"saved":true,"id":1}`.
  **Root cause, from Postgres:** the twelve session-resolved spans carry
  `resolved_session_id = wrun_01KZMZMV6C5QRYHBMBPVPE7Q05` (correct) and
  `resolved_turn_id = 'turn_0'` (a literal string), while the session page's turn card is keyed
  on the turn's workflow run id `wrun_01KZMZMVCNDMRM3XFZE1TCVQHF`. The two never join. The
  trace page even prints `turn turn_0` on screen.
  Fixing this join should restore, on the session page: the transcript, the tool count, time to
  first token, time per output chunk, and tool arguments/results.
- **2.2 `[PROVEN]` three different span counts for one session, one click apart.**
  `/traces` list: `SPANS 12`. `/traces/<id>`: `SPANS 90`. `/sessions/<id>`: none.
  Both trace numbers are defensible (session-attributed spans vs spans in the trace) but they
  share the label `SPANS`. Disambiguate the labels so the same word never means two things.
- **2.3** Add regression coverage so a session with spans can never again render as a session
  without spans. A test that asserts "if `/traces/<id>` reports N tool calls, `/sessions/<id>`
  reports the same N" would have caught this.
- **2.4 `[PROVEN, minor]` `/sessions` shows `environment` as `—` on every row** and nothing
  explains what would populate it. Decide whether the scaffold should set it, the column should
  be hidden when universally empty, or the dash should be explained. Report to W4 if the answer
  is copy.

---

# W3 — dashboard: fleet health honesty

**Owns:** `packages/dashboard/**` — `/api/fleet`, the Overview tiles and banner, and wedge
detection. **Do not touch** session/trace pages (that is W2).

- **3.1 `[UNPROVEN — INVESTIGATE FIRST]` the fleet panel may report calm while blind.**
  Observed: with the agent `kill -9`'d mid-turn and one run genuinely stranded,
  `/api/fleet` returned `{"wedged":0,"idle":0,"awaitingHuman":0,"unknown":0,"entries":[],
  "checked":0,"unchecked":0}` and Overview showed `Failure rate 0%` with **no banner**.
  `evestack doctor` found the stranded run instantly.
  **But** `/api/fleet` returned `checked: 0` at *every* point in the session including when
  perfectly healthy, and `doctor --help` documents `--idle` default 30 minutes before a quiet
  session is worth probing; the oldest session was 21 minutes old. So the benign reading is
  "nothing was old enough to probe yet".
  **Your first job is to determine which it is, from the source.** Does dashboard wedge
  detection ever fire? Is there an idle threshold, and what is it? Only then fix.
- **3.2 `[PROVEN, regardless of 3.1]` `checked: 0` with `unknown: 0` is indistinguishable from
  "checked everything, all clear".** The endpoint already carries an `unknown` field and leaves
  it at zero. A caller cannot tell "healthy" from "not looked at". Make the distinction
  explicit in the payload and visible in the UI — a user whose agent just died should not see
  an unqualified `Failure rate 0%` and no banner.
- **3.3 `[PROVEN]` a killed turn leaves a permanently-running row.**
  `wrun_01KZN0EEQDSCPHQM5YHCRQYM6P` is still `status=running, completed_at=null` twenty minutes
  and one agent restart later. `doctor` explains why and calls it expected: "boot recovery does
  not repair the dead row, it routes around it." The engine behaviour may be correct and
  upstream. **The presentation is the problem:** `/sessions` accumulates phantom open runs
  forever, and the failure-rate tile counts none of them as failures, so a crashed agent makes
  the dashboard look *better*. Decide how a stalled run should read in the UI.
- **3.4** The README's screenshot alt-text advertises a banner reading "8 sessions wedged — a
  turn started and never finished, nothing in eve will notice or retry it". Confirm that banner
  can actually fire, and add a test that proves it.

---

# W4 — copy, numbers and doc contradictions

**Owns, repo-wide, for user-facing prose/numbers/log strings:** `README.md`, `docs/**`,
`packages/create-evestack/README.md`, `packages/website/**`, and copy-only strings anywhere
else (including the dashboard `/integrations` page and the composio package's log line).
Do not change logic.

- **4.1 `[PROVEN]` the scaffolder asks four questions; two docs say two.**
  The CLI prints `step 1 of 4` … `step 4 of 4` (Where / Model / Tools / Bring it up).
  `README.md:30` and `docs/cli.mdx:53` say four and are right. **`docs/quickstart.mdx:24` and
  `packages/create-evestack/README.md` say two and are wrong.** Neither mentions step 4 exists.
- **4.2 `[PROVEN]` README "nothing left to paste" vs quickstart's four manual commands.**
  Both are true, under opposite answers to step 4 — which the quickstart never tells you about.
  Make the branch explicit in both places. This is the single most confusing thing for a
  first-timer: the two front doors describe different products.
- **4.3 `[PROVEN]` the dashboard pull has three published sizes.** The installer's own step-4
  prompt says `(~200 MB)`; `docs/cli.mdx:50` says "200 MB"; `docs/quickstart.mdx:116` and
  `docs/self-hosting.mdx:329` say "~204 MB compressed"; **`packages/create-evestack/README.md`
  says "~400 MB"**, roughly double. Verify the real compressed size of
  `ghcr.io/sammytourani/evestack-dashboard:0.3.1` and use one number everywhere.
- **4.4 `[PROVEN]` the Composio toolkit count has three values across seven surfaces.**
  `1,070`: site hero, site §03, `README.md:73`, and the installer's step-3 prompt.
  `1,000+`: `packages/create-evestack/README.md`, and the dashboard `/integrations` page.
  `1000+`: the agent's runtime log line from the composio package.
  Pick one, source it, and make the product and the marketing agree.
- **4.5 `[PROVEN]` the landing page cannot decide how many commands this takes.**
  "Running in four steps" (§09 heading), "Five commands, with their real receipts" (§09
  subhead), "prints the three commands that finish the job" (§01), "npx evestack create, then
  four commands" (compare table), and the footer "Five commands, and it's running on your
  machine." The npm README's own block is six commands; the GitHub README implies one.
- **4.6 `[PROVEN]` the site's "Verified numbers" block cites FINDINGS.md and never links it.**
  "one real user message, measured in Postgres — see FINDINGS.md". It is at the repo root and
  the page never says where.
- **4.7 `[PROVEN]` the installer's finish diagram is wrong on the Ollama path.**
  It draws `└─→ ollama qwen3 — the only thing that leaves this machine`. Ollama is a local
  process on `127.0.0.1:11434`; on that path **nothing leaves the machine** — confirmed, zero
  non-loopback sockets. The line is right for OpenAI/Anthropic and wrong for the free option,
  and it undersells the product's own headline claim at the exact moment a new user reads it.
  The string lives in `packages/create-evestack` source — coordinate with W5, who owns that
  file's logic; you own the wording.
- **4.8 `[LIKELY]` the website presents ports as fixed** (`dashboard:4000`, `agent:2000`,
  `Postgres:5433`) while the docs correctly say they float to the first free port. Minor, but
  it is the same class of drift.
- **4.9** Sanity-check the website for any surviving "tested against every eve release since
  0.29.5"-style support-matrix claim. I found none in `README.md` or `docs/` — the nearest is
  `docs/registry.mdx:40`, which is one registry verification, not a support matrix. Confirm the
  site does not overstate it either.

---

# W5 — scaffolder UX (`create-evestack`)

**Owns:** `packages/create-evestack/**` **except** `README.md` (W4 owns that) and except the
wording of the finish diagram (W4 owns wording; you own the code that emits it).

- **5.1 `[PROVEN]` `npx evestack create` prints nothing at all for 2.5 minutes when the
  registry is slow or unreachable, then fails.** No spinner, no "resolving", no hint. On a
  filtered or slow network a stranger has literally nothing to go on. Emit progress during
  package resolution, and after a threshold say what it is waiting on and what would cause it.
- **5.2 `[PROVEN]` pressing Enter on an empty answer at `? Choose 1, 2 or 3:` silently selects
  option 1 (OpenAI)** and proceeds to ask for an `OPENAI_API_KEY`. It should either state the
  default in the prompt or re-ask. Silent defaulting on a choice that determines the whole
  provider path is the wrong behaviour.
- **5.3** Emit the finish-diagram line correctly per provider (see 4.7) — take the wording
  from W4.
- **5.4 `[UNPROVEN]` verify the documented non-TTY behaviour.** `docs/quickstart.mdx:26` says
  "the scaffolder never hangs waiting on input it isn't going to get" and `docs/cli.mdx:50`
  says `--yes` is "triggered automatically when stdin isn't a TTY". `docs/cli.mdx:88-94`
  records that this exact path once exited `0` having created nothing. Confirm it still holds,
  including the `npx`-shaped staging directory case described there.
- **5.5 `[UNPROVEN]` port selection.** A second scaffold correctly took 2001 / 5434 / 4001 while
  the first ran, so scaffold-time selection works. The documented *runtime* behaviour — "no
  auto-increment", a taken port yields a plain `EADDRINUSE` — was never exercised. Confirm.

---

# W6 — template noise and defaults

**Owns:** `templates/default/**`

- **6.1 `[PROVEN]` a scary-looking security warning on every boot.**
  ```
  node_modules/@vercel/otel/dist/node/index.js [EVAL] Use of direct `eval` function is
  strongly discouraged as it poses security risks and may cause issues with minification.
  ```
  It is a bundler notice about a dependency, printed on first run and again on every rebuild.
  A stranger reading "poses security risks" during their first minute has no way to know it is
  benign. Suppress it or explain it at the point of emission.
- **6.2 `[PROVEN]` unexplained SDK noise, twice per run.**
  `[workflow-sdk] deploymentId: 'latest' has no effect in this world and was ignored. It is
  only supported by worlds with atomic deployments, such as Vercel.` followed by
  `currentDeploymentId postgres`. Self-hosted is the only mode this template supports, so this
  fires every time and means nothing to the reader.
- **6.3 `[PROVEN]` the sandbox story contradicts itself out of the box.** The agent builds a
  real sandbox template on boot — `eve: initialized 1 sandbox template (0 reused, 1 built)`,
  committing an image — while `/sandboxes` says "Sandbox visibility is off". So containers are
  being created that the dashboard tells you it cannot show. The security default is right;
  the mismatch between "we are building sandboxes" and "sandboxes are off" is not.
- **6.4 `[PROVEN, minor]` nothing sets `environment`,** so every session row reads `—`.
  Coordinate with W2, who owns the column's presentation.
- **6.5 `[PROVEN]` the gated-tool demo does not work on the recommended free model.**
  `/approvals` says "The template ships `forget` behind `approval: always()` if you want
  something to try it with." On the $0 Ollama/qwen3 path the product also recommends, qwen3
  would not call it — twice, including when told "Call the forget tool right now with id=1. Do
  not reply with text." Both turns completed with zero tool spans. **This is not a gate bug:**
  `gen_ai.tool.definitions` on the model-call span does contain `forget`, so the tool is
  offered. It is a model limitation. But the two things the product recommends to a newcomer —
  the free model and the approvals demo — do not compose, which makes claim 10 unreachable on
  the $0 path. Find a deterministic way for a newcomer to see an approval park and resolve.

---

# W7 — the missing tests

**Owns:** `contract/**` and package test directories. Additive; low conflict.

Everything here is a claim the product makes that nothing currently proves. Several are marked
CAN'T TELL in the ledger purely because there was no way to exercise them.

- **7.1** A wedged-job fixture that produces a job **both dead and blocking a live run**, so
  `doctor --sql` actually emits remediation SQL (W1.4 depends on this).
- **7.2** `unpriced` (claim 5). `/costs` states the rule — "A model missing from it is reported
  as unpriced rather than free — a monitor fires when any unpriced model runs" — and Ollama is
  correctly special-cased as "a **real** $0.00 rather than a missing price". The unpriced
  branch itself is unexercised. Drive a model absent from the 209-entry `lib/pricing.ts`
  catalog and assert `unpriced`, never a silent `$0.00`, and that the monitor fires.
- **7.3** Browser control (claim 9): start, stream, send a follow-up, **cancel**, from the
  browser. Note `README.md:180-183` warns cancellation is cooperative and the model keeps
  streaming for ~90s — the test should encode that reality, not a stop button that assumes
  silence.
- **7.4** Approvals end to end (claim 10), including **what the audit log records as `who`**.
  `/approvals` says "eve's protocol carries no identity, so this is the only place that records
  who" — assert it names something meaningful, not just "the installation".
- **7.5** Schedules (claim 13): a fire, its history row, and **pause from the UI with no
  redeploy**. Also the documented quiet-hour `HEARTBEAT_OK` behaviour — confirm whether a user
  gets spammed hourly.
- **7.6** Evals (claim 14): promote a session that **went wrong**, and actually run the
  generated file. `README`/plan note this is the one tier CI never runs. It is free on Ollama,
  so there is no cost excuse.
- **7.7** `evestack tour` — **never run in-project during this test, and it is a known
  regression site** (commit `920a439`, "tour billed without asking"). Assert it does not spend
  money without asking, and that it teaches the product.
- **7.8** `evestack open` — never exercised in-project. Assert it prints the credentials and
  opens the dashboard (plan 3.4).
- **7.9** The dev-path bind address (ledger row 28). `docs/quickstart.mdx:160-162` documents
  `pnpm --filter @evestack/dashboard dev`. I observed the Aug 6 leftover `next start` bound
  `*:4000` and answering from the LAN address, but **never ran the documented dev command** —
  I reported that as a finding when it was an inference. Run it, check `lsof -nP -iTCP:4000`,
  and if it binds all interfaces decide whether to bind loopback by default. The Docker path is
  correct already (`127.0.0.1:4000`, `127.0.0.1:5433`, all refused from the LAN address).
- **7.10** Regression test for W2.1: if `/traces/<id>` reports N tool calls for a session,
  `/sessions/<id>` must report N too.
- **7.11** Regression test for the "reports calm while blind" class: a health endpoint that
  could not check must never present as all-clear.

---

# W8 — investigations (read-only, no product changes)

**Owns:** nothing. Produces a written report only.

- **8.1** eve's dev watcher watches the user's **home directory** and mangles the path:
  ```
  [eve:dev] change detected (5 events: unlink /Users/sammytourani/Users/sammytourani/.npmrc,
  add /Users/sammytourani/.gemrc, add /Users/sammytourani/.npmrc, ...), rebuilding authored artifacts...
  ```
  Note the doubled `/Users/sammytourani/Users/sammytourani/`. Unrelated dotfile changes
  triggered a project rebuild. This looks like upstream `eve`, not evestack. Reproduce
  minimally, determine whether evestack can scope the watcher from its side, and draft an
  upstream issue if it cannot.
- **8.2** Whether the dashboard's wedge detection can fire at all, and on what threshold
  (feeds W3.1). If there is an idle gate, is it documented anywhere? It is not in `docs/` as
  far as I could find.
- **8.3** macOS and Node 26. `README.md:134` says macOS is untested by CI and `README.md:125`
  says Node 24 is the only major CI installs. This entire test ran on macOS 26.5.2 / Node 26
  and nothing platform-specific broke. Assess what it would cost to add a macOS CI job, given
  the README already commits to naming what is and is not tested.
- **8.4** Disk footprint for the docs. The full stack after one session: Docker images grew
  13.88 GB → 15.89 GB, plus 1.5 GB of volumes, including a committed sandbox template image.
  `docs` currently gives no figure for what running this actually costs on disk.
