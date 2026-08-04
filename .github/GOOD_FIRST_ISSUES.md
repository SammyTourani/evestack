# Seed issues to file once the repo is public

Not GitHub issues yet — the repo doesn't exist publicly. Paste these in as-is with
`gh issue create` once it does. Each came from a real gap surfaced during adversarial
verification of the dashboard build, not a guess at what might be missing.

---

### 1. Session tree nesting has never been exercised past depth 1

**Labels:** `good first issue`, `dashboard`

`packages/dashboard/app/sessions/[id]/page.tsx` builds a tree from flat rows using
`$eve.parent`/`$eve.root`, with a cycle guard and recursive rendering — but every session
tested against it so far has been session → turn, one level deep. A subagent run (session →
turn → subagent → turn) has never rendered in the real UI.

**To do:** drive a session that delegates to a subagent (the `agent` tool, or a declared
subagent under `agent/subagents/`), confirm the tree renders correctly nested rather than
flattened, and fix whatever it actually does instead. `templates/default` already has
Postgres durability wired up, so the data will land — the gap is purely "has a human looked
at the rendered output."

---

### 2. Unpriced-model badge has never rendered against a real unpriced model

**Labels:** `good first issue`, `dashboard`

`packages/dashboard/lib/pricing.ts` returns `0` and marks a model `unpriced` when it's not in
the pricing table or `EVESTACK_PRICING` override. The `.unpriced` CSS class exists and is
wired into `app/page.tsx`, but no session has ever actually used a model outside the default
table, so nobody has looked at how it reads next to a priced row.

**To do:** set `EVESTACK_MODEL` to something not in `DEFAULT_PRICING` (any real model id eve's
provider accepts), run a session, and confirm the dashboard clearly distinguishes "$0.00
because it's free" (Ollama) from "$0.00 because we don't know the price" (unpriced). Right now
both can render identically, which is the actual bug this issue is tracking down.

---

### 3. Document the cooperative-cancellation UX gap

**Labels:** `good first issue`, `documentation`, `dashboard`

`POST /api/control/sessions/[id]/cancel` returns 202 immediately, but cancellation is
cooperative — the in-flight model call keeps streaming (measured ~90s on a long turn), and
`turn.cancelled` arrives *after* a `session.waiting` event, not before. The dashboard's stop
button currently reflects this correctly at the API level, but there's no UI affordance
telling a user "cancellation requested, still finishing" versus "cancelled." Add one, and add
a line to the README's control-API section making the ordering explicit for anyone integrating
against it directly.

---

### 4. `eve eval` in CI, gated on a secret

**Labels:** `good first issue`, `help wanted`

CI currently runs typecheck, the dashboard build, and scaffolder/registry smoke tests — not
the eval suite, since it needs a real model key and Docker. Add a workflow (manually
triggered, or gated on `if: github.repository == '<org>/evestack'` so forks never spend
someone else's key) that runs `eve eval` against a repo secret, so regressions in agent
behavior get caught before merge instead of only in local development.
