# Releasing

Three packages go to npm. Two of them are private forever.

| Package | Directory | Published |
| --- | --- | --- |
| `create-evestack` | `packages/create-evestack` | yes — the flagship |
| `@evestack/composio` | `packages/evestack-composio` | yes |
| `@evestack/sandbox-opensandbox` | `packages/sandbox-opensandbox` | yes |
| `@evestack/dashboard` | `packages/dashboard` | no — `private: true`, runs from the repo |
| `@evestack/website` | `packages/website` | no — `private: true` |
| `@evestack/template-default` | `templates/default` | no — ships *inside* `create-evestack` |

## Order matters

`create-evestack` scaffolds a project that depends on `@evestack/composio` at the version in
`templates/default/package.json`. `packages/create-evestack/scripts/sync-template.mjs` rewrites
that `workspace:*` range to `^<version>` at pack time, so **the scoped packages must exist on
npm before `create-evestack` does**. Publish `create-evestack` first and every `npx
create-evestack` between the two publishes dies on

```
npm error 404 Not Found - GET https://registry.npmjs.org/@evestack%2fcomposio
```

Since `create-evestack@0.1.0` cannot be unpublished after 72 hours, that is an unrecoverable
first impression. So:

```bash
pnpm install --frozen-lockfile
pnpm -r typecheck                       # must be clean
node registry/build.mjs                 # regenerate registry/r from templates/default

# 1. scoped packages first. `prepack` builds dist/; `publishConfig.access: public`
#    is required because npm defaults a scoped package to restricted.
npm publish ./packages/evestack-composio
npm publish ./packages/sandbox-opensandbox

# 2. verify they resolve before continuing
npm view @evestack/composio version
npm view @evestack/sandbox-opensandbox version

# 3. only then the scaffolder. `prepack` copies templates/default into template/
#    and pins the workspace ranges to the versions just published.
npm publish ./packages/create-evestack
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
