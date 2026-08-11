# investigations.md — W8 (read-only)

Four questions from `fix-plan.md` §W8. No product code was changed. Everything below was run
against the live stack at `~/evestack-stranger-test/cold/my-agent` (left running and untouched)
or in throwaway directories under `/tmp/w8-repro`.

Each claim is tagged:

- **[PROVEN]** — I ran it and have the output.
- **[INFERRED]** — read from source and reasoned, not executed.
- **[ESTIMATE]** — arithmetic on measured inputs.

Stack under test: `eve@0.30.8`, dashboard image `0.3.1`, `pgvector/pgvector:pg17`, Colima
(Docker 29.2.1, overlayfs / containerd snapshotter), macOS 26.5.2, Node 26.0.0.

---

# 8.1 — eve's dev watcher watches `$HOME`, mangles the path, and copies your `.npmrc` into the project

## Verdict

Three separate defects, all upstream in `eve`, stacked. **evestack can neutralise all three from
its own side with one line**, and should, because the third one moves a registry credential.

The observed log line is not a cosmetic bug. It is the visible symptom of eve deciding that the
**user's home directory is the project's source root**.

## What actually happened, proven end to end

### The chain

**Step 1 — the scaffolded project has no `.git`.** `[PROVEN]` `npx evestack create` does not run
`git init` (grepped `packages/create-evestack/**`, zero hits; nothing in `docs/` or `README.md`
tells the user to either). The live project has a `.gitignore` and no `.git`.

**Step 2 — eve walks up until it finds one, and finds the dotfiles repo in `$HOME`.**
`[PROVEN]`

`node_modules/eve/dist/src/internal/nitro/dev-runtime-source-snapshot.js`:

```js
SOURCE_ROOT_MARKER_NAMES = [`.git`, `pnpm-workspace.yaml`]

function resolveDevelopmentSourceRoot(e) {
  let t = resolve(e);
  for (;;) {
    if (SOURCE_ROOT_MARKER_NAMES.some(e => existsSync(join(t, e))) || isWorkspaceManifestRoot(t)) return t;
    const n = dirname(t);
    if (n === t) return resolve(e);
    t = n;
  }
}
```

Marker census up the chain, measured on this machine:

| directory | `.git` | `pnpm-workspace.yaml` |
|---|---|---|
| `…/cold/my-agent` | no | no |
| `…/cold` | no | no |
| `…/evestack-stranger-test` | no | no |
| **`/Users/sammytourani`** | **YES** | no |

So `sourceRoot = /Users/sammytourani`.

**Step 3 — every "workspace metadata file" in the source root is watched *and copied*.**
`[PROVEN]` Same file:

```js
WORKSPACE_METADATA_FILE_NAMES = [`package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`,
                                `package-lock.json`, `yarn.lock`, `bun.lock`, `bun.lockb`, `.npmrc`]
```

`.npmrc` is in that list. `$HOME/.npmrc` exists. It therefore becomes both a top-level chokidar
watch target **and** a `copyFiles` entry in the dev-runtime snapshot plan.

**Step 4 — the lockfile watcher independently walks up to `$HOME` too.** `[PROVEN]`
`node_modules/eve/dist/src/internal/nitro/host/dev-authored-source-watcher.js`:

```js
WATCHED_LOCKFILE_NAMES = [`pnpm-lock.yaml`,`package-lock.json`,`yarn.lock`,`bun.lock`,`bun.lockb`]
WATCH_ROOT_MARKER_NAMES = [`.git`,`pnpm-workspace.yaml`]

function resolveLockfileSearchDirectories(e){ /* same walk-up, same markers */ }
// …then, per directory, per name:  n.add(join(dir, lockfileName))
```

That is 4 directories × 5 names = **20 watch paths, 15 of them outside the project**, including
`$HOME/pnpm-lock.yaml`, `$HOME/package-lock.json`, `$HOME/yarn.lock`, `$HOME/bun.lock`,
`$HOME/bun.lockb` — **none of which exist**. Chokidar handles a non-existent watch target by
watching its parent directory, so eve ends up watching `$HOME` and reporting every file event in
it as a project source change.

## Minimal reproduction

Scripts live at `/tmp/w8-repro/repro.mjs`, `repro2.mjs`, `repro3.mjs`, `repro4.mjs`. They import
**eve's own vendored chokidar**
(`node_modules/eve/dist/src/compiled/chokidar/index.js`) with **eve's exact watcher options**
(`awaitWriteFinish {pollInterval:50, stabilityThreshold:160}`, `followSymlinks:false`,
`ignoreInitial:true`) and reimplement `resolveLockfileSearchDirectories` verbatim.

Fixture: a fake `$HOME` containing `.git` plus symlinked `.npmrc`/`.gemrc`/`.yarnrc`/`.yarnrc.yml`,
and a project three levels down with no `.git`.

**Result A — home-directory noise reproduces on the first cycle** `[PROVEN]`:

```
lockfile search dirs : ~/work/cold/my-agent  ~/work/cold  ~/work  ~
lockfile watch paths : 20 ( none of these exist )

RAW chokidar events reaching eve's rebuild queue: 4
    add /tmp/w8-repro/fs/home/.gemrc
    add /tmp/w8-repro/fs/home/.npmrc
    add /tmp/w8-repro/fs/home/.yarnrc
    add /tmp/w8-repro/fs/home/.yarnrc.yml

what eve would print:
  [eve:dev] change detected (4 events: add …/.gemrc, add …/.npmrc, add …/.yarnrc,
            add …/.yarnrc.yml), rebuilding authored artifacts...
```

**Result B — the doubled path reproduces exactly, and needs both defects at once** `[PROVEN]`.
With `$HOME/.npmrc` (a symlink) in the top-level watch list **and** a non-existent lockfile path in
the same directory:

```
  unlink  /tmp/w8-repro/C-both/tmp/w8-repro/C-both/.npmrc   <<< DOUBLED
  add     /tmp/w8-repro/C-both/.gemrc
  add     /tmp/w8-repro/C-both/.yarnrc
  add     /tmp/w8-repro/C-both/.yarnrc.yml
  add     /tmp/w8-repro/C-both/.npmrc
```

Five events, one doubled `unlink` for `.npmrc`, four clean `add`s — **byte-for-byte the shape of
the reported line**, including the ordering and the fact that only `.npmrc` is doubled.

### Where the doubling is built

Not in eve's formatter. `dev-watcher-log.js`'s `formatChangeEventPath(root, path)` is correct:

```js
function formatChangeEventPath(r,i){
  const a = relative(r,i);
  const o = a===".." || a.startsWith(".."+sep) || isAbsolute(a);
  return (a.length>0 && !o ? a : i).replaceAll("\\","/");
}
```

Given a path outside the app root it returns it unchanged. The path arrives already doubled.

It is built in **chokidar**, in `_addToNodeFs`'s symlink branch. Verified against **upstream
`chokidar@5.0.0`** (`node_modules/.pnpm/chokidar@5.0.0/node_modules/chokidar/handler.js`), which
eve vendors verbatim:

```js
else if (stats.isSymbolicLink()) {
    const targetPath = follow ? await fsrealpath(path) : path;
    const parent = sp.dirname(wh.watchPath);
    this.fsw._getWatchedDir(parent).add(wh.watchPath);   // <-- ABSOLUTE path stored as a dir ITEM
    this.fsw._emit(EV.ADD, wh.watchPath, stats);
    closer = await this._handleDir(parent, stats, initialAdd, depth, path, wh, targetPath);
```

Everywhere else, a watched directory's item set holds **basenames**. `_handleRead`'s readdir
builds a basename set, finds the absolute-named item "missing", and calls `_remove(parent, item)`,
which does `join(parent, item)` — `join('/Users/sammytourani', '/Users/sammytourani/.npmrc')`
= `/Users/sammytourani/Users/sammytourani/.npmrc`.

This only fires when chokidar is handed a path that **is itself a symlink** as a top-level watch
target, with `followSymlinks:false`. eve only ever does that because of step 3. On a machine where
`~/.npmrc` is a regular file the log line would read correctly and the underlying scoping bug
would be invisible.

## The part that is worse than noise: your registry credential is copied into the project

`[PROVEN]` `copyFiles` from `addWorkspaceMetadataFiles()` are not just watched — they are copied
into `.eve/dev-runtime/snapshots/<id>/source/`. On the live stack:

```
$ find .eve -maxdepth 6 -name ".npmrc"
.eve/dev-runtime/snapshots/msmr6z2i-…/source/.npmrc
.eve/dev-runtime/snapshots/msmrfqa9-…/source/.npmrc
.eve/dev-runtime/snapshots/msmqruky-…/source/.npmrc

$ shasum .eve/dev-runtime/snapshots/msmrfqa9-…/source/.npmrc /Users/sammytourani/.npmrc
20c0dcf588743f5857f42729af07778bb8be2f0b  .eve/…/source/.npmrc
20c0dcf588743f5857f42729af07778bb8be2f0b  /Users/sammytourani/.npmrc
```

Byte-identical. That file contains a line matching `//reposerver.w10external.com/repository/npm/:_auth=`
— a **registry credential**, copied out of `$HOME` into a project directory, three times, with no
prompt and no log line saying so.

The snapshot's `current.json` shows how far the source root drifted:

```json
"runtimeAppRoot": ".../.eve/dev-runtime/snapshots/msmrfqa9-…/source/evestack-stranger-test/cold/my-agent"
```

The snapshot mirrors the **home directory**, and the actual project is nested three levels inside it.

**Mitigations that are real** `[PROVEN]`: the scaffolded `.gitignore` contains `.eve/`, so a
`git add -A` inside the project will not commit it. The copy is inside the project, not uploaded
anywhere. Severity is "a secret got duplicated somewhere the user does not know about", not "a
secret left the machine".

## Can evestack scope this from its own side? Yes — one line

`[PROVEN]` `resolveDevelopmentSourceRoot` and `resolveLockfileSearchDirectories` use the **same
marker list** (`['.git', 'pnpm-workspace.yaml']`). Putting either marker at the scaffolded project
root stops both walks dead. Measured (`/tmp/w8-repro/repro4.mjs`):

```
===== app root has NO .git =====
  source root              : /…/home    <-- USER'S HOME
  lockfile search dirs     : 4
  lockfile watch paths     : 20  ( reaching outside the project: 15 )
  home files copied+watched: ~/package.json, ~/.npmrc

===== app root HAS .git =====
  source root              : /…/home/work/cold/my-agent
  lockfile search dirs     : 1
  lockfile watch paths     : 5   ( reaching outside the project: 0 )
  home files copied+watched: none
```

**Recommendation for W5 (`create-evestack`):** run `git init` in the scaffolded project as the
last step of `create`. It is one line, it is what almost every scaffolder already does, and it:

- scopes the watcher to the project (bug 1, 2 and the doubled path all disappear)
- stops `$HOME/.npmrc` being copied into `.eve/`
- makes the shipped `.gitignore` actually do something — right now it is inert, because there is
  no repo for it to apply to
- costs nothing on the happy path; users who scaffold *into* an existing repo already have a
  marker above them

`[INFERRED]` If `git init` is considered too opinionated, an empty `pnpm-workspace.yaml` also works,
but it is a lie in an npm project and would confuse `npm`/`corepack` users. `git init` is the right
answer.

`[PROVEN]` There is **no eve config knob** for this. Searched all of `eve/dist/src/**/*.d.ts` for
`sourceRoot`/`watchPaths`/`EVE_*ROOT`/`EVE_*WATCH` env names — the only `EVE_DEV_*` variables are
internal route paths and the sandbox run id. Nothing in eve's own `docs/` documents the source-root
walk-up at all.

## Is it fixed upstream? No

`[PROVEN]` I pulled `eve@0.31.3` (current `latest`) from the mirror and diffed the constants:

```
WORKSPACE_METADATA_FILE_NAMES=[`package.json`,…,`.npmrc`]      unchanged
SOURCE_ROOT_MARKER_NAMES=[`.git`,`pnpm-workspace.yaml`]        unchanged
WATCH_ROOT_MARKER_NAMES=[`.git`,`pnpm-workspace.yaml`]         unchanged
resolveLockfileSearchDirectories(...)                          byte-identical
```

**Still present in the newest published eve.**

## Prior art upstream — related, not duplicate

`[PROVEN]` (searched `vercel/eve` issues):

| # | state | title | relation |
|---|---|---|---|
| [#1720](https://github.com/vercel/eve/issues/1720) | closed | `eve dev` recompiles when AI SDK DevTools writes `.devtools` | **nearest precedent** — same class (unrelated writes trigger a recompile), fixed by adding one directory to the ignore list. Does not address the source root escaping the project |
| [#570](https://github.com/vercel/eve/issues/570) | open | `eve dev` leaks the previous snapshot's watcher, orphan busy-scans at ~250% CPU | watcher lifecycle, not watcher scope |
| [#609](https://github.com/vercel/eve/pull/609) | open | avoid dev snapshot watcher subscriptions | reduces *which* watchers exist, not *where* they point |

Nothing covers the source root walking up to `$HOME`. A new issue is warranted.

## Drafted upstream issue

> **Title:** `eve dev` treats `$HOME` as the project source root when the app has no `.git`, watching and copying `~/.npmrc`
>
> ### Environment
>
> - eve `0.30.8`, reproduced against the published `0.31.3` source too (constants unchanged)
> - macOS 26.5.2 arm64, Node 26.0.0
> - Project scaffolded by a third-party template into `~/some/dir/my-agent`, **no `.git` in the project**
> - `~/.git` exists (a dotfiles repo — common setup), and `~/.npmrc` is a symlink
>
> ### What happens
>
> An unrelated tool rewrote four dotfiles in my home directory. `eve dev` rebuilt the project:
>
> ```
> [eve:dev] change detected (5 events: unlink /Users/me/Users/me/.npmrc, add /Users/me/.gemrc,
> add /Users/me/.npmrc, add /Users/me/.yarnrc, add /Users/me/.yarnrc.yml), rebuilding authored artifacts...
> ```
>
> Note the doubled `/Users/me/Users/me/`.
>
> ### Root cause — three things, stacked
>
> **1. `resolveDevelopmentSourceRoot` walks up past the project.**
> `src/internal/nitro/dev-runtime-source-snapshot.ts` searches ancestors for
> `SOURCE_ROOT_MARKER_NAMES = ['.git', 'pnpm-workspace.yaml']`. A project with no `.git` and no
> workspace manifest keeps walking. On a machine with a dotfiles repo in `$HOME`, the source root
> becomes the home directory. `addWorkspaceMetadataFiles` then adds every existing
> `WORKSPACE_METADATA_FILE_NAMES` entry under that root — including **`.npmrc`** — to both the
> watch set and `copyFiles`.
>
> **This copies the user's `~/.npmrc` into `.eve/dev-runtime/snapshots/<id>/source/.npmrc`.** On my
> machine that file contains a registry `_auth` token. Verified byte-identical by `shasum`, in
> three snapshots. `runtimeAppRoot` in `current.json` also becomes a home-mirroring path with the
> real project nested inside it.
>
> **2. `resolveLockfileSearchDirectories` does the same walk, then watches paths that do not exist.**
> `src/internal/nitro/host/dev-authored-source-watcher.ts` adds
> `join(dir, name)` for all five `WATCHED_LOCKFILE_NAMES` for **every** ancestor up to the marker —
> 20 paths for a project four levels below `$HOME`, 15 of them outside the project, none of them
> existing. Chokidar responds to a non-existent watch target by watching its parent, so `eve dev`
> effectively watches `$HOME` and rebuilds on any file event there.
>
> **3. The doubled path is a chokidar bug that (2) makes reachable.**
> `chokidar@5.0.0` `handler.js`, `_addToNodeFs` symlink branch:
>
> ```js
> const parent = sp.dirname(wh.watchPath);
> this.fsw._getWatchedDir(parent).add(wh.watchPath);   // absolute path where a basename is expected
> ```
>
> Every other writer of that item set uses a basename. `_handleRead`'s readdir builds a basename
> set, the absolute-named item never matches, and `_remove(parent, item)` does
> `join(parent, absolutePath)` → the doubled path, emitted as `unlink`. It only triggers when a
> **symlink** is a top-level watch target with `followSymlinks: false`, which is exactly what (1)
> arranges for `~/.npmrc`.
>
> ### Minimal reproduction
>
> ```bash
> mkdir -p /tmp/eve-repro/home/.git /tmp/eve-repro/home/work/app
> cd /tmp/eve-repro/home/work/app && npx eve init . && ln -s /etc/hostname /tmp/eve-repro/home/.npmrc
> HOME=/tmp/eve-repro/home npx eve dev &
> # then: rm /tmp/eve-repro/home/.npmrc && ln -s /etc/hostname /tmp/eve-repro/home/.npmrc
> ```
>
> A watcher-level repro that needs no agent boot is attached below — it drives eve's own vendored
> chokidar with eve's own options and reproduces the exact five-event line including the doubling.
>
> ### Expected
>
> - The source root never escapes the app root when the app root is itself a valid project.
> - Watch targets are confined to the resolved source root's subtree.
> - `.npmrc` is never copied into a build artifact directory from outside the project.
> - A watched symlink's parent-directory bookkeeping uses a basename (chokidar fix, or vendor patch).
>
> ### Suggested fixes, cheapest first
>
> 1. Stop the ancestor walk at the app root when the app root has its own `package.json` and is not
>    itself a workspace member — the common case for a scaffolded standalone agent.
> 2. Drop `.npmrc` from `WORKSPACE_METADATA_FILE_NAMES`, or at minimum stop *copying* it (watching
>    it for cache invalidation is defensible; copying a credentials file is not).
> 3. Filter `resolveLockfileSearchDirectories` output to `existsSync` paths, or watch the lockfile's
>    **directory** with a name filter rather than a non-existent file path.
> 4. Upstream chokidar: `_getWatchedDir(parent).add(sp.basename(wh.watchPath))`.
>
> Related: #1720 (same class, narrower), #570 / #609 (watcher lifecycle, not scope).

---

# 8.2 — Can the dashboard's wedge detection fire at all, and on what threshold?

## Verdict

**Yes, it can fire.** There is a real, working two-gate mechanism, not a dead feature. It has
**two hard-coded thresholds**, the effective floor on "agent dies → red banner" is **60 minutes**,
**neither threshold is configurable in the UI by any means**, and **neither is documented anywhere**.

That last point is the finding.

## The gates, in order

`[PROVEN]` — all read from `packages/dashboard/lib/fleet.ts` and
`packages/dashboard/app/api/fleet/route.ts`.

| # | Gate | Value | Where | Configurable? |
|---|---|---|---|---|
| A | `s.attributes->>'$eve.type' = 'session'` | — | `lib/fleet.ts:356` | no |
| B | `s.status = 'running'` | — | `lib/fleet.ts:357` | no |
| C | **Session quiet for ≥ N** | `IDLE_BEFORE_SUSPECT_MS = 30 * 60 * 1000` | `lib/fleet.ts:144`, applied `:364-365` | `?idleMinutes=` on the route **only** |
| D | **Session has ≥1 turn/subagent child with `completed_at IS NULL`** | — | `lib/fleet.ts:393-396` | no |
| E | `ORDER BY last_activity ASC LIMIT n` | `MAX_PROBES = 25` | `lib/fleet.ts:204`, `:397-398` | `?limit=` on the route only |
| F | Live HTTP probe of the agent | `PROBE_TIMEOUT_MS = 2000` | `lib/fleet.ts:224` | no |
| G | **Open turn older than N to be called `wedged`** | `STUCK_TURN_MS = 60 * 60 * 1000` | `lib/fleet.ts:234`, applied `:305-306` | **no — not by any mechanism, anywhere** |

The classifier (`lib/fleet.ts:305-311`):

```js
const openFor = inFlightMs ?? idleMs;
return openFor > STUCK_TURN_MS
  ? { health: "wedged",  … reason: "a turn started and never finished — nothing in eve will resume it" }
  : { health: "active",  … reason: "a turn is running" };
```

`inFlightMs` is derived from the **open turn's own `started_at`** (`lib/fleet.ts:342-345`), so
later activity on the session cannot soften it.

## Why the UI cannot be tuned

`[PROVEN]` `packages/dashboard/app/fleet-banner.tsx:18`:

```tsx
report = await inspectFleet();
```

No arguments. The banner is a **server component** rendered inline on `/` (`app/page.tsx:159-161`)
and `/sessions` (`app/sessions/page.tsx:349-351`) — it never goes through `/api/fleet`, so
`?idleMinutes=` and `?limit=` cannot reach it. There is **no `process.env` reference in
`lib/fleet.ts` or `app/api/fleet/route.ts` at all**, and no fleet/wedge key in
`templates/default/.env.example` or `docs/self-hosting.mdx`.

`[PROVEN]` Nothing in the product ever calls `/api/fleet`. Every reference in the repo is a
contract probe, a docs curl example about *authentication*, or the banner's own advice string.
The Overview refreshes via `router.refresh()` every 30 s (`app/live.tsx:41`), which re-runs the
server render; `/sessions` has no such refresher.

## What `checked: 0` actually meant — and it changed between the finding and now

`[PROVEN]` I ran the fleet candidate SQL against the live database (2026-08-09, ~22:45):

```
               id                | quiet_minutes | joined_children | open_turns | gate_C_idle30 | gate_D_openturn
---------------------------------+---------------+-----------------+------------+---------------+-----------------
 wrun_01KZMZMV6C5QRYHBMBPVPE7Q05 |          59.1 |               1 |          0 | t             | f
 wrun_01KZN0AFY7HGHDZK2WJ9DCMT6R |          47.3 |               1 |          0 | t             | f
 wrun_01KZN0CB46G30JDHK1MD3Z75BC |          46.1 |               1 |          0 | t             | f
 wrun_01KZN0EEM4B207QNM7XZFD7K8J |          28.6 |               1 |          0 | f             | f
```

Funnel: `4 sessions running → 0 with an open turn child`. So **right now** `checked: 0` is
produced by **gate D**, and gate D is correct: no turn is open.

**The stranded run has since closed.** `wrun_01KZN0EEQDSCPHQM5YHCRQYM6P` is now
`status = completed, $eve.type = turn, $eve.root = wrun_01KZN0EEM4B207QNM7XZFD7K8J`. Other agents
are working this stack, so I cannot say whether boot recovery or a human closed it — flagging it
because `findings.md` and `fix-plan.md` §3.3 both assert it is permanently open, and that is no
longer true of the live database.

**At the moment of the original finding**, the tester's own reading was right: the killed turn *was*
open, so gate D passed, and gate C (30 minutes) is what excluded it — the session was ~1 minute old
when killed and ≤21 minutes when they stopped watching.

## The honest answer to "on what threshold?"

`[INFERRED, from the proven constants]` The minimum wall-clock from "agent dies mid-turn" to a red
`N sessions wedged` banner is:

- **≥ 30 min** of session quiet (gate C), **and**
- **> 60 min** since the open turn's `started_at` (gate G),
- plus up to 30 s for the Overview's auto-refresh.

Gate G binds, so **60 minutes is the floor**, and only if the session stays untouched. Between 30
and 60 minutes the session is probed and classified `active` ("a turn is running") — which is in
**none** of the four counters `summarize()` returns, so the banner does not render.

One nuance worth keeping: if the agent is **down**, the probe fails and the entry becomes
`unknown`, and `fleet-banner.tsx:27` renders an amber banner on `unknown > 0`. So a dead agent
*does* surface — but still only after gate C's 30 minutes, and only for sessions that already had
an open turn row.

## Documentation: it is documented nowhere

`[PROVEN]` Swept `docs/**`, `README.md`, `FINDINGS.md`, `llms.txt`, `CHANGELOG.md`, all
`packages/*/README*`, and `packages/website/**`.

- `IDLE_BEFORE_SUSPECT_MS` (30 min) — **zero** occurrences outside `lib/fleet.ts:144`.
- `STUCK_TURN_MS` (1 hour) — named **once** in the whole repo's prose, at `CHANGELOG.md:823-824`,
  and there as an aside about a *different* surface (the SQL alert).
- `?idleMinutes=` — **zero** documentation hits. Only `route.ts` and one contract probe.
- `?limit=` — mentioned only in the banner's own runtime copy (`fleet-banner.tsx:109`).
- The `/api/fleet` response shape — undocumented.
- Gate D, the 2-second probe timeout, the 25-probe cap, `status = 'running'` — undocumented.

**`docs/dashboard.mdx` — the dashboard's own reference page — has zero matches for `fleet` or
`wedge`.** Verified: `grep -cin "fleet\|wedge" docs/dashboard.mdx` → `0`. Its section headings run
Observe / Monitors / Control / Replaying a session / Who approved it / Running it / *"It reads the
database, nothing else"* — that last heading is also in tension with the fleet sweep making up to
25 live HTTP round trips to the agent.

The only place any idle threshold is documented is **`docs/cli.mdx:232`**:

> `| \`--idle=MINUTES\` | How long a session must be quiet before it is worth probing. Default \`30\`. |`

— which documents `evestack doctor`, not the dashboard. A reader who finds that line will
reasonably assume the dashboard behaves the same and is tunable the same way. It is not.

The only trace of the banner outside source is **alt text on a screenshot** (`README.md:21` and
`packages/website/lib/copy.ts:316`, was `:298`), which is what the tester found. The feature is advertised in
an image caption and described in no prose anywhere.

## Design recommendations (W3's call, offered as input)

1. **Document the two thresholds** in `docs/dashboard.mdx`, in the same plain voice
   `docs/cli.mdx:232` uses for `--idle`. Say the floor is an hour. A user who kills their agent and
   sees a clean dashboard needs to know they are inside a designed blind window, not looking at a
   broken feature.
2. **Make the banner's gate configurable the way everything else is** — one env var
   (`EVESTACK_FLEET_IDLE_MINUTES`, `EVESTACK_FLEET_STUCK_MINUTES`) read in `inspectFleet`'s
   defaults. Today `?idleMinutes=` exists but is unreachable from the only surface that renders.
3. **Distinguish "not looked at" from "looked at and clean"** in the payload (this is already
   §3.2). Concretely: gate D means a session filtered out is in **neither** `checked` nor
   `unchecked`, and `uncheckedCandidates()` hard-returns `0` when `rows.length === 0`
   (`lib/fleet.ts:189`). A `candidates` or `skipped` field, or an explicit `oldestCandidateAgeMs`,
   would make `{checked: 0}` readable.
4. **Nothing asserts the end-to-end wedge.** `contract/runtime/probes/06-fleet-wedge-evidence.probe.mjs`
   tests hand-copied SQL against a fixture and says so in its own header
   (*"THIS PROBE DOES NOT PIN fleet.ts"*); `probes/12-fleet-live-classification.probe.mjs` is the
   only live one and must pass `idleMinutes=0` to see anything, with a comment saying the default
   30 would make the section assert over an empty list. Neither ever asserts
   `health === "wedged"`. That is a W7 item.

---

# 8.3 — macOS and Node 26

## Verdict

A macOS CI job is **cheap, partial, and worth adding** — but it buys much less than it looks like,
and the README's honesty is the reason it is not urgent. Windows deserves the *opposite* treatment:
not a CI job, but a decision to delete the nine branches or admit they are decorative.

## What CI is today

`[PROVEN]` 14 job definitions, 15 instances after matrix expansion. **Every single one is Linux.**
The only non-`ubuntu-latest` runner in the repo is `ubuntu-24.04-arm`
(`publish-dashboard.yml:245`). Node is pinned only by a literal `node-version: 24` in six
`setup-node` steps in `ci.yml` (lines 34, 120, 221, 462, 510, 684) — no `.nvmrc`, no `volta`.
pnpm is pinned once, at `package.json:11` (`pnpm@10.27.0`).

## What a macOS job would cost

`[PROVEN]` **5 of the 15 jobs cannot be ported at all.** `runtime`, `dashboard-image`, `evals`,
`eve-watch` and `provider-bisect` all use a `services:` container block, which needs a Docker
daemon. GitHub-hosted macOS runners do not have one.

That leaves 5 portable jobs: `typecheck`, `test`, `dashboard-build`, `scaffolder`, `registry`.

Three concrete edits would be required:

| edit | file:line | why |
|---|---|---|
| drop `--with-deps` | `ci.yml:168` | `playwright install --with-deps` is the apt-get path, Ubuntu only |
| `psql` not on PATH | `ci.yml:268, :273, :274` | macOS runner images do not ship it |
| `xargs -r` | `provider-bisect.yml:136` | GNU extension; BSD `xargs` rejects it (only matters if that job is ever ported) |

`[ESTIMATE]` Runner cost: macOS minutes bill at **10×** Linux on private repos, free on public. The
repo has no `timeout-minutes` on anything except `dashboard-image.yml:86`, so a hung macOS job would
run to the 6-hour default.

The cheapest useful subset is **`typecheck` + `registry` + `dashboard-build`**. `registry` does no
`pnpm install` at all. `test` is the expensive one — full install, full build, a Chromium download,
and a Playwright run that itself does a Next build (`globalTimeout: 10 * 60_000`).

**The strongest single data point:** `[PROVEN]` I ran `node contract/run.mjs` on this macOS 26.5.2 /
Node 26 machine:

```
22 contracts, 508 assertions — all green against eve 0.30.8
node contract/run.mjs  0.63s user 0.77s system 77% cpu  1.807 total
```

The static contract tier is **already green on darwin, in 1.8 seconds, with zero changes**. Adding
it to a macOS job is free.

## What a macOS job would catch

`[PROVEN]` Less than the platform table implies, because **every platform-gated test in the repo
already runs on darwin.** There is no test anywhere gated *to* darwin. The ten gated tests are all
`skip: process.platform === "win32"` — they run on Linux today and would simply run again.

The real delta:

1. **Six POSIX file-mode assertions** — `packages/create-evestack/test/attach-writes.test.mjs:312,
   320, 336` and `test/credentials.test.mjs:88, 104, 129`. `chmod 0600` on APFS vs ext4. This is the
   most plausible source of a genuine macOS-only failure, and it is on the security-relevant path
   (`.env.local` mode).
2. **The three `darwin` `open` branches** — `packages/evestack-cli/src/project.mjs:354`,
   `src/tour.mjs:393`, `templates/default/scripts/verify.mjs:569`. Never executed by CI today.
3. **Two `spawn`-without-`shell` tests** — `templates/default/test/eve-binary.test.mjs:77, 87`,
   exercising `node_modules/.bin/eve` resolution under a scrubbed PATH. BSD `execvp` semantics.
4. **`--use-angle=metal`** in `packages/website/playwright.config.ts:48` — a macOS-only Chromium
   flag that is inert on Linux and would go live on a macOS runner.
5. **A fourth `darwin` branch the docs do not know about** — `[PROVEN]`
   `contract/runtime/repro/eve-turn-wedge.mjs:162`: `if (process.platform !== "darwin") return true;`
   then `execFileSync("sysctl", ["-n", "vm.swapusage"])`. This is the *only* code in the repo that
   runs macOS-specific syscall tooling, and **`docs/support.mdx:78` says "the only `darwin` branches
   are the three helpers that shell out to `open`"**. That sentence is wrong. It is a manual repro
   script, not run by CI, so the risk is low — but the support statement is a promise about the
   code, and it miscounts.

## Recommendation

Add a **single, cheap, non-blocking macOS job**, not a duplicate matrix:

```yaml
macos:
  runs-on: macos-latest
  timeout-minutes: 20
  # typecheck + contract + the POSIX-mode unit tests. No Playwright, no Docker, no Postgres.
```

That gets items 1, 2, 3 and the contract tier. It leaves the runtime tier Linux-only, which is
honest — the runtime tier needs Postgres and Docker and would either need
`ikalnytskyi/action-setup-postgres` or would have to drop `--require` and **report green having
checked nothing** (`contract/README.md:139-141`: *"A probe that cannot run skips locally and fails
under `--require`"*).

Then update the three places that would become wrong:

- `README.md:132` — "Every job in `.github/workflows/ci.yml` runs on `ubuntu-latest`"
- `README.md:134` — the macOS row
- `docs/support.mdx:62-64` — "all six `actions/setup-node` steps in `ci.yml` pin `node-version: 24`"
  (a seventh would exist), and `docs/support.mdx:76, 78`

## Node 26

`[PROVEN]` The entire acceptance test ran on **Node 26.0.0** against packages declaring
`"engines": { "node": ">=24" }`, and nothing version-specific broke. `README.md:125` is careful and
correct — "24 is the only major CI installs" is a statement about CI, not a ceiling — but it reads
to a stranger as a warning, and one data point now exists that it is not.

`[INFERRED]` Adding `node-version: [24, 26]` as a matrix on the two cheap Linux jobs (`typecheck`,
`registry`) would cost near-nothing and turn "we only test 24" into "we test 24 and the current
major". That is a smaller change than the macOS job and probably a better return, because the
README's Node sentence is the one most likely to make a user downgrade unnecessarily.

## Do the nine Windows branches deserve the same treatment?

**No, and the docs already argue this well.** `docs/support.mdx:107-108` says exactly the right
thing: *"a CI job on `windows-latest` is the contribution that would change this row — not a bug
report saying it did not work."*

Two corrections to that section, both `[PROVEN]`:

1. **The count is arguably ten, not nine.** `templates/default/scripts/checks.mjs:389` —
   `export function eveBinary(scriptUrl, platform = process.platform) { if (platform === "win32") return "eve"; …}`
   — is a tenth win32 branch, and it is the **only one that is already tested**:
   `templates/default/test/eve-binary.test.mjs:115` calls `eveBinary(url, "win32")` and asserts.
   So "not one of them is exercised anywhere" (`docs/support.mdx:85-86`) is true of the nine and
   false of this tenth. That is a good thing worth saying — it is also the pattern the other nine
   should follow.
2. **Two stale line references.** `docs/support.mdx:96` cites
   `templates/default/scripts/start.mjs:44`; the actual branch is at **line 54** (line 44 is
   `const passthrough = process.argv.slice(2);`). `docs/support.mdx:92` cites `project.mjs:353`
   (the destructuring line) while the sibling citation points at the actual branch line. Nothing
   catches this: `contract/contracts/16-documented-paths.contract.mjs:43-44` validates that the
   **file** exists and never parses the `:NNN` suffix.

`[INFERRED]` The cheap, high-value move for Windows is not a `windows-latest` job — it is to make
the other nine branches **injectable the way `eveBinary` already is**, taking `platform` as a
defaulted parameter, and unit-test both sides on Linux. That converts nine untested branches into
nine tested ones for the price of nine parameters, on the runner the repo already pays for. A
`windows-latest` job then becomes a nice-to-have rather than the only path.

---

# 8.4 — Disk footprint

## Verdict

The tester's headline numbers are close on images and **wrong by 20× on volumes**. The real cost of
one running project is about **2.4 GB** on an API-key path and about **7.9 GB** on the recommended
$0 Ollama path. `docs/` gives excellent *retention* guidance and **no absolute figure at all**.

## Correction first: the "1.5 GB of volumes" is not evestack's

`[PROVEN]` `docker system df` reported `Local Volumes … 1.603GB`, which is a machine-wide total.
Per-volume:

| volume | size | owner |
|---|---|---|
| `6a2a19afc307…` | **1.457 GB** | **`kind-control-plane`** (a Kubernetes dev cluster, unrelated) |
| `my-agent-57a02d_evestack-pgdata` | 77.85 MB | evestack project 1 (12 runs, 866 spans, 1 memory) |
| `proj-two-9474fa_evestack-pgdata` | 68.31 MB | evestack project 2 (fresh, 0 sessions) |

**evestack's volume cost is ~68 MB per project empty, ~78 MB after a light session.** Not 1.5 GB.

## Images

`[PROVEN]` `docker system df -v`, Colima / containerd snapshotter. "Total" is the **unpacked**
size; `docker image inspect --format '{{.Size}}'` on this engine reports the **compressed** content
size (verified: the dashboard's `.Size` of 228,171,361 matches the GHCR arm64 manifest's
228,155,254 bytes of layers plus its 16 KB config).

| image | compressed (pull) | unpacked (on disk) | shared | unique |
|---|---|---|---|---|
| `pgvector/pgvector:pg17` | 155.7 MB | 646 MB | 0 | 645.7 MB |
| `ghcr.io/sammytourani/evestack-dashboard:0.3.1` | **231.3 MB** amd64 / **228.2 MB** arm64 (17 layers) | 1.05 GB | 266.6 MB | 785 MB |
| `eve-sandbox-template:<per-project hash>` | built locally | 665 MB | 508.4 MB | **157 MB** |
| `node:24-slim` (base) | 80.3 MB | 349 MB | 266.6 MB | 82.9 MB |

`[ESTIMATE]` Deduplicated total for one project from a clean Docker: **≈ 2.0–2.1 GB**. That matches
the observed `13.88 GB → 15.89 GB` delta of **2.01 GB** almost exactly.

`[PROVEN]` The **sandbox template image is built on first run** and is per-project — the hash
embeds the project id. Two projects on this machine produced two 665 MB template images sharing
508.4 MB, so **each additional project costs ~157 MB** of template image. `docker history` shows it
is a Debian base with Node 24 + pnpm (354 MB in one apt layer). Nothing prunes these; the stale one
from the Aug 6 round is still on disk.

**Sidebar for W4.3 (not my lane, but measured):** the real compressed pull for
`evestack-dashboard:0.3.1` is **231 MB (amd64) / 228 MB (arm64)**. So the installer's "~200 MB",
`docs/cli.mdx:50`'s "200 MB" and quickstart/self-hosting's "~204 MB compressed" are all a bit low,
and the npm README's "~400 MB" is roughly double. If one number is to be picked, **~230 MB** is the
measured one.

## Everything outside Docker

`[PROVEN]`

| thing | size | note |
|---|---|---|
| project directory | **304 MB** | of which `node_modules` 263 MB, `.eve` 40 MB |
| ↳ `.eve/dev-hosts` | 30 MB | 2 host generations |
| ↳ `.eve/dev-runtime` | 11 MB | 3 snapshots (~3.7 MB each); 2 already marked `retired.json` and still on disk |
| Ollama models (`~/.ollama`) | **7.4 GB** | `qwen3` 5.2 GB + `qwen3:4b` 2.5 GB + `nomic-embed-text` 274 MB |
| ↳ the documented $0 path only | **≈ 5.5 GB** | `qwen3` + `nomic-embed-text` |
| whole `evestack-stranger-test/` tree | 877 MB | three scaffolds |

## Honest planning numbers

`[ESTIMATE]`, built from the measured rows above.

**One project, API-key path (no local model), clean Docker:**

| | |
|---|---|
| network transfer | ~390 MB compressed (dashboard 231 + pgvector 156) |
| Docker images on disk | ~2.0 GB |
| Docker volume | ~70 MB |
| project directory | ~300 MB |
| **total** | **≈ 2.4 GB** |

**One project, the recommended $0 Ollama path:**

| | |
|---|---|
| the above | 2.4 GB |
| `qwen3` + `nomic-embed-text` | 5.5 GB |
| **total** | **≈ 7.9 GB** |

**Each additional project on the same machine:** `≈ 0.5 GB` — its own sandbox template image
(157 MB), its own pgdata volume (70 MB), its own `node_modules` (263 MB). The dashboard and
pgvector images are shared.

**A sensible "free disk before you start" line for the docs:** **10 GB** on the Ollama path,
**4 GB** with an API key. That leaves headroom for growth, which the flat numbers do not.

## What grows over time

`[PROVEN]` measured, unless noted:

| what | rate | bounded? |
|---|---|---|
| `evestack.spans` | 866 rows = 1344 kB → **~1.55 KB/span**; ~72 spans/run in this workload → **~110 KB/turn** | **yes** — 30-day window, `EVESTACK_TRACE_RETENTION_DAYS`, hourly on ingest (`docs/operations.mdx:207`) |
| `workflow.*` schema | 12 runs → 192 kB runs + 424 kB stream chunks + 392 kB events | **no** — `docs/operations.mdx:194`: *"the `workflow` schema is never pruned"*. `npm run db:prune` is manual |
| Postgres volume | 68.31 MB fresh → 77.85 MB after 12 runs. Logical DB 11 MB → 13 MB | grows; space is **not returned to the filesystem** without `VACUUM FULL` (`docs/operations.mdx:374`) |
| container logs | — | **yes** — 10 MB × 3 files × 2 containers = 60 MB cap, via `x-logging` in the generated compose (`docs/operations.mdx:150-171`) |
| `.eve/dev-runtime/snapshots` | ~3.7 MB per rebuild | retired snapshots are marked but **were still on disk** — 3 present, 2 retired, after ~1 hour |
| `.eve/dev-hosts` | ~15 MB per host generation | 30 MB for 2. No documented cleanup |
| `eve-sandbox-template:*` images | +157 MB per project / template hash | **no** — nothing prunes them; a 6-day-old one is still resident |
| session sandbox containers | 20.5 kB writable layer each | negligible in bytes, but they persist: *"`/workspace` across turns with no idle timeout"* (`docs/self-hosting.mdx:278`) |

`[ESTIMATE]` A project doing 50 turns/day settles at roughly **+200 MB/year** of Postgres under the
default 30-day span window, dominated by the never-pruned `workflow` schema. The span table itself
is self-limiting.

## The documentation gap

`[PROVEN]` The docs are *good* on retention and *silent* on absolute size.

**Present and genuinely useful:**
- RAM budgeting, with a real number and a real failure story — `docs/local-setup.mdx:69-71`,
  `README.md:128-131` (*"Budget **both model sizes + 4 GB** free … the 274 MB embedding model"*)

  > *Corrected on review (round 3).* This read `README.md:115-118` and quoted *"qwen3 is 5.2 GB
  > … budget both model sizes + 4 GB"*. Both halves were wrong: the RAM section is at
  > **`:128-131`**, and **`rg -n '5\.2 GB' README.md` returns nothing** — README never states
  > qwen3's size. The 5.2 GB figure is real but comes from `diary.md:15` and this file's own
  > `:717`, not from README. A paraphrase set in quotation marks and attributed to a file that
  > does not contain it is the same defect as a wrong line number, and harder to catch, because
  > the sentence reads like evidence. The substance stands: README does budget RAM, with a real
  > failure story.
- log bounding with the reasoning — `docs/operations.mdx:150-171`
- span retention and `db:prune` — `docs/operations.mdx:194-279`
- the `VACUUM FULL` caveat — `docs/operations.mdx:374`

**Absent everywhere:**
- any figure for what the stack costs on disk. Grepped `docs/` and `README.md` for
  `disk|GB|space|df -h|docker system prune` — nothing states a total.
- the **sandbox template image** as a disk cost. It appears twice, both times as a runtime fact
  (`docs/operations.mdx:35`, `docs/self-hosting.mdx:279-280`), never with a size and never with a
  note that it is per-project and unpruned. It is the third-largest single item on disk.
- `.eve/` growth. 40 MB after an hour, with no documented cleanup.
- any `docker system prune` / image-reclaim guidance. The only cleanup mentioned in all of `docs/`
  is `docker compose down -v` (`docs/upgrading.mdx:232`), which is about *data loss*, not space.

**Suggested addition** — a short "What it costs on disk" block in `docs/local-setup.mdx`, right
beside the RAM warning that already works so well:

> **Check your free disk too.** A running project is about **2.4 GB**: ~2 GB of Docker images
> (Postgres 646 MB, the dashboard 1.05 GB unpacked from a 230 MB pull, and a 665 MB sandbox
> template image eve builds on first run), ~70 MB of Postgres volume, and ~300 MB of
> `node_modules`. On the $0 Ollama path add **5.5 GB** for `qwen3` and `nomic-embed-text`. A second
> project on the same machine costs about **0.5 GB** — the big images are shared, the sandbox
> template and the database are not. Budget **10 GB free** on the local-model path, **4 GB** with an
> API key.
>
> It grows slowly. Spans self-prune on a 30-day window; the `workflow` schema does not prune itself
> at all (see Operations). The one thing nothing cleans up is the per-project
> `eve-sandbox-template:*` image — `docker image prune` after you delete a project.

---

## Loose ends handed to other lanes

- **W5 / `create-evestack`:** run `git init` at the end of `create`. Fixes 8.1 entirely, and makes
  the shipped `.gitignore` meaningful. `[PROVEN]` effective.
- **W3 / dashboard:** the two thresholds are 30 min (probe gate) and 60 min (wedge cut); the UI
  cannot be tuned at all because `fleet-banner.tsx:18` calls `inspectFleet()` with no arguments.
- **W4 / copy:** measured compressed pull for `evestack-dashboard:0.3.1` is **231 MB amd64 /
  228 MB arm64**. Also `docs/support.mdx:78` ("the only `darwin` branches are the three helpers")
  is wrong — there is a fourth at `contract/runtime/repro/eve-turn-wedge.mjs:162` — and
  `docs/support.mdx:96` cites `start.mjs:44` where the branch is at line 54.
- **W7 / tests:** nothing anywhere asserts `health === "wedged"` end to end.
  `06-fleet-wedge-evidence.probe.mjs` says so about itself in its own header.
- **State drift:** `wrun_01KZN0EEQDSCPHQM5YHCRQYM6P` is now `completed`. §3.3's premise that it is
  permanently open no longer holds on the live database. Other agents are on the stack, so I cannot
  attribute the change.
