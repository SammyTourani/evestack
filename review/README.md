# Dashboard v2 — review packet

You are reviewing one agent session's work on the evestack dashboard. The brief was
"turn this into a million-dollar dashboard", with UI quality named as the thing that
mattered most.

This document is written to be argued with. Where I think the work is weak, it says so,
because a review that only checks the parts I am proud of is not a review.

---

## Scope: which commits are actually mine

The branch is 48 commits ahead of `main`, but **only the last 21 are from this session**.

| | |
| --- | --- |
| Pre-existing on the branch | 27 commits, everything before `d1fab73` (before 03:36) |
| **This session** | **`d1fab73`..`HEAD` — 21 commits, 118 files, +23,472 / −1,228** |

`COMMITS.txt` lists mine in order. Reviewing the earlier 27 would be judging someone
else's work as though it were mine.

```
git log --oneline d1fab73~1..HEAD          # just this session
git diff --stat d1fab73~1..HEAD
```

---

## The one-paragraph version

The dashboard could not aggregate its own telemetry: model-call and tool-call spans were
attributed to a session at **0%**, so every SQL rollup over spans returned nothing while
the trace viewer looked healthy. The session fixed that (0 → 1,197/1,197), built fact
tables and a query API on top, added a design system, and then built or rebuilt five
pages against it — an overview, a searchable session list, a session detail page, costs,
and sandboxes — plus nine default monitors. It ran end-to-end against a real eve agent
in a production build at the end.

**It is not a finished visual redesign.** See "Where this falls short".

---

## What to read, in order

1. **`RESEARCH.md` §11, §12, §13** — the verification passes. This is the most useful
   thing in the packet, because it is where I document being wrong. §11 overturns three
   load-bearing claims from my own earlier research, including the fix the entire plan
   was sequenced around.
2. **`PLAN.md`** — the plan, with `SHIPPED` banners recording what each workstream
   actually delivered versus what it promised, and what was deliberately dropped.
3. **`COMMITS.txt`** then the commit messages themselves. They are long on purpose: each
   states what was wrong, what the evidence was, and what was decided against.
4. The code. Start with `packages/dashboard/sql/facts.sql` and
   `packages/dashboard/lib/metrics.ts` — they carry the most consequential decisions.

---

## The central claim, and how to falsify it

**Claim:** every defect that mattered in this project was *a number that looked right*.
Nothing errored.

Specific instances, each verifiable from the commits:

| Defect | Why it was invisible |
| --- | --- |
| The plan's own headline fix | Would have reported 97% attribution while attributing ~30,000 spans to `wrun_0000…0`, a run that has never existed |
| Cache-write pricing (W1) | Shipped and moved **zero dollars** — no caller passed the new argument |
| `failureRate` | Could return **200%**; its own test encoded the assumption that made it possible |
| `count(cost)` | Rendered five rows as **$5.00** |
| Coverage note | A partial-data warning that said **"100%"** |
| Evals `failed` grade | **Structurally unreachable** — graded on a status eve never sets |
| `/sessions` | Took **15.2 seconds** because a *healthy* agent that had never heard of a session opens a stream designed not to end |
| Overview with DB down | Rendered six em dashes — *"your agent did nothing"* — the opposite of the truth |

**Three of those are mine**, introduced during this session: the seeder's wrong attribute
key, its token-accounting bug, and the last row in that table, which I wrote in W6 while
composing a module header about honest denominators.

To falsify the claim: find a defect in this diff that *would* have thrown, been caught by
`tsc`, or been caught by a test written before it.

---

## Where this falls short

**The visual redesign is roughly 40% done, and this is the biggest gap against the
brief.** Measured by design-system adoption per page:

| Restyled (5) | Untouched (8) |
| --- | --- |
| `/` overview, `/costs`, `/sandboxes` (new) | `/monitors`, `/traces`, `/integrations`, `/evals` |
| `/sessions`, `/sessions/[id]` (rebuilt) | `/skills`, `/memory`, `/schedules`, `/approvals`, `/chat` |

The cause is a deliberate decision I then failed to follow through on. W3 adopted
Tailwind by taking its `theme` and `utilities` layers and **not** its `base` layer
(preflight), specifically so no existing page would change appearance in the commit that
introduced Tailwind. That was right at the time — but the wave that was supposed to
import preflight and restyle the remaining pages was never scheduled. 293 of the 461
lines in `app/globals.css` are still the original hand-rolled CSS, inside `@layer app`.

**Judge that decision.** It is defensible and it is also why the brief's headline ask is
unfinished.

**Deliberately not built**, each flagged rather than hidden:

- **Live/SSE on the overview.** eve's HTTP surface is per-session only (verified against
  `contract/contracts/05-http-protocol.contract.mjs`), so there is no fleet feed to
  subscribe to and the roster must be polled regardless.
- **Alert delivery.** The nine monitors compute and render state; webhook and channel
  notification is separable.
- **Reasoning tokens as a cost dimension.** Datadog treats it as first-class, but eve
  emits no reasoning counter, so the column would be a permanent zero.

**Untested paths:** the chat page's streaming, approvals resolving through eve's
follow-up route, and the fleet classifier's agent-dependent states. Trace ingest was
wired but spans were not flowing at the end of the live run, so `/traces` and TTFT are
unexercised against real data.

---

## Decisions I would push back on if I were you

1. **Vendoring Tremor instead of installing it.** Justified by `@tremor/react` peering
   React 18 and its v4 beta being abandoned five weeks before Vercel acquired them
   (`RESEARCH.md` §8.2). But it means carrying someone else's components with no upgrade
   path. Is that better than a different chart library?
2. **Writing to the `workflow` schema from the seeder.** The rule everywhere else is that
   schema is read-only. `scripts/seed.mjs` breaks it, fenced four ways and documented.
   Reasonable exception or the start of a crack?
3. **`evestack_`-prefixed indexes on `workflow.workflow_runs`.** Additive, idempotent,
   and they took the session list from 195.8ms to 0.9ms — but they are still ours, on
   their table.
4. **Keeping the `/charts` gallery** despite it emitting a Recharts chunk into a build
   where the route 404s. My argument: Recharts renders nothing under
   `renderToStaticMarkup`, so it is the only place "does a line actually appear" can be
   answered.
5. **Adversarial verification cost roughly as much as the building.** Two full
   verify-and-remediate rounds. It found 27 defects in W1 alone. Worth it, or a tax a
   more careful first pass would have avoided?

---

## Process, including what went wrong

Each wave ran as: build → adversarial verify → remediate → commit. Verifiers were
instructed to *disprove* the report, re-derive every number against the database, and
prove new tests could fail by reverting the hunk.

**Three process failures worth judging:**

1. **I parallelised W2 and W3 saying "they meet at the chart props" and never specified
   the contract at that seam.** Three separate collisions followed: two unit
   vocabularies (`ms/usd/ratio` vs `duration/cost/percent`), two formatter stacks, and
   two `Coverage` types. Each cost a cleanup commit. From Wave 3 on I *built* the shared
   contract before launching agents — see `83a015a`, which pins the outcome vocabulary
   to the SQL with a test before either agent ran.
2. **Roughly ninety minutes lost to background workflows that produced nothing** while I
   reported them as running. The user called it twice. Switching to
   verify-and-commit-as-it-lands is what made the second half move.
3. **I shipped the exact defect class I spent a whole commit removing from others.**
   `6b9477c` deletes an env-var reader I wrote in W7 for lifecycle actions that were
   never built.

---

## Reproducing the verification

```bash
pnpm install
cd packages/dashboard && pnpm test        # 391 tests
TZ=America/Los_Angeles pnpm test          # same 391 — the timestamp fix depends on it
pnpm typecheck
cd ../.. && node contract/run.mjs         # 17 contracts, 300 assertions
```

**Seeded data** (nothing else in the repo can produce a month of traffic):

```bash
cd packages/dashboard
node scripts/seed.mjs > /tmp/s.sql        # never pipe into `head` — SIGPIPE truncates it
psql "$WORKFLOW_POSTGRES_URL" < /tmp/s.sql
```

The seeder reproduces the *broken* state faithfully — model and tool spans carry no
session id, and 92.6% of the span table is engine noise (measured: 92.5%). Two tests
hold that shape down, so "fixing" the fixture fails them. That is deliberate: it is what
makes the attribution work falsifiable.

**Production build**, verified end to end against a live eve agent running `qwen3:4b`
through Ollama on native Postgres:

```bash
pnpm build && pnpm exec next start --port 4000
```

All twelve pages returned 200. `/charts` correctly 404s in production.

---

## Questions worth an outside answer

1. Was **correctness-first** the right call, given UI quality was the stated priority?
   Waves 0–2 produced almost nothing visible. The argument for it is in `PLAN.md`'s
   sequencing section; the cost is the 8 unstyled pages.
2. Is the **query API** (`lib/metrics.ts`) actually the right abstraction, or
   over-engineering? The test I set was whether a new chart becomes a config object —
   `app/overview.ts` is 250 lines of configuration with no SQL, which I read as passing.
3. Are the **comments too long**? They average far above normal density. I believe they
   earn it here because most encode a trap that already bit someone. You may disagree.
4. Is **`unknown` sorting above `ok`** in the alert list right, or alarmist?
5. Did the **fact tables** need to be materialized, or would views have done? The plan
   asserts views are too slow for percentiles; that was never benchmarked.
