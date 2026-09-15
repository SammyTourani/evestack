# Heartbeat

What the agent should check when it wakes up on its own. Edit this file freely —
it is read at every fire, so a change takes effect on the next wake-up with no
restart and no redeploy.

The rule that makes this liveable: **the agent only messages you when something here
produces news.** When every check comes back boring it replies with exactly
`<eve-empty-delivery/>`, which is eve's marker for "I am finished, deliver nothing". eve
turns that into a completed turn carrying no message, and no channel posts a message that
is not there. A quiet hour is genuinely silent — nothing on Telegram, Slack or Discord, and
nothing added to the conversation's history either.

> **The marker has to be the whole reply.** eve suppresses a response only when the marker
> is the entire thing apart from surrounding whitespace — on purpose, so that a reply which
> quotes or explains the marker still reaches you. `<eve-empty-delivery/>, nothing to
> report` is a message, and it will ping you. If an hourly heartbeat starts sending you
> something that reads like an acknowledgement, that is what is happening: tighten the
> ground rules below. There is nothing in this project that could filter it instead — eve
> posts the reply itself, so your code never sees the text.

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
