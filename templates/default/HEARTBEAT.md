# Heartbeat

What the agent should check when it wakes up on its own. Edit this file freely —
it is read at every fire, so a change takes effect on the next wake-up with no
restart and no redeploy.

The rule that makes this liveable: **the agent only messages you when something
here produces news.** If every check comes back boring it replies with the
acknowledgement token and you hear nothing. An hourly heartbeat that always
sends something is an hourly notification, and you will mute it within a day.

Delete the examples below and write your own.

---

## Checks

- Nothing is configured yet. Replace this list.

## Examples worth stealing

- Look through my recent memories with `recall`. If any two contradict each
  other, tell me which and ask which one is right.
- If any session in the last 24 hours ended in an error, summarise what failed
  and what you would try.
- Check whether anything I asked you to follow up on has gone quiet for more
  than two days.

## Ground rules

- You are running unattended. Do not ask a question you cannot act on later —
  nobody is watching the moment this fires.
- Prefer one message covering everything to several small ones.
- If a check needs a tool that requires approval, describe what you would do and
  why rather than requesting the approval — an approval that parks a heartbeat
  waits until a human happens to look.
