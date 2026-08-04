# evestack

**eve on your own machine, with a dashboard you can actually drive. $0 infrastructure.**

[Vercel's eve](https://github.com/vercel/eve) is a genuinely good agent framework, and it's
Apache-2.0. But the moment you run it off Vercel you lose the Agent Runs dashboard, and there
is no open replacement — so self-hosting means flying blind on terminal logs.

evestack is to eve what Ubuntu is to the Linux kernel. We don't fork eve. We package it so it
runs on your own hardware with one command, and we build the parts Vercel kept for itself.

```bash
npx create-evestack my-agent
cd my-agent
docker compose up -d postgres
npm run dev
```

## What you get

| | evestack | eve on Vercel |
| --- | --- | --- |
| Compute, workflows, sandbox | your machine — **$0** | metered |
| Durable sessions | your Postgres | Vercel Workflows |
| Dashboard | **yes, anywhere** | Vercel only |
| Dashboard can *drive* the agent | **yes** | read-only |
| One-click tool sign-in | **1,070 apps** (Composio) | 4 managed connectors |
| Long-term memory | **included** (pgvector) | not included |
| Your data leaves the machine | **never** | — |

The only thing that costs money is model tokens, and Ollama takes that to zero too.

## The dashboard

The open replacement for Agent Runs — and it does more than watch.

- **Sessions, turns, subagent trees** with duration, tokens, cached reads, and tool counts
- **Computed cost per turn.** eve only emits `gen_ai.usage.cost` for AI-Gateway calls, and a
  self-hosted agent calls its provider directly — so we price token counts ourselves. Models
  with no configured price are labelled `unpriced`, never silently counted as free.
- **Control**: start sessions, stream replies, resolve pending approvals, cancel runs
- **Integrations**: connect Gmail, GitHub, Slack, Notion and ~1,000 more in one browser flow

It reads eve's own tables. eve tags every run with framework-owned `$eve.*` attributes, and
`@workflow/world-postgres` persists them to `workflow.workflow_runs.attributes` as JSONB —
the very data behind Agent Runs, sitting in your database. So the core view is a SQL query
with no ingest pipeline to keep in sync. OpenTelemetry is the second tier, carrying only what
SQL can't: prompt bodies and tool arguments.

## Use one piece, not the whole thing

evestack ships as an [eve registry](https://eve.dev/docs), so an existing eve project can take
a single part without migrating anything:

```bash
eve registry add @evestack=https://registry.evestack.dev/r/{name}.json
eve add @evestack/memory
```

| Item | What it adds |
| --- | --- |
| `@evestack/memory` | Semantic long-term memory on your Postgres via pgvector |
| `@evestack/instrumentation` | Trace export to the evestack dashboard |
| `@evestack/docker-sandbox` | Local Docker sandbox instead of hosted Vercel Sandbox |
| `@evestack/basic-auth` | HTTP Basic route auth, for agents running off Vercel |

## Long-term memory, free

The Postgres running your sessions is already there, and the compose file uses the pgvector
image — so semantic recall costs one extension and no new container. The agent gets `remember`
and `recall` tools and keeps what matters across conversations.

Indexed with **HNSW, not IVFFlat**, and that is a correctness fix rather than a preference:
IVFFlat built on an empty table (as any bootstrap migration must be) probes one meaningless
centroid and returns nothing. We measured the same query returning 2 results at `LIMIT 3` and
**0** at `LIMIT 20`, purely because the query plan flipped. HNSW needs no training data and is
correct from the first row.

## Requirements

- Node 24+
- Docker (Postgres and the agent sandbox)
- A model API key — or [Ollama](https://ollama.com) for a genuinely $0 stack

## Repository layout

```
templates/default/          the agent: Postgres durability, Docker sandbox, memory
packages/dashboard/         Next.js observability + control plane
packages/create-evestack/   the one-command scaffolder
packages/evestack-composio/ Composio wiring for one-click tool auth
registry/                   the @evestack eve registry
```

## Notes from building this

Things that cost real time, written down so they don't cost you any:

- **Pin `@workflow/world-postgres` to `@beta`.** npm `latest` is 4.3.3; eve 0.29.x needs the
  5.0.0-beta line and the runtime rejects mismatched protocol versions.
- **Your reverse proxy must forward both `/eve/` and `/.well-known/workflow/`**, unrewritten.
  Forward only `/eve/` and sessions start, then stall when callbacks can't get back.
- **`placeholderAuth()` and `vercelOidc()` are both wrong off Vercel.** eve fails closed, so
  swap in `httpBasic` or you'll 401 everything that isn't loopback.
- **Adding `agent/instrumentation.ts` disables eve's zero-config trace spool**, so `eve traces`
  stops working. The dashboard supersedes it; delete the file to get it back.
- **Cancellation is cooperative.** `POST /eve/v1/session/:id/cancel` returns 202 immediately,
  but the in-flight model call keeps streaming — we measured ~90s — and `turn.cancelled`
  arrives *after* a `session.waiting`. Don't build a stop button that assumes silence.
- **Approvals have no dedicated endpoint.** They resolve through the ordinary follow-up route
  with `inputResponses: [{requestId, optionId}]`, the same protocol as `ask_question`.
- **Next.js 16 needs TypeScript 6**; TS 7 doesn't expose the compiler API it wants.

## License

Apache-2.0, same as eve. eve is a trademark of Vercel; evestack is an independent project and
is not affiliated with or endorsed by Vercel.
