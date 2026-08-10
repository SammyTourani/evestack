### Environment

- eve `0.30.8`; the constants below are byte-identical in the published `0.31.3` source, so this is not fixed on latest
- macOS 26.5.2 arm64, Node 26.0.0
- Project scaffolded by a third-party template into `~/some/dir/my-agent`, with **no `.git` in the project**
- `~/.git` exists (a dotfiles repo, a common setup), and `~/.npmrc` is a symlink

### What happens

An unrelated tool rewrote four dotfiles in my home directory, and `eve dev` rebuilt the project:

```
[eve:dev] change detected (5 events: unlink /Users/me/Users/me/.npmrc, add /Users/me/.gemrc,
add /Users/me/.npmrc, add /Users/me/.yarnrc, add /Users/me/.yarnrc.yml), rebuilding authored artifacts...
```

Note the doubled `/Users/me/Users/me/`.

### Root cause, three things stacked

**1. `resolveDevelopmentSourceRoot` walks up past the project.**

`src/internal/nitro/dev-runtime-source-snapshot.ts` searches ancestors for
`SOURCE_ROOT_MARKER_NAMES = ['.git', 'pnpm-workspace.yaml']`. A project with no `.git` and no
workspace manifest keeps walking. On a machine with a dotfiles repo in `$HOME`, the source root
becomes the home directory. `addWorkspaceMetadataFiles` then adds every existing
`WORKSPACE_METADATA_FILE_NAMES` entry under that root — including **`.npmrc`** — to both the
watch set and `copyFiles`.

**This copies the user's `~/.npmrc` into `.eve/dev-runtime/snapshots/<id>/source/.npmrc`.** On my
machine that file contains a registry `_auth` token. Verified byte-identical by `shasum`, in three
separate snapshots. `runtimeAppRoot` in `current.json` also becomes a home-mirroring path with the
real project nested inside it.

**2. `resolveLockfileSearchDirectories` does the same walk, then watches paths that do not exist.**

`src/internal/nitro/host/dev-authored-source-watcher.ts` adds `join(dir, name)` for all five
`WATCHED_LOCKFILE_NAMES` for **every** ancestor up to the marker — 20 paths for a project four
levels below `$HOME`, 15 of them outside the project, none of them existing. Chokidar responds to
a non-existent watch target by watching its parent, so `eve dev` effectively watches `$HOME` and
rebuilds on any file event there.

**3. The doubled path is a chokidar bug that (2) makes reachable.**

`chokidar@5.0.0`, `handler.js`, the `_addToNodeFs` symlink branch:

```js
const parent = sp.dirname(wh.watchPath);
this.fsw._getWatchedDir(parent).add(wh.watchPath);   // absolute path where a basename is expected
```

Every other writer of that item set uses a basename. `_handleRead`'s readdir builds a basename
set, the absolute-named item never matches, and `_remove(parent, item)` does
`join(parent, absolutePath)`, producing the doubled path, emitted as `unlink`. It only triggers
when a **symlink** is a top-level watch target with `followSymlinks: false`, which is exactly what
(1) arranges for `~/.npmrc`.

### Minimal reproduction

```bash
mkdir -p /tmp/eve-repro/home/.git /tmp/eve-repro/home/work/app
cd /tmp/eve-repro/home/work/app && npx eve init . && ln -s /etc/hostname /tmp/eve-repro/home/.npmrc
HOME=/tmp/eve-repro/home npx eve dev &
# then: rm /tmp/eve-repro/home/.npmrc && ln -s /etc/hostname /tmp/eve-repro/home/.npmrc
```

A watcher-level reproduction that needs no agent boot is also possible: drive eve's own vendored
chokidar (`dist/src/compiled/chokidar`) with eve's own options
(`awaitWriteFinish {pollInterval: 50, stabilityThreshold: 160}`, `followSymlinks: false`,
`ignoreInitial: true`) and reimplement `resolveLockfileSearchDirectories`. That reproduces the
exact five-event line, including the doubling, with only `.npmrc` doubled.

### Expected

- The source root never escapes the app root when the app root is itself a valid project.
- Watch targets are confined to the resolved source root's subtree.
- `.npmrc` is never copied into a build artifact directory from outside the project.
- A watched symlink's parent-directory bookkeeping uses a basename (a chokidar fix, or a vendor patch).

### Suggested fixes, cheapest first

1. Stop the ancestor walk at the app root when the app root has its own `package.json` and is not
   itself a workspace member — the common case for a scaffolded standalone agent.
2. Drop `.npmrc` from `WORKSPACE_METADATA_FILE_NAMES`, or at minimum stop *copying* it. Watching it
   for cache invalidation is defensible; copying a credentials file is not.
3. Filter `resolveLockfileSearchDirectories` output to `existsSync` paths, or watch the lockfile's
   **directory** with a name filter rather than a non-existent file path.
4. Upstream chokidar: `_getWatchedDir(parent).add(sp.basename(wh.watchPath))`.

### Workaround

Running `git init` in the scaffolded project stops both walks dead, because both resolvers use the
same marker list and stop at the first marker they find. Measured: the source root returns to the
app root, lockfile watch paths drop from 20 to 5, and nothing outside the project is watched or
copied.

Related: #1720 (same class, narrower), #570 and #609 (watcher lifecycle rather than watcher scope).
