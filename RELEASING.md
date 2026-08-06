# Releasing

Seven packages go to npm. Three are private forever.

Keep this table honest. It said "three packages" while six were already
published, and the three it omitted included two that the scaffolded template
depends on — which is precisely the unrecoverable ordering mistake the next
section exists to prevent. It had been working by luck.

| Package | Directory | Published |
| --- | --- | --- |
| `evestack` | `packages/evestack-cli` | yes — the CLI (`create`, `attach`, `doctor`) |
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
npm publish ./packages/evestack-cli

# Independent of the chain — no other published package names them, so these can
# go at any point.
npm publish ./packages/evestack-mcp
npm publish ./packages/sandbox-opensandbox
```

### Two names are not live yet

As of 2026-08-05, `README.md` opens with `npx evestack create my-agent` and npm serves
`evestack@0.0.1` — a 196-byte placeholder with **no `bin` field**, so that command downloads
something and then fails to find an executable. `create-evestack` is at `0.5.0` on npm while this
repo is at `0.6.0`.

The first command in the README does not work until step 4 above runs. Check before assuming
otherwise:

```bash
npm view evestack version && npm view evestack bin
npm view create-evestack version
```

## Verify from a stranger's position

Publishing is not the last step. In a directory that is **not** this checkout:

```bash
npx create-evestack@latest smoke-test --yes
cd smoke-test && ls node_modules/eve && ls node_modules/@evestack/composio
```

The CI `scaffolder` job runs the equivalent against the workspace build on every PR, including
the `npx`-shaped install path. It cannot check publish order — nothing can except this file.

## Bumping versions

`templates/default/package.json` is the source of truth for the versions the registry items pin
to. After changing any dependency there, re-run `node registry/build.mjs` and commit
`registry/r/`; CI fails if an item's pin drifts from the template.
