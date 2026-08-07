# @evestack/budget

Dollar spend caps for a self-hosted [eve](https://github.com/vercel/eve) agent — per session, and **per principal per day**.

```
agent/hooks/budget.ts   →  export default budgetHook();
agent/tools/budget.ts   →  export default budgetGuard({ guardTools: [...] });
```

On by default in the evestack template at **$2 per session and $10 per user per day**.

---

## What it actually does

> **It pauses at $X, plus at most one step that was already in flight.**
>
> It is **not** a hard limit. eve threads no `abortSignal` into model calls
> ([vercel/eve#483](https://github.com/vercel/eve/issues/483)), so nothing — not this package, not eve itself —
> can kill a generation mid-stream. Enforcement happens *between* steps. The model call that crosses your
> cap is always allowed to finish and always bills.

That is the whole claim. Everything below is detail.

In practice the overshoot is small: across every trip measured on this repo, **zero additional model calls
ran after the crossing step**. But zero is an observation, not a guarantee, so the promise above says one.

## Why this isn't already in eve

eve *does* have runtime limits, and they are good ones. `limits.maxInputTokensPerSession` /
`maxOutputTokensPerSession` in `agent.ts` stop the session before the next model call, raise a
continuation prompt with **Approve** / **Stop**, and split quota across delegated subagents so a
delegation tree cannot outspend its root. If a token cap on one session is what you need, **use eve's —
it is a first-class supported path and this package does not replace it.**

Three things it cannot be:

| | eve's `limits` | `@evestack/budget` |
| --- | --- | --- |
| Unit | provider tokens | US dollars, priced per model |
| Scope | one durable session | session **and** principal-per-day |
| Set at | build time, in `agent.ts` | runtime, per deployment |

The scope row is the one that matters. Every limit eve has is scoped to a single durable session —
including the default `maxInputTokensPerSession` of 40,000,000, which is somewhere between $120 and $600
depending on the model, with output uncapped. A caller who wants more just starts a new session
([vercel/eve#551](https://github.com/vercel/eve/issues/551)).

A cap that means anything is "$5 per user per day", and that needs a store that outlives the session.
eve has nowhere to put one. evestack already runs Postgres for durable sessions, so it does.

## Install

```bash
pnpm add @evestack/budget
```

Needs `WORKFLOW_POSTGRES_URL`, or `DATABASE_URL` if that is the name your platform sets — the same
database eve's sessions already live in, and the same two names the dashboard and `@evestack/schedules`
read. Tables are created on first use in the `evestack` schema (never `workflow`, which belongs to eve).

**`agent/hooks/budget.ts`**

```ts
import { budgetHook } from "@evestack/budget";
export default budgetHook();
```

**`agent/tools/budget.ts`** (optional but recommended — see [The guard](#the-guard))

```ts
import { budgetGuard } from "@evestack/budget";
export default budgetGuard({
  guardTools: ["remember", "recall", "forget", "bash", "write_file", "web_fetch"],
});
```

## How it works

**The hook** subscribes to `step.completed`, which is the only event that carries token usage
(`message.completed`, `action.result` and `turn.completed` do not). It prices the tokens, adds them to
two counters in Postgres, and compares against both caps.

**When a cap is crossed** it writes a stop row, writes a `budget_events` row saying why, and then either
throws (default) or POSTs eve's own `/eve/v1/session/:id/cancel` route.

**The guard** is a `step.started` dynamic resolver. It runs before every model call, reads the stop the
hook wrote, and — when the budget is gone — replaces the tools you name with a refusal. A dynamic tool
overrides an authored tool of the same name, so this works on framework built-ins too.

Deduplication is on step coordinates (`turnId`, `stepIndex`, `sequence`), not on `meta.id`. eve retries
an interrupted step and re-emits its events under fresh ids, so keying money on `meta.id` would bill the
retry twice.

## Configuration

Every field reads from the environment, so `budgetHook()` with no arguments is a complete configuration.
Options passed in code win over the environment.

| Env var | Default | Meaning |
| --- | --- | --- |
| `EVESTACK_BUDGET_SESSION_USD` | `2` | Per-session cap. `false` disables it. |
| `EVESTACK_BUDGET_DAILY_USD` | `10` | Per-principal-per-day cap. `false` disables it. |
| `EVESTACK_BUDGET_DISABLED` | unset | `1` turns the whole thing off. |
| `EVESTACK_BUDGET_MODE` | `fail` | `fail` \| `cancel` \| `observe`. |
| `EVESTACK_BUDGET_TIMEZONE` | `UTC` | IANA zone the daily window is cut on. A value `Intl` rejects warns once and falls back to `UTC`. |
| `EVESTACK_BUDGET_MODEL` | from `EVESTACK_PROVIDER`/`EVESTACK_MODEL` | Model id used to price tokens. |
| `EVESTACK_BUDGET_UNPRICED` | `warn` | `stop` treats an unpriced model as already over budget. |
| `EVESTACK_BUDGET_FAIL_CLOSED` | unset | `1` fails the turn when the spend store is unreachable. |
| `EVESTACK_BUDGET_AGENT_URL` | `http://127.0.0.1:$PORT` | Where to send the cancel, in `cancel` mode. |
| `EVESTACK_BUDGET_GUARD_TOOLS` | empty | Comma-separated tool names for the guard. |
| `EVESTACK_PRICING` | built-in table | Price overrides, shared with the dashboard. |

**To raise a cap:** `EVESTACK_BUDGET_SESSION_USD=25`.
**To disable one axis:** `EVESTACK_BUDGET_DAILY_USD=false`.
**To disable everything:** `EVESTACK_BUDGET_DISABLED=1`.
**To measure before enforcing:** `EVESTACK_BUDGET_MODE=observe` — counters fill, nothing stops.

A cap raised under a session that already hit the old one heals on the next step: the hook lifts its own
stop as soon as it evaluates and finds the budget is no longer gone.

## What the user sees

In `fail` mode (the default) the reason is on the event stream, verbatim, on both `step.failed` and
`turn.failed`:

```
step.failed  MODEL_CALL_FAILED: Stopped by the evestack session budget: $0.0006 spent
             against a $0.0004 cap. Raise EVESTACK_BUDGET_SESSION_USD or wait for the
             window to roll over.
turn.failed  MODEL_CALL_FAILED: (same message)
session.waiting
```

Two honest notes about that. The code says `MODEL_CALL_FAILED` because eve stamps the code and an
authored hook cannot choose it — no model call actually failed. And it reads as an error, when what
happened is a policy decision. In exchange, the reason is *somewhere a user can see it*, which
`cancel` mode cannot offer: eve gives authored code no way to write to the stream, so a cancel produces

```
turn.cancelled
session.waiting
```

and nothing else. Pick `cancel` if a red error in your client is worse than a silent stop; pick the
default if it is not.

Either way `session.waiting` follows and **the session stays resumable** — verified, not assumed. The
next message runs normally, and is stopped again if the budget is still gone.

The evestack dashboard answers "why did this stop", since the stream cannot:

```
GET /api/budget?sessionId=wrun_...
{ "day": "...", "limits": {...}, "session": {...},
  "principals": [...], "stops": [...], "events": [{ "action": "cancel:accepted", ... }] }
```

That route reads the tables with plain SQL rather than importing this package, because the dashboard
image is built from an isolated Docker context where a workspace dependency cannot resolve. The four
tables below are the contract between the two halves; anything can read them.

## The guard

Cancellation is cooperative, so a step can start between the stop and the turn settling. Measured on this
repo before the guard existed: a follow-up message into an over-budget session ran one more `remember`
call and wrote a row. The guard is what stops that — the tokens are already lost, the side effect need
not be.

With the guard on, the same follow-up produced no tool call at all. The model read the shadowed tool's
description and told the user itself:

> I can't use the built-in remember tool right now (it's unavailable). How would you like me to save
> "You like dark mode"?

Three limits, stated plainly:

1. **It shadows by name.** It cannot remove a tool you do not name. Add each authored tool to
   `guardTools` as you add it.
2. **Do not name `agent`.** Overriding a runtime-visible subagent tool throws
   `Dynamic tool "agent" collides with a runtime-visible subagent` and takes the turn with it.
3. **Do not name a tool another `step.started` resolver produces.** Two dynamic resolvers emitting one
   name is an ambiguity eve throws on. In the evestack template, `composio.ts` resolves on
   `step.started` — so keep `guardTools` to authored tools and framework built-ins.

And the guard does not stop the model call. Only the tools it can reach. A refused tool may well make the
model narrate, ask a question, or propose a workaround — all of which costs tokens. The stop is what ends
the loop; the guard only protects the world on the way out.

## Known holes

- **An unpriced model costs $0.00 and the cap never trips.** Unknown models price at zero by design
  (an unpriced model must never *look* cheap), so the hook logs once per model and counts the steps in
  `evestack.budget_usage.unpriced_steps`. Fix with `EVESTACK_PRICING`, or set
  `EVESTACK_BUDGET_UNPRICED=stop` to fail closed instead.
- **The model is configuration, not observation.** `step.completed` carries token counts but not the
  model that produced them, and eve only reports `usage.costUsd` for calls served by Vercel's AI Gateway —
  which a self-hosted agent by definition does not use. If your agent selects models dynamically, the
  prices will be wrong unless you set `EVESTACK_BUDGET_MODEL`.
- **Postgres down means no enforcement.** The default is to log loudly and keep serving, because a
  database blip becoming total agent unavailability is the worse outcome. `EVESTACK_BUDGET_FAIL_CLOSED=1`
  inverts that.
- **Subagent spend is attributed to the child session.** Delegated sessions get their own session
  counter. The per-principal daily counter still catches everything, because the principal is inherited.
- **With no channel auth configured, every caller is one principal** and the daily cap becomes
  agent-wide. That is coherent, but it is not per-user until you configure auth.
- **This is a cost control, not a security boundary.** Anyone who can reach the agent can spend up to the
  cap, and one step past it.

## Tables

All in the `evestack` schema.

| Table | What it holds |
| --- | --- |
| `budget_steps` | One row per model call. The deduplication key that survives eve's step retries. Swept at 30 days. |
| `budget_usage` | Aggregates, keyed `(scope, scope_key)` — `session`/`<sessionId>` and `principal-day`/`<day>\|<principal>`. Never swept. |
| `budget_stops` | Current stop state. The only thing the guard reads. Swept at 30 days. |
| `budget_events` | Why a stop happened, and what was done about it. Never swept. |

`budget_steps` and `budget_stops` are swept once per process, at 30 days. Neither is read by a cap after
that: a step row deduplicates retries that happen inside a turn, and a stop row older than the window
belongs to a session nobody resumed. `budget_usage` is deliberately never swept, because that is where
the money is — sweeping it would raise a cap retroactively, and it is what rewrites a stop row within one
step if an old session ever does come back. `budget_events` is not swept either: it grows per stop rather
than per step, and it is the only record of why a session stopped.

## The price table

There is exactly one, in `packages/dashboard/lib/pricing.ts`. `scripts/sync-pricing.mjs` copies it into
`src/pricing.ts` at build time, and that copy is gitignored so it cannot be edited by mistake.

The direction is forced rather than chosen: this package is published to npm and must carry the table in
its tarball, while the dashboard is containerized from an isolated build context (`context:
./packages/dashboard`, then a plain `npm install`) where a `workspace:*` dependency fails the image build
with `EUNSUPPORTEDPROTOCOL`. So the dashboard keeps the editable copy and the build takes it. Two tables
would let the number you are shown and the number you are stopped at disagree, which is the one
disagreement a spend cap cannot survive.

Override prices at runtime, in both halves at once, without touching either file:

```bash
EVESTACK_PRICING='{"openai/gpt-5-mini":{"input":0.25,"output":2,"cacheRead":0.025}}'
```

## License

Apache-2.0
