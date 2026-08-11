# Releasing

Seven packages go to npm. Three are private forever.

Keep this table honest. It said "three packages" while six were already
published, and the three it omitted included two that the scaffolded template
depends on — which is precisely the unrecoverable ordering mistake the next
section exists to prevent. It had been working by luck.

| Package | Directory | Published |
| --- | --- | --- |
| `evestack` | `packages/evestack-cli` | yes — the CLI (`create`, `status`, `tour`, `open`, `verify`, `attach`, `doctor`) |
| `create-evestack` | `packages/create-evestack` | yes — the `npm create` entry point |
| `@evestack/budget` | `packages/evestack-budget` | yes — **template dependency** |
| `@evestack/composio` | `packages/evestack-composio` | yes — **template dependency** |
| `@evestack/schedules` | `packages/evestack-schedules` | yes — **template dependency** |
| `@evestack/mcp` | `packages/evestack-mcp` | yes — standalone |
| `@evestack/sandbox-opensandbox` | `packages/sandbox-opensandbox` | yes — standalone |
| `@evestack/dashboard` | `packages/dashboard` | no — `private: true`, ships as a container image |
| `@evestack/website` | `packages/website` | no — `private: true` |
| `@evestack/template-default` | `templates/default` | no — ships *inside* `create-evestack` |

Derive it, don't trust it:

```bash
# publishable
for f in packages/*/package.json; do
  node -e "const p=require('./$f'); if (!p.private) console.log(p.name, p.version)"
done
# what the scaffold will demand from npm
node -e "const p=require('./templates/default/package.json');
  console.log(Object.keys({...p.dependencies,...p.devDependencies}).filter(k=>k.startsWith('@evestack')))"
```

## Order matters

The dependency chain is **three levels deep**, not one:

```
@evestack/budget ┐
@evestack/composio ├─→ create-evestack ──→ evestack
@evestack/schedules ┘   (carries the template)   (depends on create-evestack)
```

`create-evestack` scaffolds a project that depends on `@evestack/budget`,
`@evestack/composio` and `@evestack/schedules` at the versions in
`templates/default/package.json`. `packages/create-evestack/scripts/sync-template.mjs`
rewrites those `workspace:*` ranges to `^<version>` at pack time, so **all three must exist on
npm before `create-evestack` does**. `evestack` in turn declares
`create-evestack: workspace:^`, so it goes last.

Publish out of order and every `npx create-evestack` in between dies on

```
npm error 404 Not Found - GET https://registry.npmjs.org/@evestack%2fbudget
```

Since a version cannot be unpublished after 72 hours, that is an unrecoverable first impression.
So:

```bash
pnpm install --frozen-lockfile
pnpm -r typecheck                       # must be clean
pnpm -r test                            # must be green
node registry/build.mjs                 # regenerate registry/r from templates/default

# 1. every scoped package the template names. `prepack` builds dist/;
#    `publishConfig.access: public` is required because npm defaults a scoped
#    package to restricted.
npm publish ./packages/evestack-budget
npm publish ./packages/evestack-composio
npm publish ./packages/evestack-schedules

# 2. verify all three resolve before continuing. Do not skip this — it is the
#    only gate between a typo and an unrecoverable 404 for every new user.
npm view @evestack/budget version
npm view @evestack/composio version
npm view @evestack/schedules version

# 3. then the scaffolder. `prepack` copies templates/default into template/ and
#    pins the workspace ranges to the versions just published.
npm publish ./packages/create-evestack
npm view create-evestack version

# 4. then the CLI, which depends on the scaffolder published in step 3.
#    pnpm, NOT npm — and this is the one package where it matters. `evestack`
#    declares `create-evestack: workspace:^`, npm has never implemented that
#    protocol, and `npm publish` would ship the range verbatim so that every
#    install ends at `Unsupported URL Type "workspace:"`. pnpm resolves it as it
#    packs. packages/evestack-cli/scripts/prepack.mjs refuses the npm form
#    rather than letting it through, so the wrong command fails loudly here
#    instead of quietly on every user — but this line said `npm publish` for
#    long enough to be worth correcting.
pnpm --filter evestack publish --access public
npm view evestack version

# Independent of the chain — no other published package names them, so these can
# go at any point.
npm publish ./packages/evestack-mcp
npm publish ./packages/sandbox-opensandbox
```

### Both names are live — check them anyway

This section used to read "Two names are not live yet", and described `evestack@0.0.1` as a
196-byte placeholder with no `bin` field, with the README's first command therefore broken. That
was true on 2026-08-05 and stopped being true on 2026-08-07. It then sat here for two days telling
maintainers the opposite of the truth, which is worse than saying nothing — so what follows is the
check, not a snapshot.

That replacement then went stale itself, forty-four minutes after it was written. It said
`create-evestack` "is at `0.8.0` on npm, matching this repo" at 06:32 on 2026-08-09, and af49a2a
bumped the repo to `0.9.0` at 07:16. Same file, same lesson, twice in one week: a version number
written into prose is a snapshot with an expiry date nobody sets. So this paragraph no longer
carries one.

What is stable enough to write down: both front doors resolve — `npx evestack` and
`npx create-evestack` each reach a package with a real `bin` — and this checkout is normally
*ahead* of npm between a bump and a publish, which is expected rather than a fault. What is never
stable enough: which versions. Ask the registry.

```bash
npm view evestack bin        # must print a bin map, not nothing

# every publishable package, local against npm, in one pass
for f in packages/*/package.json; do
  node -e "const p=require('./$f'); if (!p.private) console.log(p.name, p.version)"
done | while read -r name local; do
  printf '%-34s local %-8s npm %s\n' "$name" "$local" "$(npm view "$name" version 2>/dev/null || echo MISSING)"
done
```

`MISSING` is the emergency: a template dependency that does not resolve breaks every
`npx create-evestack` (see "Order matters"). A local version *ahead* of npm is a pending publish —
check it is deliberate, and that CHANGELOG.md's `Unreleased` section describes it. A local version
*behind* npm should be impossible and means someone published from a stale tree.

A local version that **equals** npm while the code has changed is the dangerous one, because every
check above goes green: npm and the repository agree on the number and disagree on the contents.
That is the exact failure af49a2a was written to correct, and the only defence is bumping in the
same commit as the change.

## Verify from a stranger's position

Publishing is not the last step. In a directory that is **not** this checkout:

```bash
npx create-evestack@latest smoke-test --yes
cd smoke-test && ls node_modules/eve && ls node_modules/@evestack/composio
```

The CI `scaffolder` job runs the equivalent against the workspace build on every PR, including
the `npx`-shaped install path. It cannot check publish order — nothing can except this file.

## Tag convention

**`<package name>@<version>`.** `create-evestack@0.9.0`, `@evestack/mcp@0.2.1`,
`@evestack/dashboard@0.3.0`. Annotated, never lightweight.

Chosen over the other form this repository has used because **the tag string is also the install
spec**: `npm i create-evestack@0.9.0` and `git show create-evestack@0.9.0` take the same argument,
so a tag names exactly one artifact and no lookup table is needed to translate between them. The
`dashboard-v*` form would force one: five of the seven published packages are scoped, so
`@evestack/mcp` would have to be tagged `mcp-v0.2.1` — inventing a second name for something npm
already names, and inventing it once per package, in a repository whose commit log is largely
about two sources of truth disagreeing.

Verified, because a scoped name puts a `/` and a leading `@` into a ref:
`git check-ref-format refs/tags/@evestack/dashboard@0.3.0` passes, and such a tag round-trips
through `git tag -l '@evestack/dashboard@*'`, `git rev-parse` and `git describe`. Quote it in the
shell.

### The eleven tags that exist

All eleven are annotated and pushed. Two use the superseded `dashboard-v*` form and predate this
decision; they are public, so they are **not renamed** — a tag that has been pushed is an
address someone may already have written down.

Regenerate this table rather than trusting it:
`git tag --sort=creatordate --format='%(refname:short) %(*objectname:short)'`.

| tag | commit | status |
| --- | --- | --- |
| `create-evestack@0.4.0` | f409414 | the convention |
| `create-evestack@0.5.0` | 1163186 | the convention |
| `dashboard-v0.1.0` | d4aee43 | superseded form — keep, do not imitate |
| `dashboard-v0.2.0` | 751ac5c | superseded form — keep, do not imitate |
| `@evestack/dashboard@0.3.0` | 94dd019 | the convention, and the first **scoped** tag — the one that actually exercises the `/` and leading `@` verified above |
| `evestack@0.4.0` | 3d318ce | the convention |
| `@evestack/budget@0.2.1` | 3d318ce | the convention |
| `@evestack/mcp@0.3.0` | 3d318ce | the convention |
| `@evestack/sandbox-opensandbox@0.4.0` | 3d318ce | the convention |
| `create-evestack@0.9.1` | 94dd019 | the convention |
| `@evestack/dashboard@0.3.1` | 464a85f | the convention |

Four of them naming the same commit is not a mistake: 3d318ce bumped `@evestack/budget`,
`@evestack/mcp` and `@evestack/sandbox-opensandbox` in one commit, and `evestack` was already
at `0.4.0` there. All four went to npm inside twenty-seven seconds of each other, about a
minute after that commit (10:54:40 to 10:55:07, against a commit at 10:53:33).

`.github/workflows/publish-dashboard.yml` triggers on **both** patterns and accepts either as a
match for `packages/dashboard/package.json`, so `dashboard-v0.2.0` can still be re-run from the
Actions tab. The old half exists for those two tags and nothing else; it warns when it matches, and
it should be deleted from the trigger and the `case` when neither is worth re-running.

The dashboard is not on npm. Its tag names the workspace package — `@evestack/dashboard`, which is
what the version gate reads out of `package.json` — and the artifact it produces is
`ghcr.io/sammytourani/evestack-dashboard:<version>`.

Thirty-seven versions have been published — 33 on npm, 4 images on GHCR — and eleven tags exist,
so twenty-six releases have none. Five of the eleven were cut after the fact, on the evening of
2026-08-09, and only because the evidence left no room to guess: each points at a commit whose
own `package.json` carries exactly that version, minutes before the registry's timestamp for it.
Do not backfill the remaining twenty-six on anything weaker. A tag invented today would point at
whatever commit looks right now, and a tag that might be wrong is worse than a gap CHANGELOG.md
already documents honestly.

Recount rather than trusting those numbers — they go stale on every publish:

```bash
git tag | wc -l                          # tags

total=0                                  # npm versions, all seven packages
for p in create-evestack evestack @evestack/mcp @evestack/budget @evestack/composio \
         @evestack/schedules @evestack/sandbox-opensandbox; do
  total=$((total + $(npm view "$p" versions --json | grep -c '"')))
done; echo "$total"

# and the image tags, which are not on npm. Anonymous pull, no login:
tok=$(curl -s 'https://ghcr.io/token?scope=repository:sammytourani/evestack-dashboard:pull&service=ghcr.io' \
      | sed 's/.*"token":"\([^"]*\)".*/\1/')
curl -s -H "Authorization: Bearer $tok" \
     'https://ghcr.io/v2/sammytourani/evestack-dashboard/tags/list'
```

### Cutting a tag

```bash
# after the publish, from the commit that was published
git tag -a 'create-evestack@0.9.0' -m 'create-evestack 0.9.0'
git push origin 'create-evestack@0.9.0'
```

The dashboard is the one case where the tag comes **first**, because pushing it is what runs the
publish:

```bash
git tag -a '@evestack/dashboard@0.3.0' -m 'dashboard 0.3.0'
git push origin '@evestack/dashboard@0.3.0'
```

## Release notes

Run `gh release list` first. It prints seven rows today, all published, none a draft.

One of the seven is the lesson. `create-evestack@0.5.0` was created as a draft on 2026-08-05, at
the same minute as its tag, and stayed one until it was published on 2026-08-09 — four days
invisible to everyone but the maintainer, which is the worst of the three states, because a draft
looks finished from the inside and does not exist from the outside. Publish it or delete it; do
not leave it. `gh release list` labels drafts, so this is one column to read, not an audit.

Seven releases against **eleven** tags and **thirty-seven** published versions is still a gap,
and it is the same gap: `--verify-tag` means a release can only be cut where a tag already is.
**Four** tags have no release: `create-evestack@0.4.0`, `dashboard-v0.1.0`, `dashboard-v0.2.0`
and `@evestack/dashboard@0.3.1`.

> **Corrected 2026-08-11.** This paragraph said "ten tags and thirty-five published versions"
> and named three tags. Those are the numbers the counts fifty lines above replaced — `:210`
> reads *"Thirty-seven versions have been published — 33 on npm, 4 images on GHCR — and eleven
> tags exist"*, and `git tag | wc -l` is **11**, listed in full at `:173`. One paragraph was
> updated and this one was not.
>
> **The stale count took a sentence with it, which is the part worth noticing.** "The three tags
> with no release" was not a separate error: it is *derived* from the wrong total. Ten tags minus
> seven releases is three; eleven minus seven is four. Correcting a count without re-deriving the
> sentences that read from it leaves prose that is internally consistent with a number nobody
> holds any more — harder to catch than a bare wrong figure, because it audits clean against
> itself.
>
> The fourth tag is `@evestack/dashboard@0.3.1` (on `464a85f`), the newest of the eleven and the
> one added after this paragraph was written. **Confirm with `gh release list` before acting on
> it** — the arithmetic proves a fourth tag exists without a release, but which tag is inference
> from the tag dates, not a reading of the release list, and this file's own instruction two
> paragraphs down is to recount rather than trust.

`CHANGELOG.md` is the source. Every version heading there is exactly the tag name for that release,
which is what lets the notes be lifted rather than rewritten — the release page and the changelog
cannot drift into two accounts of the same version if only one of them is authored.

**Per release, in order:**

1. **Before bumping**, move the package's block out of `## Unreleased` and down into that
   package's own `##` section, at the top. The heading is already
   `### <package>@<version> — unreleased`; replace the word with the date. Dates are
   `America/Los_Angeles`, the timezone every commit here is stamped in.
2. **Re-read the log before you believe the block is complete.**
   `git log <last publish commit>..HEAD -- packages/<dir>` — `Unreleased` is written by hand and by
   definition lags whatever landed most recently.
3. Bump, publish, tag (above).
4. Cut the release. For the dashboard this is automatic — see below. For the seven npm packages it
   is this, and it is deliberately the same extraction the workflow performs:

   ```bash
   TAG='create-evestack@0.9.0'
   awk -v h="### $TAG" '
     index($0, h " ") == 1 || $0 == h { found = 1; next }
     found && /^###? / { exit }        # a "#### Fixed" subheading is four hashes and is kept
     found { print }
   ' CHANGELOG.md > /tmp/notes.md

   # not `test -s`: the section starts with a blank line, so an empty extraction
   # is one byte long and would pass.
   grep -q '[^[:space:]]' /tmp/notes.md || { echo "no changelog section for $TAG"; exit 1; }
   gh release create "$TAG" --verify-tag --title "$TAG" --notes-file /tmp/notes.md
   ```

   `--verify-tag` matters: without it `gh` creates the tag for you, which turns a typo into a
   permanent public ref.

**The dashboard release is automatic.** `publish-dashboard.yml` gained a `release` job that runs
after the image is built, merged into one multi-arch tag and proven anonymously pullable. It pulls
the `### @evestack/dashboard@<version>` section out of `CHANGELOG.md`, appends the `docker pull`
line, and creates the release at the pushed tag. It is keyed on the version rather than on the tag
string, so both accepted tag forms resolve to the same section. Three things it will not do: run
without a tag (`if: github.ref_type == 'tag'`), create a tag (`--verify-tag`), or publish an empty
release — a missing changelog section fails the job, because an empty release page looks like an
answer.

## Bumping versions

`templates/default/package.json` is the source of truth for the versions the registry items pin
to. After changing any dependency there, re-run `node registry/build.mjs` and commit
`registry/r/`; CI fails if an item's pin drifts from the template.
