# @evestack/schedules

Durable, observable, pausable cron for a self-hosted [eve](https://github.com/vercel/eve) agent.

```ts title="agent/schedules/digest.ts"
import { defineSchedule } from "eve/schedules";
import { tracked } from "@evestack/schedules";

const CRON = "0 9 * * 1-5";

export default defineSchedule({
  cron: CRON,
  run: tracked("digest", CRON, async ({ receive, waitUntil, appAuth }) => {
    // …your handler, unchanged
  }),
});
```

---

## What it adds

eve's schedules are good and this does not replace them. Self-hosted, they run through Nitro's
in-process task runner: the cron fires, your handler runs, and that is the whole of it. Four things
do not survive that, and all four are the ones you want at 3am.

| | eve self-hosted | with `tracked()` |
| --- | --- | --- |
| A record that a fire happened | — | a row per tick, forever, in your Postgres |
| A handler that threw | lost to stdout | recorded with the error, and still rethrown |
| Pausing one schedule | edit code, redeploy | a switch, picked up on the next fire |
| A tick missed while the process was down | gone | replayed, and labelled as a replay |

On Vercel, their Cron Jobs dashboard covers most of this. Off it, the part of your agent that acts
while nobody is watching is the part you can see least.

## Install

```bash
pnpm add @evestack/schedules
```

Needs `WORKFLOW_POSTGRES_URL` — the same database eve's sessions already live in. Tables are created
on first use in the `evestack` schema, never in `workflow`, which belongs to eve.

The name is passed explicitly (`tracked("digest", …)`) because eve derives a schedule's identity
from its file path at compile time and does not hand that name to the handler at runtime. Repeating
it is the price of not guessing.

## Catch-up

Off by default, and that default is the honest one — replaying is right for "post the digest I owe
you" and wrong for "charge the card", and only the author of the handler knows which they wrote.

```ts
tracked("digest", CRON, handler, {
  catchUp: true,
  catchUpLimit: 3,                     // at most 3 replays
  catchUpWindowMs: 6 * 60 * 60 * 1000, // ignore gaps older than 6h
});
```

Replays are idempotent by construction: a unique index on `(name, fire_at)` means the same tick
cannot be recorded twice, so two workers racing to replay it cannot both run the handler. Replayed
rows carry `caught_up = true` and the dashboard labels them, because a replay is not the same event
as a live fire and a history that renders them identically is quietly misleading.

## Failure policy

Deliberate, and worth knowing before you rely on it:

- **A store failure never stops your handler.** A schedule that stops running because its bookkeeping
  database was briefly unreachable is a worse outcome than one that runs unrecorded. Store errors are
  logged and swallowed.
- **The pause check fails open.** If the pause table cannot be read, the schedule runs. A schedule
  silently not firing is an invisible outage; one firing when it should not have is visible in the
  history.
- **Handler errors are recorded and rethrown.** This is a recorder, not a swallower of your errors —
  eve's runner should see the failure too.

## The cron parser

Hand-written, no dependencies, 19 tests (`pnpm test`). Supports `*`, `N`, `A-B`, `A-B/S`, `*/S`,
comma lists, month and day names, `@daily`-style aliases, and Sunday as either `0` or `7`.

It implements Vixie cron's genuinely surprising rule: **when both day fields are restricted they are
OR-ed, not AND-ed** — `0 0 13 * 5` fires on the 13th *and* on every Friday. Matching that matters
more than being tidy, because the same expression is also handed to eve's own runner.

It **refuses** rather than guesses: six fields (seconds), `L`, `W`, `#`, `?`, out-of-range values and
non-timezone-local interpretation all throw at module load. A schedule that silently means something
other than what it says is worse than one that will not start.

Timezone is the host's, matching cron and matching eve.

## Heartbeat

The evestack template ships `agent/schedules/heartbeat.ts` as the worked example: the agent wakes on
its own, reads a `HEARTBEAT.md` you can edit without a redeploy, and messages you **only when there
is something to say** — replies that are just an acknowledgement token are dropped. An hourly
heartbeat that always sends something is an hourly notification, and you will mute it within a day.

Off unless `EVESTACK_HEARTBEAT_CHANNEL` and `EVESTACK_HEARTBEAT_TARGET` are set.

Apache-2.0.
