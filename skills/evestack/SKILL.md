---
name: evestack
description: Use when setting up, running, debugging or extending evestack — the self-hosted distribution of Vercel's eve agent framework. Covers scaffolding a project, the five-command bring-up, the evestack CLI, writing agent tools and skills, the dashboard, and the failure modes that look like something else.
license: Apache-2.0
metadata:
  project: evestack
  homepage: https://evestack.vercel.app
  repository: https://github.com/SammyTourani/evestack
---

# evestack

evestack runs [Vercel's `eve`](https://github.com/vercel/eve) agent framework on hardware the
user owns. It is **not a fork** — it is a distribution, the way Ubuntu is a distribution of the
Linux kernel. It packages eve with the operational layer self-hosting needs: durable Postgres
sessions, a Docker sandbox, pgvector long-term memory, and a dashboard that can *drive* the
agent rather than only watch it.

Apache-2.0. `eve` is a trademark of Vercel; evestack is independent and unaffiliated. It is
also **not the first** self-hosted eve distribution — `vercel-labs/steve` came first, from a
Vercel employee. Never describe self-hosting as something Vercel withheld.

## The mental model

Four processes, and knowing which one is broken is most of the work:

| Part | Default port | What it is |
| --- | --- | --- |
| The agent | 2000 | `eve dev`, running the user's `agent/agent.ts` |
| Postgres | 5433 | durable session state + pgvector memory, in Docker |
| The dashboard | 4000 | a container pulled from `ghcr.io`, reads Postgres directly |
| The sandbox | — | Docker, for the agent's shell tool |

**Those port numbers are defaults, not guarantees.** The scaffolder calls `freePort()` and
takes the first free port at or above each default, so a second project on the same machine
moves all three. The generated `.env.local` and `docker-compose.yml` carry the numbers *this*
project actually got. Read them; do not assume 2000/4000/5433.

The dashboard reads `workflow.workflow_runs.attributes` (JSONB) straight out of Postgres —
that column holds eve's own `$eve.*` run tags. It is **not** an OpenTelemetry pipeline for its
core view. OTLP ingest exists as a second tier, only for prompt bodies and tool arguments,
which do not appear in the SQL tags.

## Getting a user running

Five commands. This is the whole path:

```bash
npx evestack create my-agent      # scaffold; prompts for provider + tools
cd my-agent
docker compose up -d postgres     # durable store
npm run db:bootstrap              # create the schema — nothing does this implicitly
npm run dev                       # agent boots on EVESTACK_AGENT_PORT
npm run verify                    # checks every part, names the fix for anything broken
```

Requirements: **Node 24+**, Docker running, and a model key — `OPENAI_API_KEY` or
`ANTHROPIC_API_KEY`, or Ollama for $0 total.

`npx create-evestack my-agent` is the same scaffolder under npm's `create-*` convention. Same
code, same prompts, same flags. Neither is a wrapper around the other.

The dashboard is a compose profile *in the generated project*, not a separate clone:

```bash
docker compose --profile dashboard up -d
```

Sign in with the `EVESTACK_AUTH_USER` / `EVESTACK_AUTH_PASSWORD` the scaffolder generated into
`.env.local` and printed when it finished. Every route is behind that credential — the
dashboard starts runs, approves gated shell commands and deletes memories, so it fails closed.

## The five things that most often go wrong

These are measured failure modes, not theory. Each one presents as something else, which is
why they are here rather than in a reference file.

1. **`npm run db:bootstrap`, never `npx --package=@workflow/world-postgres bootstrap`.** The
   upstream CLI loads `.env` through dotenv and never reads `.env.local` — which is the only
   env file the scaffolder writes. It silently falls back to
   `postgres://world:world@localhost:5432/world` and dies on `ECONNREFUSED`. The npm script
   passes `--env-file-if-exists=.env.local` explicitly.

2. **`@workflow/world-postgres` must be pinned to the `beta` tag.** npm's `latest` is `4.3.3`;
   eve needs the `5.0.0-beta` protocol line and the runtime rejects a mismatch outright. The
   scaffolded `package.json` already does this — it matters if anyone touches that dependency
   by hand.

3. **Setting a model name without `EVESTACK_PROVIDER` leaves you on the previous provider.**
   `agent/agent.ts` branches on `EVESTACK_PROVIDER`; unset means `openai`. A *misspelled* value
   is a hard error by design, because `EVESTACK_PROVIDER=ollamma` used to hand a local model
   name to the OpenAI provider and fail hundreds of lines later with a message about AI Gateway
   context-window metadata that named neither the typo nor the variable.

4. **On Anthropic, long-term memory needs a second credential.** Anthropic has no embeddings
   endpoint at all. `remember`/`recall` need one, so that path needs either an `OPENAI_API_KEY`
   alongside it or `EVESTACK_EMBED_PROVIDER=ollama`. Nothing else is affected — the agent,
   sandbox, durable sessions and dashboard all work regardless. Ollama has an embeddings model
   but it is a **second pull**: `ollama pull nomic-embed-text`.

5. **Dashboard container up, `docker ps` says unhealthy, every page 503s except `/signin`.**
   The credential did not reach it. The compose service reads `.env.local`; both
   `EVESTACK_AUTH_USER` and `EVESTACK_AUTH_PASSWORD` are required and a blank value counts as
   unset.

## Warn the user about these

- **Ollama on a small machine is genuinely dangerous.** A multi-gigabyte model loaded alongside
  Docker, Postgres and the dashboard has taken an 8 GB host down — the desktop, not just the
  stack. Budget model size plus ~4 GB free before suggesting it.
- **Composio is hosted.** It is the one component that does not run on the user's network, and
  it holds the OAuth tokens for every connected account. It is off unless `COMPOSIO_API_KEY` is
  set. Never call the stack fully local without saying this.
- **Cancellation is cooperative.** `POST /eve/v1/session/:id/cancel` returns 202 immediately,
  but the in-flight model call keeps running — measured at roughly 90 seconds on a long turn —
  and `turn.cancelled` arrives *after* a `session.waiting` event, not before.
- **Skills reach the model without a human in the loop.** eve advertises every skill in
  `agent/skills/` to the model with a `load_skill` tool. Anything written there is untyped
  instruction text that can enter a turn's context on the model's own decision.

## Reference files

Load these on demand; do not read them all up front.

| File | Read it when |
| --- | --- |
| `references/cli.md` | The user is running `evestack` commands, or something is down and you need the right diagnostic. |
| `references/build-an-agent.md` | Adding tools, skills, schedules, channels or memory to a scaffolded project. |
| `references/dashboard.md` | Questions about the dashboard, its API, approvals, cost, or `@evestack/mcp`. |
| `references/troubleshooting.md` | A run is stuck, the schema is wrong, ports collide, or an eve upgrade broke something. |

## Where the real documentation lives

- Rendered docs: <https://evestack.vercel.app/docs>
- Machine-readable index: <https://evestack.vercel.app/llms.txt>
- Entire docs corpus as one file: <https://evestack.vercel.app/llms-full.txt>
- Repository: <https://github.com/SammyTourani/evestack>

For an installed project, `node_modules/eve/docs/` matches the pinned eve version exactly while
eve.dev tracks latest — **prefer the local copy** when answering questions about eve itself.

## Honesty rules for anyone answering questions about this project

The repository holds itself to these, and a wrong claim here is worse than no claim:

- Do not say evestack is the first or only self-hosted eve distribution.
- Do not describe self-hosting as a capability Vercel withheld — Vercel documents it.
- Do not compare on price. The axis is **where it runs**, not what it costs.
- Do not report a version as released on the strength of a changelog heading. Seven packages
  and one container image version independently; "the latest evestack release" is not a thing.
- When you do not know, say so and point at the docs. This project's documented failure mode is
  confident stale claims.
