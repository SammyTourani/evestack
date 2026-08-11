# Building on a scaffolded project

## Layout

```
agent/
  agent.ts              defineAgent — model, provider, workflow store
  instructions.md       the system prompt
  instrumentation.ts    tracing setup
  tools/                one file per tool, default-exported
  skills/               SKILL.md packages the model can load on demand
  schedules/            recurring work
  channels/             eve, slack, discord, telegram
  hooks/                budget.ts and friends
  sandbox/sandbox.ts    the Docker shell sandbox
lib/memory.ts           pgvector remember / recall / forget
evals/                  *.eval.ts
scripts/                bootstrap, verify, dev, retention, prune
docker-compose.yml      postgres + dashboard (behind a profile)
.env.local              every credential and port this project got
```

`agent.ts` is deliberately small — provider selection, the durable workflow store, and the
`defineAgent` call:

```ts
export default defineAgent({
  model,
  ...(provider === "ollama" ? { modelContextWindowTokens: localContextWindow } : {}),
  ...(workflow ? { experimental: { workflow } } : {}),
});
```

`workflow` is set only when `WORKFLOW_POSTGRES_URL` is present. Without it eve falls back to a
local on-disk world under `.eve/.workflow-data` — fine for a quick `eve dev`, but that directory
must be mounted if the data matters.

## Adding a tool

One file in `agent/tools/`, default export, zod schema. eve discovers it — there is no registry
to edit.

```ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { remember } from "../../lib/memory";

export default defineTool({
  description:
    "Save a durable fact, preference, or decision to long-term memory so it survives " +
    "beyond this conversation.",
  inputSchema: z.object({
    content: z.string().min(1).max(4000)
      .describe("The fact, written as a standalone sentence that still makes sense months from now."),
    tags: z.array(z.string()).max(10).optional()
      .describe("Short lowercase labels for filtering later, e.g. ['preference', 'deploy']."),
  }),
  async execute({ content, tags }, ctx) {
    const { id } = await remember(content, { tags, sessionId: ctx.session?.id });
    return { saved: true, id };
  },
});
```

Two things carry more weight than they look like they do:

- **`description` is the routing signal.** It is the only thing the model sees when deciding
  whether to call the tool. Write it as instructions for *when to use this*, not as a summary of
  what the code does.
- **Use relative imports (`../../lib/memory`), not subpath imports (`#lib/memory`).** Tool files
  also ship as registry items into stock `eve init` projects, which map only `#*` → `./agent/*`
  with no tsconfig `paths`. TypeScript's `bundler` resolution ignores package.json `imports`
  entirely, so a subpath import cannot be made to typecheck there without editing two files.

## Adding a skill

A skill is instruction text the model can pull into a turn on its own decision, via a
framework-owned `load_skill` tool. Two shapes:

```
agent/skills/my-skill/SKILL.md      packaged — id is the directory name
agent/skills/my-skill.md            flat markdown — id is the filename
```

Packaged frontmatter **must** carry a string `description` or eve reports a discovery error and
the skill never loads. Flat markdown may omit it — eve derives one from the first non-empty,
non-fence line with leading `#`, `>`, `*`, `-` stripped, falling back to
`"Instructions for the <name> skill."`, which is a description no model has a reason to route to.

eve reads exactly three frontmatter keys: `description`, `license`, and a flat string-valued
`metadata` map. Every other key is accepted and then ignored.

```markdown
---
description: Use when deciding whether to save something to long-term memory, or when recalled memories look stale.
license: Apache-2.0
---

Long-term memory is the one part of this agent that outlives the conversation...

See `references/checklist.md` for the short version.
```

**Security note worth saying out loud to a user:** everything in `agent/skills/` reaches the
model's context without a human in the loop. It is untyped instruction text with a route to
influence behaviour. The dashboard ships a scanner for exactly this reason.

## Long-term memory

`lib/memory.ts` exposes `remember` / `recall` / `forget` over pgvector in the same Postgres the
sessions live in.

- The index is **HNSW, not IVFFlat**. IVFFlat built on an empty table returns zero rows for
  queries that should match, because it probes a meaningless centroid. Measured, not theorised:
  the same query returned 2 results at `LIMIT 3` and 0 at `LIMIT 20`.
- `recall` cannot return more than `hnsw.ef_search` rows. That was 40 by default while the tool
  advertised a limit of 50, so `limit: 45` and `limit: 50` both silently returned 40. It now
  widens `ef_search` per query.
- Embeddings need a provider that has them. See the Anthropic caveat in `SKILL.md`.
- `forget` is irreversible and gated on a human approval every time.

## Schedules

Files in `agent/schedules/`. One trap that costs an afternoon:

**`eve dev` does not fire schedules on a clock — it only registers them.** The timer exists
only in a built server. Dispatch by hand during development:

```bash
curl -X POST http://127.0.0.1:2000/eve/v1/dev/schedules/<name>
```

## Human-in-the-loop approvals

Gated tools park the turn until someone answers. Approvals have **no dedicated HTTP endpoint** —
they resolve through the normal continuation route:

```jsonc
{ "inputResponses": [{ "requestId": "…", "optionId": "approve" }] }
```

The dashboard exposes this as a UI, and `@evestack/mcp` exposes it as a tool that is withheld
from `tools/list` entirely unless `EVESTACK_MCP_ALLOW_CONTROL=1`.

## Evals

`evals/*.eval.ts`, run by eve's eval runner. Three rules that are not guessable:

- **Eval identity comes from the file path.** Authoring an `id` or `name` throws.
- **Assert on the turn returned by `t.send()`**, not on `t`.
- A denied tool needs **both** `{ status: "rejected" }` and session scope to match.

## Channels

`agent/channels/` ships `eve`, `slack`, `discord` and `telegram`. `channels/eve.ts` calls eve's
`localDev()` directly, and on the pinned version that is correct — eve 0.30.0 fixed the
`Host`-header auth bypass upstream by deciding the grant from the process rather than the
request. **Do not re-add the old exact-match loopback wrapper**: on 0.30+ it adds no protection
and wrongly rejects local dev over a LAN IP, a tunnel, or a container hostname.

## Registry

evestack ships primarily as an eve **registry**, so an existing eve project can adopt one piece
without migrating:

```bash
eve registry add @evestack=https://raw.githubusercontent.com/SammyTourani/evestack/main/registry/r/{name}.json
```

Registry items pin dependency versions from `templates/default/package.json`, and CI enforces
the match. A bare unversioned name is a bug, not a style choice.
