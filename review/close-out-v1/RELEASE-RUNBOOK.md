# Release runbook — dashboard 0.4.0 and the four npm bumps

Written for a session on **another machine**, with Docker capacity and the credentials, and
nothing else from the context that produced this branch. Everything below was verified from a
checkout of `8528cd4` (branch `close-out-v1`, PR #45) on 2026-08-11 unless a line says it was
inferred.

The machine this was written on could not build the image — 8 GB, two prior crashes. So this
document's job is to make the publish a single unattended command by proving everything *around*
it first. What was proved, and how, is in the last section; read it if a step surprises you.

---

## 0. The one thing that is not in RELEASING.md

**The dashboard image must be published BEFORE `create-evestack@0.10.0`.**

`RELEASING.md` → "Order matters" documents the npm chain
(`budget`/`composio`/`schedules` → `create-evestack` → `evestack`) and it is correct. It says
nothing about the image, because until this release the image and the scaffolder never moved in
the same cut.

They do here. `packages/create-evestack/shared.mjs` pins `DASHBOARD_IMAGE_TAG = "0.4.0"`, so
every project `create-evestack@0.10.0` scaffolds writes
`ghcr.io/sammytourani/evestack-dashboard:0.4.0` into its `docker-compose.yml`. Publish the
scaffolder first and every `npx create-evestack` between the two publishes reaches a tag GHCR
does not serve.

Measured, so you know the direction of the risk:

| | pins | exists? |
| --- | --- | --- |
| `create-evestack@0.9.2` (live on npm right now) | dashboard `0.3.1` | yes |
| `create-evestack@0.10.0` (this tree) | dashboard `0.4.0` | **no — until step 3** |

GHCR today (`tags/list`, anonymous): `0.1.0`, `0.2.0`, `0.3.0`, `0.3.1`, `latest`.

So the ordering law for this release is:

```
dashboard image 0.4.0
        │
        ├─→ @evestack/composio 0.2.1 ┐
        │   @evestack/schedules 0.2.1 ├─→ create-evestack 0.10.0 ─→ evestack 0.4.1
        │   (@evestack/budget 0.2.1 already published)
```

`@evestack/budget`, `@evestack/mcp` and `@evestack/sandbox-opensandbox` are **not** republished.
Their local tarballs are byte-identical to what npm serves — verified, see §9.

---

## 1. Preflight — before you touch anything

Run all of it. It is cheap and every line has caught something in this repository's history.

```bash
git clone https://github.com/SammyTourani/evestack && cd evestack
git checkout main && git pull

# You must be on a commit that carries 0.4.0. If PR #45 is not merged yet, merge it first
# (step 2) — do not tag close-out-v1.
node -p "require('./packages/dashboard/package.json').version"     # must print 0.4.0
grep -n 'DASHBOARD_IMAGE_TAG' packages/create-evestack/shared.mjs  # must print 0.4.0

corepack enable
pnpm install --frozen-lockfile
pnpm -r typecheck                       # must be clean
pnpm -r test                            # must be green
node contract/run.mjs                   # 23 contracts, 545 assertions
node registry/build.mjs && git diff --stat registry/   # must produce NO diff

# credentials
npm whoami                              # must print the account that owns the packages
gh auth status                          # needs repo scope; the workflow uses GITHUB_TOKEN, not yours
docker info                             # you need a working daemon only for the stranger test in §8
```

**The tag `:0.4.0` must not already exist on GHCR.** Nothing in the publish workflow checks this,
and `docker buildx imagetools create` will happily move an existing tag — see §10, gap 3.

```bash
tok=$(curl -s 'https://ghcr.io/token?scope=repository:sammytourani/evestack-dashboard:pull&service=ghcr.io' \
      | sed 's/.*"token":"\([^"]*\)".*/\1/')
curl -s -H "Authorization: Bearer $tok" \
     'https://ghcr.io/v2/sammytourani/evestack-dashboard/tags/list'
# 0.4.0 must NOT be in the list. If it is, STOP and find out who published it.
```

**Replay the version gate locally.** This is the gate that will run in CI; running it here costs
two seconds and turns a failed release into a failed shell command.

```bash
version="$(node -p "require('./packages/dashboard/package.json').version")"
pinned="$(node -p "
  const src = require('fs').readFileSync('packages/create-evestack/shared.mjs','utf8');
  const m = src.match(/DASHBOARD_IMAGE_TAG = \"([^\"]+)\"/); m ? m[1] : '';
")"
[ "$pinned" = "$version" ] || { echo "shared.mjs pins $pinned, dashboard is $version"; exit 1; }

found=0; bad=0
while IFS= read -r hit; do
  found=$((found+1)); tag="${hit##*evestack-dashboard:}"; [ -n "$tag" ] || continue
  [ "$tag" = "$version" ] || { echo "MISMATCH $hit"; bad=1; }
done <<< "$(git grep -n -o -E 'evestack-dashboard:[0-9][A-Za-z0-9._-]*' \
            -- . ':!*.lock' ':!pnpm-lock.yaml' ':!CHANGELOG.md' ':!review/' || true)"
[ "$bad" = 0 ] && [ "$found" -ge 2 ] && echo "OK: $found pins, all $version"
```

Expected on this tree: `OK: 6 pins, all 0.4.0` — `contract/contracts/19-env-names.contract.mjs`,
`docker-compose.yml`, `docs/self-hosting.mdx`, `docs/uninstall.mdx`, `docs/upgrading.mdx`,
`packages/create-evestack/test/dashboard-pull.test.mjs`.

**Confirm the changelog section exists.** If it does not, the publish fails in `version` before
anything is built — which is the correct place to fail, but you would rather know now:

```bash
awk -v h="### @evestack/dashboard@0.4.0" '
  index($0, h " ") == 1 || $0 == h { found = 1; next }
  found && /^###? / { exit }
  found { print }
' CHANGELOG.md | grep -q '[^[:space:]]' && echo "release notes present"
```

---

## 2. Merge PR #45, and land the three prose edits in the same commit

PR #45 (`close-out-v1` → `main`, head `8528cd4`) was `MERGEABLE` / `CLEAN` with CI 9-of-9 green
when this was written. Merge it.

Then, **before tagging**, land one commit on `main` fixing three strings that the release makes
false and that no gate can see. Doing it before the tag means the tagged tree is the correct one;
the window in which the repo claims a not-yet-published image is a few minutes and is invisible
next to the window in which it claims the opposite for as long as nobody notices.

1. **`CHANGELOG.md:767`** — `### @evestack/dashboard@0.4.0 — unreleased` → `— 2026-08-11`
   (dates are `America/Los_Angeles`, per RELEASING.md). Verified: the release-notes gate still
   matches the date form and still extracts all 62 lines.

2. **`README.md:68`** — currently reads *"The newest **published** tag is `0.3.1`, which is what
   `npx evestack create` pins today; this tree pins `0.4.0`, which is not on GHCR yet, so
   `docker compose pull` from a checkout 404s until that release is cut"*. Every clause of that
   becomes false the moment this release lands, and it is the front page of the repository.
   Rewrite it **without a version number in it** — RELEASING.md's own lesson, twice-learned, is
   that a version written into prose is a snapshot with an expiry date nobody sets. Something
   like: *"The dashboard step is a pull, not a build: the image is published for `linux/amd64`
   and `linux/arm64`, ~230 MB compressed per platform, at the tag the scaffolder pins."*

3. **`packages/website/lib/copy.ts:524`** — `{ name: "dashboard image", detail: "0.4.0, matching
   the pin" }`. Correct after this release, but it is a hand-typed mirror of `verify.mjs` output
   with nothing tying it to the real pin, and the publish gate's scan cannot see it (it matches
   `evestack-dashboard:<digit>…`, and this is a bare version). At minimum confirm it says
   `0.4.0`; better, derive it from `packages/dashboard/package.json` at build time.

Also update `## Unreleased` (`CHANGELOG.md:53–90`): the pointer paragraph and the
"Bumped and waiting to publish" block describe exactly this release and should move down into the
per-package sections as each publish lands (RELEASING.md, "Release notes", step 1).

After the commit, **re-run the preflight gate replay from §1** — the `git grep` scan reads the
working tree, so an edit can break it.

---

## 3. Publish the dashboard image

The tag push *is* the publish. There is no other command.

```bash
git checkout main && git pull
git log -1 --oneline                       # this is the commit that gets published
node -p "require('./packages/dashboard/package.json').version"   # 0.4.0, one more time

git tag -a '@evestack/dashboard@0.4.0' -m 'dashboard 0.4.0'
git push origin '@evestack/dashboard@0.4.0'
```

Quote the tag. It contains `/` and a leading `@`; `git check-ref-format` accepts it and it
round-trips through `tag -l`, `rev-parse` and `describe` — the `@evestack/dashboard@0.3.0` and
`@0.3.1` tags are the proof, both live.

**Do not use the `dashboard-v*` form.** The workflow still accepts it, warns, and it exists only
so `dashboard-v0.1.0` and `dashboard-v0.2.0` stay re-runnable.

### What runs, in order

`.github/workflows/publish-dashboard.yml`, four jobs:

| job | needs | what it does | what it costs if it fails |
| --- | --- | --- | --- |
| `version` | — | reads `packages/dashboard/package.json`; checks the tag, the `shared.mjs` pin, every written-out `evestack-dashboard:<digit>…` in the tree, and that `CHANGELOG.md` has a `### @evestack/dashboard@0.4.0` section | **nothing.** Fails before any build. This is the safe failure. |
| `build` (×2) | `version` | `docker/build-push-action@v6` from the repo **root** with `packages/dashboard/Dockerfile`, one native runner per arch (`ubuntu-latest`, `ubuntu-24.04-arm`), pushed **by digest** with no tag | nothing published. Digests are anonymous. |
| `merge` | `version`, `build` | `imagetools create` assembles both digests into `:0.4.0` **and moves `:latest`**; then logs out and proves an anonymous pull | **this is the point of no return.** See rollback. |
| `release` | `version`, `merge` | lifts the `### @evestack/dashboard@0.4.0` section out of `CHANGELOG.md`, appends the `docker pull` line, `gh release create --verify-tag` | image is live with no release page. Re-runnable; idempotent (`gh release edit` if it exists). |

Secrets: **none to create.** `docker/login-action` uses `secrets.GITHUB_TOKEN`;
`permissions: packages: write` on `build` and `merge` is the entire authorisation story.
`release` takes `contents: write` and writes only a release. `ubuntu-24.04-arm` is free because
the repository is public (`visibility: "public"`, confirmed via the API).

### Watch it

```bash
gh run watch --repo SammyTourani/evestack \
  "$(gh run list --repo SammyTourani/evestack --workflow publish-dashboard.yml --limit 1 --json databaseId -q '.[0].databaseId')"
```

Reference: the `@evestack/dashboard@0.3.1` publish (run `31352071641`) took **3m44s** with all
five job instances green, including `build (linux/arm64, ubuntu-24.04-arm)`.

### Failure points, and what each means

- **`version` fails on the tag.** `::error::tag … does not match packages/dashboard/package.json`.
  Nothing published. Delete the tag (`git push --delete origin '<tag>'`), fix, re-tag.
- **`version` fails on a pin.** `::error::… pins X, but packages/dashboard/package.json is 0.4.0`.
  Nothing published. This has fired in production — run `31347805964`, 11 seconds, `build`/`merge`/
  `release` all skipped. The gate is real.
- **`version` fails on the scan count.** `only N pinned image tags were found; the scan is broken`.
  Someone renamed the image or removed pins. Fix the tree, not the threshold.
- **`version` fails on the changelog.** Nothing published. Add the section on `main`, delete and
  re-push the tag.
- **`build` fails.** Nothing tagged. The same Dockerfile built and *ran* green on this exact tree
  in `dashboard-image.yml` run `31484437781` (4m8s) — but that job builds **`linux/amd64` only**.
  The arm64 leg is the one this tree has never exercised. If exactly one arch fails, that is where
  to look first; `fail-fast: false` means you get both results.
- **`merge` fails at `imagetools create`.** Possible partial state: check the tag list before
  retrying.
- **`merge` fails at "prove it pulls".** The image is already live and `:latest` has already
  moved. It means the package is not anonymously pullable. Set it public at
  `https://github.com/users/SammyTourani/packages/container/evestack-dashboard/settings`, then
  re-run the failed jobs. (This is a first-publish failure mode and should not happen here — the
  package has been anonymously readable since `0.1.0`, confirmed by the unauthenticated
  `tags/list` call in §1.)
- **`release` fails.** Image is live, no release page. Re-run the job. Artifact retention is
  1 day, so a re-run of `merge` after that needs a full re-run including `build`.

### Verify

```bash
docker buildx imagetools inspect ghcr.io/sammytourani/evestack-dashboard:0.4.0
# both linux/amd64 and linux/arm64 in the index
docker logout ghcr.io
docker buildx imagetools inspect ghcr.io/sammytourani/evestack-dashboard:0.4.0   # anonymous
gh release view '@evestack/dashboard@0.4.0' --repo SammyTourani/evestack
```

### Rollback

There is no clean one, and that is the design. `:0.4.0` is immutable in practice — every
scaffolded `docker-compose.yml` pins it — so **do not delete or move it** once anything could
have pulled it. What you can do:

- `:latest` has moved to 0.4.0. To put it back:
  `docker buildx imagetools create --tag ghcr.io/sammytourani/evestack-dashboard:latest ghcr.io/sammytourani/evestack-dashboard:0.3.1`
- If 0.4.0 is broken, **roll forward to 0.4.1**, do not roll back. `CHANGELOG.md` at
  `### @evestack/dashboard@0.4.0` carries a `<Warning>`: 0.3.1 and earlier install spans v3 /
  facts v1 and have no downgrade guard, so putting an older image over a v4 database leaves the
  spans marker at 4 with the v3 resolver in place while facts decrements 2→1 and is rebuilt.
  Re-upgrading repairs both, but a rollback is not clean.
- **Do not stop after step 3 if you have started step 5.** An image without its scaffolder is
  harmless; a scaffolder without its image is a 404 for every new user.

---

## 4. `@evestack/composio` 0.2.1 and `@evestack/schedules` 0.2.1

Both are template dependencies. Both must exist on npm before `create-evestack`.

**Every `npm publish` below needs a 2FA one-time code, so a human has to run them in an
interactive terminal.** npm prompts `This operation requires a one-time password:` and reads it
from the TTY. An agent or a CI shell has no TTY, so the publish fails with *"You can provide a
one-time password by passing --otp"* — which reads like a flag was forgotten rather than like the
credential gate it is. Nothing is published when this happens; `npm view` still reports the old
version, so it is safe to simply re-run. Confirm the session is authenticated first, because a
`npm login` token can go invalid between login and publish:

```bash
npm whoami   # must print your username, not E401
```

```bash
npm publish ./packages/evestack-composio
npm publish ./packages/evestack-schedules
```

`prepack` runs `tsc -p tsconfig.json`; `publishConfig.access: public` is already set on both
(a scoped package defaults to restricted without it). `npm pack --dry-run` was run against this
tree: composio ships 13 files / 14.9 kB (`dist/`, `src/`, README, LICENSE), schedules ships
23 files / 39.3 kB. Nothing stray, no `node_modules`, no `.env`.

Neither depends on the other or on anything else in the chain.

**Between steps — do not skip:**

```bash
npm view @evestack/composio version    # 0.2.1
npm view @evestack/schedules version   # 0.2.1
npm view @evestack/budget version      # 0.2.1 — already published, confirm it is still there
```

Tags (annotated, after the publish):

```bash
git tag -a '@evestack/composio@0.2.1'  -m 'composio 0.2.1'  && git push origin '@evestack/composio@0.2.1'
git tag -a '@evestack/schedules@0.2.1' -m 'schedules 0.2.1' && git push origin '@evestack/schedules@0.2.1'
```

**Rollback:** within 72 hours, `npm unpublish @evestack/composio@0.2.1`. After that the version
is permanent and the only exit is 0.2.2. Nothing depends on these yet at this point in the
sequence, so an unpublish here is genuinely safe.

---

## 5. `create-evestack` 0.10.0

**Only after step 4's `npm view` lines have printed 0.2.1 three times.**

```bash
npm publish ./packages/create-evestack
npm view create-evestack version        # 0.10.0
git tag -a 'create-evestack@0.10.0' -m 'create-evestack 0.10.0'
git push origin 'create-evestack@0.10.0'
```

`prepack` runs `scripts/sync-template.mjs`, which copies `templates/default` into `template/` and
rewrites the three `workspace:*` ranges. Measured on the tree that actually shipped 0.10.0 — the
tarball ships 57 files / 186.6 kB with:

```json
"@evestack/budget": "^0.2.1",
"@evestack/composio": "^0.2.1",
"@evestack/schedules": "^0.2.1"
```

and **no `workspace:` string anywhere** in `template/`. Those are the three that must already
resolve. `template/` is gitignored and generated at pack time; if it is stale in your checkout,
`npm pack --dry-run` regenerates it.

That file count is one-to-one with `templates/default`, so it moves whenever the template does —
0.10.0 shipped 57 rather than the 56 this section first recorded because `test/fence.test.mjs` was
added. Do not treat a mismatch as a defect on its own; the property worth checking is that nothing
*stray* is in the tarball. Derive that instead of comparing counts:

```bash
npm pack --dry-run ./packages/create-evestack 2>&1 | grep -cE 'node_modules|/\.env$|\.npmrc'   # 0
```

`template/.env.example` is expected and is not a credential — it is the file the scaffolder copies.

**Rollback:** `npm unpublish create-evestack@0.10.0` inside 72h. Note that this is the version
that pins the 0.4.0 image, so if step 3 failed and you got here anyway, unpublishing is the
correct move.

---

## 6. `evestack` 0.4.1 — **pnpm, not npm**

```bash
pnpm --filter evestack publish --access public --no-git-checks
npm view evestack version               # 0.4.1
git tag -a 'evestack@0.4.1' -m 'evestack 0.4.1' && git push origin 'evestack@0.4.1'
```

`--no-git-checks` is required whenever you publish from a detached worktree, which is how §1 tells
you to stage the release. pnpm's default guard refuses with `ERR_PNPM_GIT_UNKNOWN_BRANCH` because
`publish-branch` is `master|main` and a detached HEAD is on neither. That guard is a proxy for "you
are shipping what main says"; satisfy the real property directly before you pass the flag:

```bash
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" && echo "same as main"
```

Do not fix this by checking out a branch in the release worktree — the point of detaching is that
another session may be moving `main` under you, which happened during the 0.4.0 release.

`evestack` declares `create-evestack: workspace:^`. npm has never implemented that protocol and
would ship the range verbatim, so every install would end at `Unsupported URL Type "workspace:"`.
`packages/evestack-cli/scripts/prepack.mjs` refuses rather than letting it through — measured:
`npm pack --dry-run` in that directory exits 1 with *"refusing to pack — create-evestack@workspace:^
would ship as a literal `workspace:` range that npm cannot install"*.

`pnpm pack` resolves it correctly — measured, the tarball manifest reads
`"create-evestack": "^0.10.0"`. Which is why step 5 has to be finished and confirmed first.

**Rollback:** `npm unpublish evestack@0.4.1` inside 72h.

---

## 7. Nothing else publishes

`@evestack/budget` (0.2.1), `@evestack/mcp` (0.3.0) and `@evestack/sandbox-opensandbox` (0.4.0)
are at the same version locally and on npm, **and their contents match** — each local `npm pack`
tarball unpacks byte-identical to the published one (§9). Do not republish them. Do not bump them.

Derive the list rather than trusting this paragraph:

```bash
for f in packages/*/package.json; do
  node -e "const p=require('./$f'); if (!p.private) console.log(p.name, p.version)"
done | while read -r name local; do
  printf '%-34s local %-8s npm %s\n' "$name" "$local" "$(npm view "$name" version 2>/dev/null || echo MISSING)"
done
```

`MISSING` on a template dependency is the emergency. After a complete run, every row should match.

---

## 8. Verify from a stranger's position

In a directory that is **not** the checkout, on a machine with Docker:

```bash
cd "$(mktemp -d)"
npx create-evestack@latest smoke-test --yes
cd smoke-test
grep -n 'evestack-dashboard' docker-compose.yml     # must read :0.4.0
ls node_modules/eve node_modules/@evestack/composio node_modules/@evestack/schedules
docker compose --profile dashboard up -d --wait
curl -s http://localhost:4000/api/health            # {"ok":true,...,"version":"0.4.0"}
```

The `version` field is the one that matters, not `ok` — `ok` answers "is this process up and can
it reach Postgres" and was true of the old image too.

Then tear it down: `docker compose --profile dashboard down -v`.

---

## 9. What was actually measured before this was written

Everything in this section was run; nothing here is inferred.

- **The version gate passes on this tree** — replayed verbatim from the workflow YAML against a
  clean clone of `8528cd4`: `6 written-out tags all agree on 0.4.0`, exit 0, for
  `workflow_dispatch`, for `@evestack/dashboard@0.4.0`, and (with a warning) for
  `dashboard-v0.4.0`.
- **And it fails when it should.** Four mutations, each on a throwaway clone, each restored:
  a suffixed tag `@evestack/dashboard@0.4.0-rc1` → exit 1 on the tag check; a suffixed *pin*
  `evestack-dashboard:0.4.0-rc1` in `docker-compose.yml` → exit 1 naming the file and line; a
  mismatched `shared.mjs` pin → exit 1; a mismatched pin in `docs/upgrading.mdx` alone → exit 1.
- **The anti-vacuity arm fires.** Renaming the image throughout the tree so the gate's pattern
  matches nothing → `only 1 pinned image tags were found in the tree; the scan is broken and this
  gate checked nothing`, exit 1.
- **The release-notes gate is real.** With `VERSION=0.4.1` (no such section) → exit 1. With the
  0.4.0 section body blanked but the heading kept → exit 1. Restored → 62 lines extracted.
  Changing the heading from `— unreleased` to `— 2026-08-11` → still matches, still 62 lines.
- **The gate has fired in production**: run `31347805964`, `version` job failed in 11 seconds,
  `build`, `merge` and `release` all skipped.
- **CI on `8528cd4`**: run `31484437772`, 9 of 9 jobs green (`test`, `scaffolder`, `macos`,
  `typecheck` ×2, `runtime`, `registry` ×2, `dashboard-build`). Run `31484437781`
  (`Dashboard image`), `image` job green in 4m8s — the Dockerfile builds and the container runs,
  on `linux/amd64`.
- **Locally**: `node contract/run.mjs` → 23 contracts, 545 assertions, all green.
  `node --test contract/lib/*.test.mjs` → 35 pass. `node --test contract/runtime/lib/*.test.mjs`
  → 22 pass. `create-evestack` 148 pass, `evestack-cli` 116 pass, `composio` 20 pass,
  `schedules` 43 pass.
- **`npm pack --dry-run`** on all four bumped packages: sane file lists, correct versions,
  correct rewritten template ranges, and `prepack` refusing `npm` for the CLI.
- **Tarball drift**: `@evestack/budget`, `@evestack/mcp` and `@evestack/sandbox-opensandbox` are
  identical to npm; `composio`, `schedules`, `create-evestack` and `evestack` all differ from
  their published predecessors — so the "identical" result is not a broken comparison.
- **npm and GHCR state** at the time of writing: create-evestack 0.9.2, evestack 0.4.0,
  composio 0.2.0, schedules 0.2.0, budget 0.2.1, mcp 0.3.0, sandbox-opensandbox 0.4.0;
  33 npm versions across the seven packages; GHCR `0.1.0 0.2.0 0.3.0 0.3.1 latest`.
- **The published `create-evestack@0.9.2` tarball pins `DASHBOARD_IMAGE_TAG = "0.3.1"`** — read
  out of the real tarball, not inferred from the changelog. That is why `npx create-evestack`
  works today and why the ordering in §0 is the whole game.

---

## 10. Gaps — things no gate will catch for you

1. **`RELEASING.md`'s release counts are wrong.** It says (`:254`) `gh release list` "prints
   seven rows today" and (`:262`) "**Four** tags have no release: `create-evestack@0.4.0`,
   `dashboard-v0.1.0`, `dashboard-v0.2.0` and `@evestack/dashboard@0.3.1`". Measured: **8**
   releases against **11** tags, and **three** tags have no release —
   `create-evestack@0.4.0`, `dashboard-v0.1.0`, `dashboard-v0.2.0`. `@evestack/dashboard@0.3.1`
   **does** have a release ("dashboard 0.3.1", currently marked Latest), created automatically by
   the `release` job. The "Corrected 2026-08-11" block derived its fourth tag arithmetically
   (11 − 7) instead of reading the list, and flagged that it had done so. Do not use those
   numbers; run `gh release list` and `git ls-remote --tags origin`.

2. **The scaffolder-pin check can be fooled by a comment.** `publish-dashboard.yml:105-109` reads
   `shared.mjs` with `src.match(/DASHBOARD_IMAGE_TAG = "([^"]+)"/)` — first textual match, not the
   module's value. Measured: with `// bumped: DASHBOARD_IMAGE_TAG = "0.4.0"` above
   `export const DASHBOARD_IMAGE_TAG = "0.3.1";`, the gate printed `scaffolder pin agrees: 0.4.0`
   and exited 0, while importing the module yields
   `ghcr.io/sammytourani/evestack-dashboard:0.3.1` — the exact failure the check exists to
   prevent. Not triggered on this tree (one occurrence, on line 40). Fix is one line: import the
   module instead of regexing it.

3. **Nothing checks that the version increments, or that GHCR lacks the tag.** The gate proves the
   pins *agree*; it does not prove the number *moved*. Re-running the workflow on a version that
   is already in GHCR would move a tag that scaffolded projects treat as immutable. That is why
   §1 asks for the `tags/list` call by hand.

4. **CI never runs the version gate.** `ci.yml` has no version-agreement job, so a pin can drift
   on a PR and merge green; you only learn at tag-push time. Safe (the gate runs before anything
   is built) but it means the preflight replay in §1 is the earliest warning you get.

5. **Version literals the gate cannot see.** The scan matches
   `evestack-dashboard:<digit>…` only. Bare versions are invisible to it:
   `packages/website/lib/copy.ts:524` (`"0.4.0, matching the pin"`),
   `docs/upgrading.mdx:123` (`{"ok":true,…,"version":"0.4.0"}`), and `README.md:68`. Deliberate
   non-version tags — `evestack-dashboard:pr…` in `dashboard-image.yml`,
   `evestack-dashboard:local` in `docs/self-hosting.mdx` — are correctly left alone.

6. **A false comment in `packages/create-evestack/shared.mjs:35-38`.** The JSDoc on
   `DASHBOARD_IMAGE_TAG` still says *"PUBLISHED is false until the first GHCR push. It is the only
   edit needed afterwards"* — describing `DASHBOARD_IMAGE_PUBLISHED`, which was deleted, and whose
   tombstone comment sits three lines below saying so. There is no flag to flip. Do not go looking
   for one.

7. **The window in §0 is legible but not free.** `create.mjs`'s `dashboardPullFailure` recognises
   the registry's refusal vocabulary and prints three options instead of pointing at empty logs
   (13 tests, all passing). Option 2 suggests `EVESTACK_DASHBOARD_IMAGE=…:latest` — which during
   the window resolves to 0.3.1, an *older* schema. Harmless on a fresh scaffold, which is the
   only case that can hit the window. It would not be harmless on `evestack attach` against a
   database already at spans v4.
