# skills/

The evestack **Agent Skill pack** — what a user hands to their own coding agent so it can set
up, run and debug evestack without being told anything else.

This is not the same thing as `templates/default/agent/skills/`. That directory is skills for
the agent evestack *scaffolds*. This one is a skill *about* evestack, for whatever agent the
user already works in — Claude Code, Cursor, a local model, anything that reads markdown.

```
skills/evestack/
  SKILL.md                       the routing description + the core model
  references/cli.md              the eight commands and which diagnostic to reach for
  references/build-an-agent.md   tools, skills, memory, schedules, evals, registry
  references/dashboard.md        pages, HTTP API, auth, @evestack/mcp
  references/troubleshooting.md  the failure modes, in the order they happen
```

## It is one artifact with three delivery channels

Written once here, and served three ways. Nothing below re-states the content — they all read
these files:

| Channel | Surface |
| --- | --- |
| **Copy** | The landing page's "Set up your agent" button, and `https://evestack.vercel.app/agent.md`. Assembled by `packages/website/lib/agent-pack.ts` at build time. |
| **Install** | `npx evestack skills`, which writes the pack into the user's own skills directory. |
| **Fetch** | Linked from `/llms.txt`, alongside `/llms-full.txt` for the complete docs corpus. |

That is deliberate. Duplicated claims going stale is this repository's most expensive recurring
failure — six version pins, ten stale claims in one release — so the pack exists in exactly one
place and every surface reads it.

## Format

Standard Agent Skill format: YAML frontmatter with a `description`, a markdown body, and
reference files loaded on demand rather than up front. It is the same format eve itself
discovers in `agent/skills/`, which is why `npx evestack skills --dir agent/skills` produces a
skill the scaffolded agent can load natively.

The `description` is the routing signal — it is all an agent sees when deciding whether this
skill is relevant. Edit it with that in mind.

## Editing rules

The pack ships to strangers' agents and is quoted back at them as fact, so:

- **Every claim must be reproducible.** The gotchas here are measured, not theorised. If you
  cannot point at the code or the run that proves it, it does not go in.
- **Keep `SKILL.md` short.** It is always in context; the reference files are not. Anything that
  is only needed sometimes belongs in a reference.
- **No marketing.** No first-or-only claims, no price comparisons, no "Vercel withheld this".
  The honesty rules at the bottom of `SKILL.md` bind the pack itself, not only its readers.
