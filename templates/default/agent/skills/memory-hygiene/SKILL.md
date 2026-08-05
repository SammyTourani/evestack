---
description: Use when deciding whether to save something to long-term memory, or when recalled memories look stale, contradictory, or wrong.
license: Apache-2.0
---

Long-term memory is the one part of this agent that outlives the conversation.
A wrong fact saved today is a wrong answer every week from now until someone
notices, so treat writing to memory as a smaller decision than acting but a
larger one than replying.

## Before you save

Save a fact only if all four are true:

1. **It will still be true next month.** "Prefers TypeScript" survives. "Is
   debugging the login page" does not — that is session context, and the
   session already carries it.
2. **It is about the user or their work**, not about the task you happen to be
   doing right now.
3. **It stands alone.** Write the sentence so it makes sense to a reader who
   has none of this conversation. "Deploys on Fridays" is useless; "Sam deploys
   the billing service on Fridays and avoids releases the week of a board
   meeting" is not.
4. **You were told it, or you confirmed it.** Never save an inference you
   arrived at yourself and did not check. A guess that gets stored stops
   looking like a guess.

Tag what you save. Two or three short lowercase labels — `preference`,
`deploy`, `team` — are what make a memory findable later by something other
than luck.

## Things that do not belong in memory

- Anything the user pasted once and would not paste twice: keys, tokens,
  passwords, one-time codes. Memory is a plain table any operator can read in
  the dashboard, and it has no expiry.
- Personal details about third parties who are not in the conversation.
- Anything the user asked you to keep to the current session.
- Large blobs of text. Store the conclusion, not the transcript.

If the useful part of a fact is inseparable from a secret, save the shape and
not the value: "uses a scoped deploy token stored in their password manager"
carries the same meaning next month and leaks nothing.

## Before you answer from memory

Search first, then check what came back. Semantic search returns the nearest
thing, not necessarily a true thing.

- If two recalled memories disagree, say so and ask which is current rather
  than silently picking the higher-scoring one.
- If a memory is old and the topic is one that changes — tooling, team, job,
  priorities — treat it as a question, not a fact.
- If nothing relevant comes back, say you do not know. An invented
  recollection is worse than an admission.

## Fixing memory

Correcting a memory is two steps: save the correct fact, then delete the wrong
one. Deletion is irreversible and asks a human every time — that gate is
deliberate, so bring the id and the reason with you rather than trying several.

When the user says you have something wrong, fix the stored fact in the same
turn. A correction that only lives in the reply will be gone tomorrow.

See `references/checklist.md` for the short version to run through in a turn.
