# contract/history/

One committed JSON report per eve version the contract suite has been run
against. These files are the only input to the public compatibility page
(`docs-site/compat/index.html`), so the page cannot claim anything a real run
did not produce.

```bash
node contract/record.mjs                        # record the eve currently installed
node contract/record.mjs --npm=0.30.6           # download that release, record it
node contract/record.mjs --npm=0.30.5,0.29.5    # several at once
node contract/render-compat.mjs                 # rebuild the page from these files
```

Nothing here is written by hand. `record.mjs` runs `contract/run.mjs
--format=json` in a child process and stores the report verbatim under a few
lines of provenance.

## Schema

One file per version, named `eve-<version>.json`.

| field | meaning |
|---|---|
| `schemaVersion` | `1`. Bump it if any field below changes meaning. |
| `eveVersion` | The version the suite actually interrogated — read from the tested package's own `package.json`, not from what was requested. |
| `eveReleasedAt` | npm publish time for that version, or `null` if the registry was unreachable. |
| `eveLatestTagAtCertification` | What npm called `latest` when the suite ran. Equal to `eveVersion` ⟺ this row was certified while it was the newest release, which is the only case where the publish→certify gap means anything. |
| `certifiedAt` | When the suite ran. |
| `evestackCommit` | Short SHA of the evestack tree that ran it, or `null` outside a git checkout. |
| `evestackPin` | What `templates/default` pinned at the time. Explains the `version/…` contract's verdict. |
| `source` | How the tested package was obtained — `npm-tarball` (with `spec` and npm `integrity`), `directory`, or `installed`. |
| `ok` | `false` if *any* contract failed, including the version-pin one. |
| `counts` | `{ contracts, failedContracts, assertions, failedAssertions }`. |
| `contracts[]` | The runner's report, verbatim: `id`, `title`, `assumption`, `evestackUse`, `file`, `status`, `crash`, and every `assertions[]` entry with `detail`, `passed`, and `expected`/`actual` on failures. |

`eve.path` from the runner's JSON is the one field dropped: it is an absolute
path on whoever's machine ran the suite, so it would make every re-record a
diff and tells a reader nothing.

## Reading `ok: false`

`ok` is red for a version whenever anything failed, and one of the thirteen
contracts is bookkeeping rather than an eve fact:

- **`version/installed-satisfies-every-declared-range`** compares the eve under
  test against the ranges *this repo's manifests declare today*. Every release
  older than the current pin fails it by construction. It is not a statement
  about eve.
- **The other twelve** describe eve's own behaviour. Those are what "eve broke
  something" means, and they are what the compat page's headline verdict counts.

At the time of writing that distinction is the whole difference between
`eve-0.30.5.json` (`ok: false`, but all twelve API contracts hold — it is simply
not what we pin) and `eve-0.29.5.json` (`ok: false` because `localDev()` really
did grant an unauthenticated principal on a `Host` header anyone can spoof).

## Why tarballs, and why they borrow a dependency tree

`--npm` fetches with `npm pack` into a cache **outside** this repo and unpacks
there. It never writes `node_modules` and never touches the lockfile:
certifying eve 0.29.5 must not disturb the install everything else is built
against.

An npm tarball ships eve's compiled output and no dependencies, so a bare unpack
cannot resolve eve's own imports of `ai`, `nitro`, `undici` or
`@opentelemetry/api` — five contracts crash on `Cannot find package 'ai'` and
report a red that says nothing about eve. `record.mjs` therefore symlinks the
*installed* release's dependency tree beside the unpacked one. That both fixes
the false red and holds dependencies constant across every row, so the only
variable between versions is eve itself.

Consequence worth knowing: `pnpm install` must have run before `--npm` works.

## Re-recording

Recording the same version again overwrites its file. If the verdict changed,
`record.mjs` says so loudly — same eve, different result means *evestack*
changed (a contract was added, tightened, or the pin moved), and the compat page
is about to tell a different story about a release that never moved.

## Keeping the page honest

`docs-site/compat/index.html` is a pure function of these files: no timestamps,
no locale-dependent formatting, no network. Re-running
`node contract/render-compat.mjs` on an unchanged history produces byte-identical
output, which is what lets CI diff the committed page against a fresh render and
fail if anyone edits the HTML by hand.
