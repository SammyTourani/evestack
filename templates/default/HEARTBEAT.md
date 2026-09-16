<!--
Heartbeat checks — inactive until you add instructions outside this comment.

Edit this file, then run:
  npm run heartbeat:preview

The preview shows the exact prompt, target, next cron times and quiet-hour gate.
No checks, an empty file or a missing file means no model dispatch. This file is
read on every fire; environment changes still require an agent restart.

Copy one example below OUTSIDE this comment and tailor it to your setup:

## Checks
- Use recall to inspect my recent saved facts. If two conflict, quote the relevant
  facts and ask which one is current. Do not modify or delete them.
- Inspect the repository I explicitly connected. Summarize newly failing checks
  with links and one suggested next action. Do not change files or contact people.

## Ground rules
- Report only something new or actionable. Prefer one short message with links.
- When there is nothing to report, reply with exactly <eve-empty-delivery/> and
  nothing else. A decorated marker is delivered as a normal message.
- If a check needs approval, describe the proposed action and why it needs me.
- These instructions guide behavior; tool permissions must be enforced separately.

Quiet hours are configured in .env.local, for example:
  EVESTACK_HEARTBEAT_QUIET_HOURS=22:00-08:00
  EVESTACK_HEARTBEAT_QUIET_TIMEZONE=America/Toronto

Quiet hours skip NEW dispatches, including catch-up checked during that window.
They do not cancel an already running turn or suppress its later reply.
Dashboard routines are managed in Routines; this heartbeat uses the agent's
code-authored schedule and appears under Diagnostics / Schedules.
-->
