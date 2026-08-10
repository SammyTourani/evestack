# Upstream issue drafts

Bugs that were traced to eve rather than to evestack, written up and ready to file, but **not
filed**. Each `*.md` file here is an issue *body* and nothing else — no title line, no front
matter — so it can be handed to `gh` verbatim.

Filing one is a deliberate human action. Nothing in CI posts these.

## eve-dev-watcher-source-root.md

`eve dev` resolves its source root by walking up until it finds `.git` or `pnpm-workspace.yaml`.
A scaffolded project with neither inherits whichever ancestor has one, which for anyone keeping
dotfiles in git is `$HOME` — and `.npmrc` is on the list of files that root gets both watched and
**copied** from. Searched against `vercel/eve` before drafting: related to #1720, #570 and #609,
duplicate of none of them.

evestack already neutralises this from its own side. `create-evestack` runs `git init` in the
scaffold (`packages/create-evestack/create.mjs`), which stops both walks at the project root. The
upstream bug is still real for anyone who scaffolds another way, which is why the draft exists.

To file it:

```bash
gh issue create --repo vercel/eve \
  --title 'eve dev treats $HOME as the project source root when the app has no .git, watching and copying ~/.npmrc' \
  --body-file .github/upstream/eve-dev-watcher-source-root.md
```

Check the environment block before posting — it names eve `0.30.8` and the `0.31.3` source, and
both will age.
