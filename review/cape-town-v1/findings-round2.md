# findings-round2.md — cape-town-v1 stranger test, second pass

Format: `[SEVERITY] where — what I did — expected — actual`

Sections run: **9D (upgrade), 9E (uninstall), 9C (from a clone), 8E (scale), 5.1–5.5 (visual /
mobile / dark / second engine / keyboard).** Nothing here repeats `findings.md`; where a round-1
finding was re-checked it is marked as such.

**Tree under test.** The worktree I was given was checked out at `464a85f` (= `main`), which does
**not** contain the schema work described in the brief. `cape-town-v1` is six commits ahead at
`c1a30c8`, and that is where `spans v4`, `facts v2` and the downgrade guard live
(`git show cape-town-v1:packages/dashboard/sql/facts.sql` → `VALUES ('facts', 2)`;
`traces.sql` → `target constant integer := 4`). I reset the worktree to `c1a30c8` and everything
below is that tree. A `git clone` of the public repo lands on `main` and gets **neither**.

**Proved vs inferred.** Every line marked `[PROVEN]` has a measurement quoted beside it. Two things
I nearly filed as defects and did not, because the measurement disproved them, are recorded under
*Non-findings* — that reasoning is worth as much as the findings.

---

## PART 9D — the upgrade path

**How the test was built.** A brand-new project, `upgrade-agent`, scaffolded from the **published**
`create-evestack@0.9.2` (`npm pack` of the real tarball, Ollama/qwen3, answered *yes* to bring-up),
own ports 2001 / 4001 / 5434, own Postgres volume. One real turn through the agent
(6,389 in / 417 out tokens, 14 tools offered, 163 spans). Nothing in this experiment shared a port,
a container or a database with anything else on the machine. The "newer image" is the
`cape-town-v1` tree built with the tree's own `packages/dashboard/Dockerfile`, tagged
`evestack-dashboard:cape-town`.

### The headline: there is nothing to upgrade to

**[BROKEN] `docs/upgrading.mdx` "Upgrade the dashboard" + GHCR — followed the section on a project
scaffolded today — expected a newer image tag to move to — the newest tag published is `0.3.1`,
the one the scaffolder already pinned.** `[PROVEN]`

```
GET ghcr.io/v2/sammytourani/evestack-dashboard/tags/list
  -> {"tags":["0.1.0","latest","0.2.0","0.3.0","0.3.1"]}
latest  -> sha256:5a1b4fa8014d3bc130ba3906bf1f376433329802f8af1a0a0da4b4c75ebea58f
0.3.1   -> sha256:5a1b4fa8014d3bc130ba3906bf1f376433329802f8af1a0a0da4b4c75ebea58f   (identical)
```

The example line in the doc is `EVESTACK_DASHBOARD_IMAGE=...:0.3.1` — it tells you to set the tag
you already have. So the whole of `spans v4`, `facts v2` and the downgrade guard is unreachable to
every user until a new image ships.

Worse for when it does: `packages/dashboard/package.json` on `cape-town-v1` still reads
`"version": "0.3.1"` and `create-evestack/shared.mjs` still reads `DASHBOARD_IMAGE_TAG = "0.3.1"`.
The published `0.3.1` image contains the **old** SQL:

```
$ docker run --rm --entrypoint sh ghcr.io/sammytourani/evestack-dashboard:0.3.1 -c "..."
386:  target    constant integer := 3;       # sql/traces.sql
260:VALUES ('facts', 1)                      # sql/facts.sql
```

Two different schemas are currently both called `0.3.1`. The release gate described in
`docker-compose.yml:127-134` ("git greps every written-out `evestack-dashboard:<version>` in the
tree and requires them all to agree") enforces *agreement*, not *increment*, so it will not catch
this.

### The upgrade itself works, and data survives

**[PROVEN — positive]** Baseline on the published image, read straight out of Postgres:

```
schema_version   spans=3, facts=1
runs 3 · spans 163 · fact_turn 0 · approvals 0
resolve_span_ancestry md5 = 90193adfd13b95273adc149db04bc73c
```

Then, literally per the doc — uncomment `EVESTACK_DASHBOARD_IMAGE` in `.env`,
`docker compose --profile dashboard pull dashboard`, `up -d dashboard`:

```
container recreated in 13 s, healthy
schema_version   spans=4 (on first boot), facts=2 (after the first page that reads facts)
runs 3 · spans 172 (still exporting) · fact_turn 1
resolve_span_ancestry md5 = 5a4381890429c36ec834f1e8a1c8e578   (replaced)
all 13 nav pages -> HTTP 200
```

Nothing was lost. The migration is genuinely lazy-on-first-use as the doc's Note claims, and the
Note is accurate about which file does what.

### The rollback is the hole, and the new guard does not cover it

**[BROKEN] published `0.3.1` rolled back over a v4 database silently reverts the spans resolver
while leaving the version marker reading `4` — so the migration can never re-apply, and nothing
anywhere says so.** `[PROVEN]`, controlled, single variable (the image tag).

```
before rollback   spans=4  facts=2  resolver md5 5a438189...
$ sed -i '' 's|^EVESTACK_DASHBOARD_IMAGE=.*|...evestack-dashboard:0.3.1|' .env
$ docker compose --profile dashboard up -d dashboard          # the only change
after rollback    spans=4  facts=1  resolver md5 90193adf...   <- v3 function, v4 marker
all 13 pages -> HTTP 200 ·  /api/health -> {"ok":true,"database":"connected","version":"0.3.1"}
```

The asymmetry is the mechanism, and both halves are visible above:

- `sql/traces.sql` upserts the spans marker with `WHERE evestack.schema_version.version <
  EXCLUDED.version`, so the marker **cannot** go down — but `CREATE OR REPLACE FUNCTION
  resolve_span_ancestry` sits at file top level and runs unconditionally, so the *function* does.
  Marker 4 + function v3 is a state the newer image will never repair by migration, because its
  own step is `IF installed < 4`.
- `sql/facts.sql` has no such `WHERE`, so the facts marker **does** decrement (2 -> 1) and its
  `IF installed IS DISTINCT FROM 1 THEN DROP TABLE fact_*` fires, dropping and rebuilding the fact
  tables on the way down.

**The downgrade guard added in `cape-town-v1` does not help here, and I proved why:** the guard
lives in the *new* image's SQL and refuses only when `installed > target`. Rolling back to any
image a user can pull today runs the *old* SQL, which has no guard at all — grepping the published
`0.3.1` image for the guard's own strings returns **0** hits in both `traces.sql` and `facts.sql`.

**[PROVEN — positive] The guard is excellent when it can fire.** Forced it by setting the marker to
5 and restarting the `cape-town` image:

```
/api/health -> {"ok":false,"status":"degraded","reason":"schema-too-new",
  "unavailable":["/traces","/sessions/[id]","/costs","/ (overview)","/api/metrics/query",
                 "/api/ingest/v1/traces"],
  "degradedButUp":["/sessions"],
  "available":["/monitors","/approvals","/schedules","/evals","/charts"],
  "error":"This dashboard is older than its database (spans is at v5, this build installs v4) ..."}
```

and the page renders a named error (`EV001`) that explains the fix and reassures that the
`workflow` tables are untouched. That is the right design. It is simply pointed at a downgrade
nobody can perform yet, and not at the one everybody can.

**[PROVEN] Re-upgrading repairs it.** Switching back to `cape-town` restored `facts=2` and resolver
`5a438189...`. The damage is bounded to the window you spend on the old image — but during that
window the marker lies and there is no way to see it from the product.

### Smaller things in the same section

**[WRONG] `/api/health` cannot distinguish an upgraded dashboard from one that never moved — and
the doc offers it as the confirmation step.** `[PROVEN]` It answered
`{"ok":true,"database":"connected","version":"0.3.1"}` **before** the upgrade, **after** the
upgrade to the merged build, and **after** the rollback. `docs/upgrading.mdx:58-60` introduces it
as "what the running dashboard says it is ... it reports its own version", and step 3 of the
upgrade is that same curl. It reports the same string in all three states.

**[WRONG] `docs/upgrading.mdx:60` "Find out where you are" hardcodes `127.0.0.1:4000` — the section
whose entire job is telling you which stack you are looking at.** `[PROVEN]` My project's dashboard
was on **4001** (the scaffolder picks a free port, and `docs/dashboard.mdx:205` says so: "it picks
a free one, so it is not always 4000"). Running the line verbatim from inside the project returned
`{"ok":true,"database":"connected","version":"0.3.1"}` — a healthy answer from a process that was
**not** this project's dashboard. `npx evestack status`, three lines later in the same block, gets
it right (`dashboard :4001 healthy`), which makes the curl line pure downside.

**[CONFUSING] `docker compose --profile dashboard pull dashboard` fails hard when the tag is not in
a registry, and the doc does not say the failure is survivable.** `[PROVEN]`
`Error response from daemon: pull access denied for evestack-dashboard, repository does not exist
or may require 'docker login'` — then the very next documented command, `up -d dashboard`,
succeeded from the local image. A user upgrading via a locally built or air-gapped image sees a red
error in the middle of the documented sequence with no note that it is expected.

**[PARTIAL — stated as unproven] "Do new features appear?"** I proved the schema moved (v3->v4,
v1->v2), the resolver function was replaced, and the downgrade guard became reachable. I did
**not** capture a `resolved_turn_id` baseline before upgrading, so I cannot claim a measured
user-visible change on `/sessions/[id]` from the v4 resolver. That half is unproven either way.

---

## PART 9E — uninstall

**[BROKEN] There is no documented uninstall, anywhere.** `[PROVEN]` A recursive grep of `docs/`
and `README.md` for uninstall / "remove evestack" / teardown returns exactly one hit,
`docs/channels/telegram.mdx:238 "## Teardown and rotation"`, which is about a bot token.
`docs/meta.json` has no such page. `npx evestack --help` lists eight commands and none of them
removes anything. The nearest thing is `docs/upgrading.mdx:231` telling you `docker compose down -v`
is the one destructive operation — offered as a warning, not as an instruction.

**[WRONG] The Postgres volume outlives the project and is named after a directory that no longer
exists.** `[PROVEN]` I did what a user with no docs would do: `docker compose --profile dashboard
down` (containers gone, network gone), then deleted the project directory. The volume survived:

```
docker run --rm -v upgrade-agent-dca745_evestack-pgdata:/v alpine:3 du -sh /v
147.2M  /v
```

`down` without `-v` is the command people type, and it keeps the volume. Nothing warns you, and
once the directory is deleted the volume name is the only surviving reference to it. Machine-wide
there are **five** `*_evestack-pgdata` volumes, and **four** belong to projects whose directories
no longer exist: `demo-67dd32`, `evestack-bringup-5vifio-a26684`, `sbx2-e739c8`, plus the one I
just orphaned.

**[ROUGH] Per-project sandbox template images are never cleaned up, and the brief's figures are
exactly right.** `[PROVEN]` from `docker system df -v`:

```
eve-sandbox-template:eve-sbx-tpl-docker-e739c801...-86be5f0e   665MB  shared 508.4MB  unique 157MB
eve-sandbox-template:eve-sbx-tpl-docker-e739c801...-46875b01   665MB  shared 508.4MB  unique 157MB
eve-sandbox-template:eve-sbx-tpl-docker-57a02de9...-46875b01   665MB  shared 508.4MB  unique 157MB
```

665 MB for the first and **157 MB of unique layers for each one after** — the brief's numbers,
measured. The project hash is baked into the tag, so every project mints its own and deleting the
project leaves it. Three survive here from projects that are gone.

**What a full removal has to include, none of it written down:**

| Left behind | Measured |
| --- | --- |
| `<project>_evestack-pgdata` volume | 147.2 MB (this project; 68-78 MB for a light one per round 1) |
| `ghcr.io/sammytourani/evestack-dashboard:0.3.1` | 1.05 GB on disk (231 MB compressed) |
| `pgvector/pgvector:pg17` | 646 MB |
| `ghcr.io/vercel/eve` base (pulled by the sandbox) | 665 MB |
| `eve-sandbox-template:*`, one per project | 157 MB unique each |
| `~/.npm/_npx` | 99 MB |
| Ollama `qwen3` + `nomic-embed-text` | 8.0 GB, never named anywhere as evestack's doing |
| `deploy/` launchd plist | **not** installed by anything — `~/Library/LaunchAgents` is clean |

`docker system df` on this machine reports **8.52 GB reclaimable images** and 203 MB reclaimable
volumes.

---

## PART 9C — from a clone

Ran `docs/dashboard.mdx:220-226` literally, on a cold checkout of `cape-town-v1` with no
`node_modules` and no `dist/`.

**[PROVEN — positive] The documented clone recipe works, including the part the Note says used to
be broken.**

```
pnpm install                        10.4 s   (warm pnpm store — see caveat)
pnpm -r --if-present run build      34 s     exit 0, dashboard compiled
cp packages/dashboard/.env.example packages/dashboard/.env.local
pnpm --filter @evestack/dashboard dev        Ready in 339 ms
```

No `Can't resolve '@evestack/schedules/cron'`. Building from the repo root is the fix and it holds.
*Caveat, stated because it matters:* the pnpm store on this machine was already warm
(`reused 601, downloaded 0`), so 10.4 s is not a cold-network figure.

**[PROVEN — positive] It fails closed out of the box, loudly and usefully.** With `.env.example`
copied unedited (`EVESTACK_AUTH_PASSWORD=` empty), `/api/health` answers
`503 {"ok":false,"status":"unconfigured", ...}` with a paragraph explaining exactly why and what
running without it would expose. `docs/dashboard.mdx:229-237` describes this and the description
matches what happened.

**[WRONG] The documented clone command binds every interface and is reachable from the LAN;
`docs/dashboard.mdx` warns about network exposure only for the Docker path.** `[PROVEN]` — this
closes the item round 1 left open on its own claim 28 ("Someone should run the documented command
and check `lsof -nP -iTCP:4000`"). I ran it. `lsof` shows the dev server as
`node ... TCP *:4000 (LISTEN)`, and from the machine's own LAN address:

```
http://192.168.1.183:4000/sessions                     -> 401
http://192.168.1.183:4000/sessions  with credentials   -> 200
```

Next prints `Network: http://192.168.1.183:4000` in its own banner. The credential holds, so this
is exposure rather than a hole — but the only place the docs discuss it is the Docker paragraph
("what keeps it off your network is the compose port mapping, `127.0.0.1:4000:4000`"), and the
clone section sits above it with no equivalent sentence. So **claim 28's dev half is now measured,
and it is FALSE as written for the clone path** — those ports are not confined to your machine.

**[ROUGH] The dashboard's `dev` script hardcodes `--port 4000` with no conflict detection and no
fallback.** `[PROVEN]` Port 4000 was already occupied on this machine. Next started anyway (it
bound `*:4000` while an existing IPv4 `127.0.0.1:4000` listener kept its socket), printed
`Local: http://localhost:4000`, and that URL resolves to the *other* listener. The doc's
`# http://localhost:4000` comment then points at somebody else's dashboard, with nothing on either
side reporting a problem.

---

## PART 8E — scale

Volume generated directly in Postgres (`workflow.workflow_runs`: one `$eve.type=session` row plus
three `$eve.type=turn` rows each, realistic attribute set), against the merged `cape-town` image.
Times are `curl` `time_total` for a fully server-rendered page, best of three after a warm-up. The
pages are SSR — I checked the HTML actually contains the rows before trusting the numbers.

| sessions | `/sessions` (default page) | `/monitors` | `/` | `/costs` | `/evals` |
| --- | --- | --- | --- | --- | --- |
| 1 | 0.023 s · 26 KB | 0.021 s | 0.017 s | 0.013 s | 0.005 s |
| 10 | 0.028 s · 47 KB | 0.053 s | 0.027 s | 0.013 s | 0.012 s |
| 100 | 0.040 s · 242 KB | 0.021 s | 0.014 s | 0.011 s | 0.014 s |
| 500 | 0.132 s · 568 KB | 0.069 s | 0.028 s | 0.027 s | 0.019 s |
| 2,000 | 0.047 s · 638 KB | 0.050 s | 0.054 s | 0.040 s | 0.045 s |
| 10,000 | 0.081 s · 638 KB | 0.075 s | 0.043 s | 0.046 s | 0.031 s |

**[PROVEN — positive] Nothing gets unusably slow, at any of the sizes the plan asks about or well
past them.** The default page is bounded at 250 rows and the pager is honest — the page says
"Sorting, filtering, search and export work over the 250 sessions loaded on this page",
"250 of 250 rows shown", and offers rows-per-page 100 / 250 / 1,000 / 10,000 plus an "Older 250"
link with a real cursor (`?limit=250&cursor=<ts>|<id>`). At 10,000 sessions the database is 44 MB.

Fact-tier refresh, measured by resetting the watermark and timing the next `/monitors`:
**408 ms over 6,000 turns; 1.56 s over 30,000 turns.**

**[ROUGH] The 10,000-rows-per-page option the UI itself offers costs about 1 s and 5.2 MB of HTML
at 10,000 sessions.** `[PROVEN]` limit=100 -> 0.058 s, 250 -> 0.078 s, 1,000 -> 0.347 s,
10,000 -> 0.991 s and 5,249,696 bytes. It works; it is the only thing in this area that feels bad,
and it is a control the product hands you.

**[ROUGH] Search and filters cover only the rows already loaded, so at 10,000 sessions finding one
by name means loading all 10,000 first.** `[PROVEN]` `/sessions?q=session+9000` returned
638,489 bytes — byte-for-byte the same size as the unfiltered page, i.e. the query string is not a
server-side filter. The page states this in as many words, which is why this is `ROUGH` and not
`WRONG`, but it is the one place where the honest label does not make the behaviour usable.

---

## PART 5 — visual passes (5.1 mobile · 5.2 light/dark · 5.3 empty · 5.4 second engine · 5.5 keyboard)

Driven with Playwright 1.56.1 against the merged `cape-town` image: **13 pages × {390×844,
1440×900} × {light, dark} × {Chromium 141, WebKit 26} = 104 page loads**, signed in through the
form (HTTP Basic is accepted by the server, but browser navigation redirects to `/signin` instead
of challenging, so the credentials had to be typed). Screenshots in
`~/evestack-stranger-test/round2/shots/`, raw metrics in `round2/visual-capetown.json`.

**[PROVEN — positive] Zero horizontal overflow, zero console errors, zero non-200s, in all 104
combinations.** `document.scrollWidth === window.innerWidth` on every page at 390 px, in both
engines and both colour schemes. I sanity-checked the instrument rather than trusting a null
result: injecting a 900 px div into `/sessions` moved the measurement from `0` to `510`.

Wide content is handled with inner scroll containers, which is the right pattern — `/sessions`
`div.overflow-x-auto` (scrollWidth 1637 inside clientWidth 340), `/traces` and `/evals`
`div.table-wrap`, and the sidebar becomes a horizontally scrollable strip at mobile
(`nav.sidebar` 1255 / 390), which also drops its OBSERVE / DRIVE / CONFIGURE group headings.

**[PROVEN — positive] Empty states are specific, actionable, and do not look like errors.** Checked
every page against a genuinely empty database (fresh Postgres, `npm run db:bootstrap`, no runs):
`/sessions` "No sessions yet — Your agent has not run" with the exact curl to start one; `/traces`
"No spans yet — Trace export is opt-in, and off by default" plus the two variables; `/memory`
"No memory table yet — The agent creates `evestack.memories` the first time it calls remember";
`/schedules`, `/approvals`, `/sandboxes`, `/integrations`, `/evals` all the same shape. Overview
shows `—` with "no comparison: previous 24h has no value" rather than `0`. This is the
best-executed thing I looked at in this pass.

**[WRONG] `/traces` empty state tells you to set `EVESTACK_DASHBOARD_URL=http://localhost:4000/...`
even when the project's own `.env.local` says a different port.** `[PROVEN]` The scaffolder wrote
`EVESTACK_DASHBOARD_URL=http://127.0.0.1:4001/api/ingest/v1/traces` into the second project; the
page hardcodes `4000`. This is the page you are on precisely because traces are not arriving, and
following its instruction is what would keep them from arriving. The neighbouring `/sessions` empty
state *is* templated correctly — with `EVESTACK_AGENT_URL` pointing at :2001 it printed
`curl -X POST http://localhost:2001/eve/v1/session` — so the mechanism exists and this one page did
not use it.

**[ROUGH] No skip link; 15 sidebar stops before the first control on every page, on every
navigation.** `[PROVEN]` On `/sessions` the first non-`nav` focusable element is **tab stop 16**
(the "Search sessions" input), and there is no skip-to-content pattern in the served HTML. Every
filter (outcome, trigger, model, provider, environment, run type), "Export CSV (250)" and all
eleven column sorts are real buttons with no positive `tabindex`, so they are reachable — just
never before stop 17.

**[PROVEN — positive] The controls that matter do work from the keyboard.** `/signin` tab order is
user, password, Sign in, and Enter in the password field signs you in and lands on `/`. On `/chat`,
Tab reaches the textarea, typing enables the Send button and the next Tab lands on it with a
visible focus outline. Nav links and buttons show `outline: auto 1px rgb(0,95,204)` under
`:focus-visible`.

**[CONFUSING] `/charts` returns 404 to a signed-in user, but `/api/health`'s degraded payload lists
it under `available`.** `[PROVEN]` 404 on the published image, on the merged image, and on a
container I built myself; 401 unauthenticated, so auth runs first and then the route 404s. The
route is in the build (`.next/server/app/charts.html`) and `app/charts/page.tsx` calls `notFound()`
in production on purpose — it is a development gallery. So the 404 is correct and the health
payload advertising it is not. Also for the plan's owner: the test plan lists `/charts` as
dashboard page 6 and Part A claim 7 asks "do they match `/charts`?" — like claim 18, that row
describes something the product does not offer.

---

## Regression re-check carried over from round 1

**[BROKEN] The `~/.npmrc` credential copy still happens to anyone scaffolding today.** `[PROVEN]`
Round 1 found this and the fix is on `cape-town-v1` (`0e1e16d create: git init ...`) — it is
**not** published. On a project scaffolded from `create-evestack@0.9.2` an hour ago there is no
`.git`, and:

```
find upgrade-agent/.eve -name .npmrc
  upgrade-agent/.eve/dev-runtime/snapshots/msmzgtxq-.../source/.npmrc
shasum ~/.npmrc          20c0dcf588743f5857f42729af07778bb8be2f0b
shasum .../source/.npmrc 20c0dcf588743f5857f42729af07778bb8be2f0b   (byte-identical)
```

and the agent log still shows the watcher on `$HOME`: `[eve:dev] change detected (5 events: unlink
/Users/.../Users/.../.npmrc, add /Users/.../.gemrc, ...)`. Same doubled path, same dotfiles.
Nothing a user can install today contains the fix.

---

## Non-findings — things the measurement disproved

Recorded because round 1's own corrections say the failure mode here is confident inference.

1. **"`EVESTACK_AGENT_URL` breaks authentication."** A dashboard on `127.0.0.1:4003` rejected the
   correct password on every attempt, including form sign-in, while an otherwise identical
   container on `:4002` accepted it — the only env difference was `EVESTACK_AGENT_URL`. I had the
   finding half-written. Two controlled containers (`:4004` without it, `:4005` with it) both
   returned 200, so I kept digging: `docker ps -a` showed the `:4003` container was in state
   **Created**, never started, because **an `ssh` process already holds `127.0.0.1:4003`**.
   Everything I had measured on `:4003` came from an SSH tunnel to an unrelated evestack dashboard.
   No product defect. I also killed the adjacent theory — a sign-in lockout — by sending 12 wrong
   passwords then the right one: 401 twelve times, then 200. No lockout.

2. **"Overview renders `$$0.00`."** The RSC payload contains `"children":["$$0.00",null]`. That is
   React Flight escaping a leading `$`, not a doubled currency symbol. The rendered page says
   `$0.00`.

3. **"`/sessions` shows 0 turns for older rows"** and **"the fact tables lag `workflow_runs`"** —
   both artifacts of my back-dated synthetic rows sitting behind the incremental refresh watermark.
   Resetting the watermark populated all 29,998 fact rows. Real data always arrives forward in
   time, so neither is reachable in normal use.

---

## Environment notes — not product findings, but they bound the confidence above

- **Another process was operating on this machine while I tested.** `my-agent`'s dashboard
  container started on its own at `08:37:09Z`, its `.env.local` was edited by something that was
  not me, and two `eve-sandbox-template` images were built 5 and 12 minutes before I looked at
  them. Every 9D conclusion above therefore rests on `upgrade-agent` (ports 2001/4001/5434, its own
  volume), which nothing else touched. Observations on `my-agent` and on port 4000 are
  corroborating only. In particular the *first* rollback I saw — `my-agent`'s resolver going from
  2672 chars containing `workflow.run.id` to 1503 chars / md5 `90193adf...` while the marker stayed
  at `spans 4` — was an accident of that concurrency, and is reported only because the controlled
  run on `upgrade-agent` reproduced it exactly.
- `127.0.0.1:4000` and `127.0.0.1:4003` are both held by `ssh` tunnels on this machine. Nothing may
  assume a port is free.
- The dashboard image would not build here as shipped: `corepack` fetches pnpm from
  `registry.npmjs.org`, which this network blackholes. I built from an out-of-tree copy of the repo
  with a root `.npmrc` and a `COREPACK_NPM_REGISTRY` env line pointed at a mirror. No other change
  to the Dockerfile, and nothing in the repository was modified.

## Cleanup

Everything created for this pass was removed: the `upgrade-agent` project and its volume, the
`r2-empty-pg` / `r2-empty-dash` / `r2-test-a` / `r2-test-b` containers, the local
`evestack-dashboard:cape-town` image, the clone and the out-of-tree build copy. The pre-existing
orphans listed under 9E (four `*_evestack-pgdata` volumes, three `eve-sandbox-template:*` images)
were **left in place** — they are the evidence, and they were not mine to delete.
