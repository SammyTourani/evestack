# contract/

Fast, deterministic, free assertions that pin every assumption evestack makes
about eve.

```bash
pnpm contract                       # or: node contract/run.mjs
node contract/run.mjs --verbose     # show passing assertions too
node contract/run.mjs --only=auth   # run contracts whose id matches
node contract/run.mjs --format=json # machine-readable
node contract/run.mjs --format=markdown
```

Runs in well under a second, makes no model calls, needs no database, no Docker
and no network. It reads the installed eve package and nothing else.

## Why this exists

evestack once shipped a `strictLocalDev()` wrapper because eve 0.29.x decided
"is this request from my own machine" from the request's own Host header — so
`127.evil.com`, a name anyone can register, was handed a full local-dev
principal with no credentials.

eve 0.30.0 fixed it upstream. From that moment our wrapper could add no
protection and would reject legitimate local-dev access over a LAN IP or a
tunnel. It had gone from load-bearing to actively harmful.

**It typechecked perfectly the entire time.** `tsc` had nothing to say on the
day it was necessary or the day it became harmful, because nothing about its
*types* changed — only what eve *meant*.

What would have caught it is a behavioural assertion: *a request claiming to
come from `127.evil.com` must not receive an unauthenticated principal.* That
assertion is now `contract/contracts/07-auth.contract.mjs`, and you can watch it
work:

```bash
# green against the version we ship
node contract/run.mjs --only=auth

# red against the version that had the bug
EVESTACK_CONTRACT_EVE_DIR=node_modules/.pnpm/eve@0.29.5.../node_modules/eve \
  node contract/run.mjs --only=auth
```

## What a contract is

Each file in `contracts/` default-exports one contract, or an array of them:

```js
export default {
  id: "auth/local-dev-must-not-trust-the-request",
  title: "localDev() grants on process state, never on anything the caller controls",
  assumption: "…what we believe about eve…",
  evestackUse: "…what evestack does with that belief, and what breaks without it…",
  async check(eve, t) {
    t.equal(actual, expected, "one assertion, phrased as the thing that should be true");
  },
};
```

`evestackUse` is not decoration. The runner prints it on every failure, so a
maintainer who has never seen the contract before learns the blast radius from
the failure itself rather than from `git blame`.

## Prefer behaviour over shape

In rough order of preference:

1. **Execute eve and check the result** — call `localDev()` with a hostile
   request; call `always()` and compare the string it returns. This is the only
   kind that catches meaning changing under a stable type.
2. **Import eve's own constants and predicates** — `isDynamicSentinel`,
   `ALLOWED_DYNAMIC_TOOL_EVENTS`, the route patterns. Reading eve's value beats
   re-declaring our own copy of it.
3. **Read a compiled `.d.ts`** — last resort, for surfaces that cannot be
   reached without a Docker daemon or a live server.

## Derive from source where you can

`lib/repo.mjs` scans evestack's own source for `eve/*` imports and `$eve.*`
attributes, so adding `import { x } from "eve/y"` anywhere makes that a pinned
contract immediately, with no list here to remember to update. It scans
`registry/r/*.json` too — those items inline agent source as JSON strings and
are never typechecked by anything, so this suite is the only check they get.

## The floor: the suite is not allowed to shrink

`floor.json` records a per-contract minimum assertion count, checked on every
run. Dropping below one exits **3** — a code of its own, because it means
something categorically different from a contract failing: the suite did not get
smaller because eve moved, it got smaller because evestack did.

That is not hypothetical, and it follows directly from the section above. Three
contracts generate their assertions from evestack's own source, so deleting an
import or a queried column simply stops generating the matching assertion. The
contract still passes. Every artifact downstream then reports the new number as
though it were the old one:

> All 15 contracts hold against eve 0.31.0 — 219 assertions, all green

Every word of that is true, and it is the most misleading thing this project
could publish. `record.mjs` refuses to certify below the floor and
A hollowed-out suite therefore fails the run rather than reporting a smaller
number as though nothing had changed.

Per-contract rather than one total, because a total hides erosion behind growth:
twelve assertions lost from telemetry and twelve gained elsewhere nets to zero.

```bash
node contract/run.mjs --write-floor   # after deliberately adding or removing
```

Raising it is automatic. Lowering it is a decision that shows up in a diff.

## The runtime tier

`contract/runtime/` is the other half, and it exists because everything above is
structurally blind to the bugs this project actually ships. A static assertion
cannot see a denied approval killing a session, an index that answers nothing, or
`attach` corrupting the file it just rewrote and printing "Done." Those share a
shape — **the system reports success and is wrong** — and the only way to catch
it is to run the thing.

```bash
node contract/runtime/run.mjs                    # skips what it cannot reach
node contract/runtime/run.mjs --require=postgres # ...or fails instead of skipping
node contract/runtime/run.mjs --list
```

Deterministic only. No model calls: a check that is right three times in four
gets muted, and a muted check is worse than an absent one. Model-dependent
verification is `eve eval`, gated on a key and run nightly by
`.github/workflows/evals.yml` — behind a negative control that removes the
deny-path fix and requires the eval to go red against it, because a gate that
cannot fail is decoration.

A probe that cannot run **skips** locally and **fails** under `--require`. CI
always passes `--require`, so a runtime job cannot report green having quietly
checked nothing.

## Adding one

Write it when you discover an assumption, not when you have time. The test that
would have caught the bug you just fixed is worth more than three you wrote
speculatively. If a red contract turns out to be a legitimate upstream change,
update the contract in the same commit as the code — a contract that no longer
describes eve is worse than none.

Both probes in `contract/runtime/` were wrong before they were right, and both
were caught by their own guards rather than by review — one built a simplified
schema and manufactured two failures that were artifacts of its own fixture, the
other drove a module that only exports a function and would have passed forever
having done nothing. If a probe has no assertion that it *did something*, it does
not have enough assertions.

See `docs/upgrading.mdx` for the standing policy and what to do when the suite
goes red.
