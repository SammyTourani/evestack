# decisions.md — the four open calls, decided

Each was investigated before deciding. Evidence first, decision second.

---

## D1 — The schema version counter must refuse to downgrade

**Evidence.** `packages/dashboard/sql/traces.sql:445-448` moves the marker forward only
(`ON CONFLICT … WHERE version < EXCLUDED.version`) — correct. But the migration's DO block reads
`target constant integer := 3` and gates *data* changes on `installed`, while
`CREATE OR REPLACE FUNCTION resolve_span_ancestry` runs **unconditionally** every boot. So an
older image cannot move the marker down but happily replaces the function. Observed live: the
database reads `spans v4` while running the v3 resolver, and 14 fresh spans went back to
`turn_0`. Because the marker still says v4, the migration will never re-run. The guard silently
lies.

**Decision: make the version gate cover the DDL, not just the data.** At the top of each
migration, if `installed > target`, raise a clear `NOTICE`/`WARNING` naming both versions and
skip **everything** — function definitions included. An older image should leave a newer
database strictly alone and say so loudly, rather than half-downgrade it in silence.

Rejected: re-applying functions unconditionally on every boot. It makes "last image to boot
wins", which is the same race with better odds, not a fix.

Also do: surface the mismatch. If the dashboard finds `installed > its own target`, it should
refuse to serve trace pages with a real message rather than render empty ones — this whole class
of bug presents to the user as "my data vanished".

---

## D2 — RETRACTED. The premise was false; the fixes it produced are good anyway.

> **Read this before the section below.** D2 called the eval tier a release blocker. **It was
> not broken.** The shipped suite runs green on a clean scaffold — 4 evals, 13 gates, ~40s on
> Ollama. The failure that triggered this decision came from running evals with `--url` against
> the agent I had deliberately `kill -9`'d during Part 8A, which had a stranded workflow;
> `Channel handler failed.` is a generic mask, the 30.03s was eve's
> `COMMAND_HOOK_READY_TIMEOUT_MS`, and restarting the agent made the identical eval pass in 6s.
> The auth hypothesis below is **disproven**, not unconfirmed. Full account in `findings.md`.
>
> The lane's actual output stands on its own and is merged: `eve eval` refusing to run while the
> agent is up, and having no preflight, are both real defects, now fixed behind `npm run eval`.
> Only the framing was wrong. Claim 14 is **TRUE**.

*Original text, kept for the record:*

## D2 (original) — `eve eval` is broken on scaffolded projects; fix the harness, not the generator

**Evidence.** The promoted eval failed after 30s with `Channel handler failed`, **and so does the
shipped `templates/default/evals/smoke.eval.ts`** against the same agent. So the generator is
fine and the eval tier is broken end to end on a scaffolded project — while `CONTRIBUTING.md:41-57`
documents it passing on Ollama. `evals/evals.config.ts` sets only `timeoutMs` and no reporter;
it carries no URL and no credentials. The scaffold puts every route behind HTTP Basic
(`EVESTACK_AUTH_USER` / `EVESTACK_AUTH_PASSWORD`), and the agent fails closed by design.

**Decision: treat this as a release blocker and fix the harness so the shipped evals pass on a
freshly scaffolded project on the $0 path.** Root-cause it first — the credentials hypothesis is
strong but unconfirmed, and `Channel handler failed` may be the channel layer rather than auth.
Whatever the cause, the acceptance bar is: `npx eve eval` green on a clean scaffold with Ollama,
with no hand-editing.

This is the tier the project's own notes say CI never runs. It is free on Ollama, so once it
passes it should run in CI on every commit. A documented example that does not execute is worse
than no example.

---

## D3 — The eve floor is **0.30.0**, not 0.30.2

**Evidence, and it is decisive.** The vulnerability was fixed upstream in **0.30.0** — stated in
`SECURITY.md:181`, `README.md:178`, and the constant's own doc comment. `SECURITY.md:183`
concludes "**Pin `eve` `>=0.30.0`**", and all four published peer ranges say `>=0.30.0`.

So where does 0.30.2 come from? `CHANGELOG.md:297`: *"eve 0.30.2, and the auth patch it made
obsolete is gone."* evestack shipped its own `strictLocalDev()` wrapper, upstream fixed the bug
in 0.30.0, and evestack deleted its now-harmful wrapper when it moved to 0.30.2. **0.30.2 is the
date evestack removed its own patch, not the date the bug was fixed.** It was never a security
boundary.

**Decision: `MIN_EVE = "0.30.0"`.** Align `README.md:178` with `SECURITY.md`, and fix the
self-contradicting doc comment at `attach.mjs:58-62`.

The "but 0.30.2 is the lowest we tested" concern is already solved by a constant that exists:
`CERTIFIED_EVE`, whose message is *"Older is untested, not unsupported."* That is exactly the
right register for 0.30.0–0.30.7. The security floor and the certified version are two different
ideas and the code already models both — they were just conflated.

This retires the false warning telling users on 0.30.0/0.30.1 that `127.evil.com` can obtain an
unauthenticated principal on their install. Crying wolf about authentication is corrosive in a
project whose entire pitch is self-hosting.

---

## D4a — Failure rate: unfinished turns leave the numerator **and** the denominator

**Evidence.** `packages/dashboard/lib/metrics.ts:188`:
`CASE WHEN outcome IN ('failed','no_model_call') THEN 1 ELSE 0 END`, averaged. A `running` or
`wedged` turn matches neither arm, scores **0 — a success** — and stays in the denominator. A
crashed agent therefore *improves* the reported failure rate. Compounding it: `turn.completed`
fires while an approval is still parked, so `completed` does not mean finished either.

**Decision: failure rate is `failed / finished`, and unfinished turns are reported separately,
never silently as successes.** Excluding them from both sides is the standard definition and the
only one that cannot move in the wrong direction during an incident. Alongside it, surface an
explicit unfinished/stalled count — the fleet work already establishes the principle that "not
judged" must be visible rather than folded into good news.

Do it in `TURN_FAILED_SQL` and let all three consumers (`/monitors`, `/api/metrics`, the alert
engine) inherit it — the comment above that constant says the whole point is that those three
cannot disagree, and that property is worth preserving. Changing the shared definition is
correct precisely *because* it is shared.

---

## D4b — `attach` should create a `.git`, and say so in its undo list

**Evidence.** `attach.mjs` creates no `.git`, so **an attached project leaks `~/.npmrc` exactly
as a scaffolded one did** — verified: eve walks up for a `.git`/`pnpm-workspace.yaml` marker,
finds the user's home directory, and copies `.npmrc` (credentials included) into
`.eve/dev-runtime/snapshots/*/source/`. I found ten such copies on this machine and deleted them.

The objection is that attach's contract is "additive, never overwrites, prints an undo line for
everything it writes".

**Decision: create it, and honour the contract rather than bending it.** `git init` in a
directory with no repository is *purely additive*, it overwrites nothing, and it is trivially
undoable — which is precisely the contract, not an exception to it. So:

- only when there is no `.git` **at or above** the target (first-marker-wins is the whole bug;
  skipping when a parent has one is the exact case that keeps it)
- if a parent marker exists outside the project, do not init silently — **warn**, because that
  parent is what will be copied from
- list `.git/` in the printed undo output like every other created path
- no initial commit, for the reason the scaffolder work already established: `git commit` needs
  `user.name`/`user.email` and would honour `commit.gpgsign`, and a signing prompt turns a
  scaffolder into a hang

A credential leak is not a thing to leave in place out of deference to a style rule that, read
properly, permits the fix.
