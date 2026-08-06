<div align="center">

# evestack

### The whole eve stack. On your own machine.

A self-hosted distribution of the eve agent framework — durable Postgres sessions, a Docker
sandbox, and a dashboard that **observes *and drives*** the agent. One command scaffolds it;
four more bring it up.

[![CI](https://github.com/SammyTourani/evestack/actions/workflows/ci.yml/badge.svg)](https://github.com/SammyTourani/evestack/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/create-evestack?color=2563eb&label=create-evestack)](https://www.npmjs.com/package/create-evestack)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![eve compatibility](https://img.shields.io/badge/eve%20compatibility-every%20release-2563eb)](https://evestack.vercel.app/compat)

*eve is a trademark of Vercel. evestack is an independent project, not affiliated with or
endorsed by Vercel.*

**[See it before you run it →](https://evestack.vercel.app)** ·
**[Every eve release, run through the contract suite →](https://evestack.vercel.app/compat)**

Found [vercel/eve#1658](https://github.com/vercel/eve/issues/1658) — denying a tool approval
permanently fails the durable session (p1, open).

</div>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/dashboard-dark.webp">
  <img alt="The evestack dashboard: every agent session on this machine, with turns, tokens, computed cost, and an Infrastructure tile reading $0.00 — read straight from your own Postgres." src=".github/dashboard-light.webp">
</picture>

evestack is to `eve` what Ubuntu is to the Linux kernel. We don't fork eve. We package it so it
runs on your own hardware, and we fill in the operational layer that self-hosting still needs.

<!-- This used to read "we build the parts Vercel kept for itself." That is not
     true and is one search away from being disproved: vercel-labs/steve is a
     self-hosted eve distribution, published by a Vercel employee on 2026-06-24
     — six weeks before this repo — and it has 97 stars. Nothing was kept. -->

```bash
npx create-evestack my-agent
cd my-agent
docker compose up -d postgres
npm run db:bootstrap     # create the workflow schema — nothing creates it for you
npm run dev              # the agent on :2000
```

That is five commands, and none of them start the dashboard. The dashboard lives in this
repository rather than in the scaffolder, and no image is published yet — so it is a clone and
a build, once:

```bash
git clone https://github.com/SammyTourani/evestack
docker build -t evestack-dashboard:local -f evestack/packages/dashboard/Dockerfile evestack
cd my-agent && docker compose --profile dashboard up -d   # :4000
```

The context is the repository **root**, not `packages/dashboard`: the dashboard resolves
`@evestack/schedules` over pnpm's `workspace:*` protocol, which exists only against the root
lockfile. The generated `docker-compose.yml` already wires the service to your project's
database and to the `EVESTACK_AUTH_*` credentials in `.env.local` — sign in with those, because
every route is behind them.

From a clone of this repository on its own, the same thing is one command:
`docker compose --profile full up -d`.

## Why this exists

[Vercel's eve](https://github.com/vercel/eve) is a genuinely good agent framework, it's
Apache-2.0, and Vercel documents self-hosting it — the adapters are there, on purpose. What
the docs don't ship is the rest of the machine. Off-platform, the
[guidance for observability](https://vercel.com/docs/eve/observability) is to export
OpenTelemetry to a collector you operate.

**eve's own tooling is better than this section used to admit.** `0.29.3` (2026-07-31) added a
`/traces` command to the dev TUI: a full-screen live viewer over the local trace spool that
replays a session as expandable conversation cards — system prompt, messages, tool calls — with
a metadata drawer, and subagent turns badged with their dispatch lineage. `0.30.7` gave
`eve traces` inline token/cost/tool chips, a header aggregating models, token totals, cost and
errors, and `--verbose` / `--json`. Both are in `node_modules/eve/CHANGELOG.md`. To read one
session on the machine that ran it, that is a good tool and you don't need us for it.

What it isn't is a durable, shared surface:

- It reads a **local, bounded, self-pruning spool.** `eve dev` sweeps `.eve/traces` down to the
  twenty newest traces, seven days, and 512 MB (`EVE_TRACES_MAX_AGE_MS`,
  `EVE_TRACES_MAX_TOTAL_BYTES`, `EVE_TRACES_RETAIN_COUNT`) — history is a cache, not a record.
- It's **one operator at one terminal.** No URL to send anyone.
- It **reads.** It does not resolve a parked approval, start a session, or cancel a run.
- Authoring `agent/instrumentation.ts` — which any real OTel export requires — **turns the
  zero-config spool off**, so the two paths are exclusive.

So the gap is a single place that speaks *sessions, turns, tokens, cost and approvals*, that
more than one person can open, that keeps history for as long as you keep the rows, and that
can act on the agent instead of only watching it. evestack is that, packaged end to end and
tested against every eve release since `0.29.5` — [see the matrix](https://evestack.vercel.app/compat).

## Same framework, your infrastructure

| | Managed | Self-hosted with evestack |
| --- | --- | --- |
| Runs on | Vercel's infrastructure | your machine, VPS, or cluster |
| Session state | Vercel Workflows | your Postgres on `:5433` |
| Run-state retention | purged 1 day (Hobby) / 7 (Pro) / 30 (Enterprise) after a run completes [^1] | as long as you keep the rows |
| Observability retention | 12 hours (Hobby) / 1 day (Pro) / 3 days (Enterprise); 30 days with Observability Plus [^2] | your retention policy, on your disk |
| Retained run data | billed at $0.50 per GB-month [^1] | your disk |
| Getting run history out | no agent-runs or workflow-runs Drains schema [^3] | it's a table — `SELECT` it |
| Dashboard | Agent Runs, hosted | included — observes *and drives* |
| One-click tool sign-in | 4 Vercel-managed connectors, plus Custom OAuth and API-key connectors you register yourself [^4] | 1,070 toolkits via Composio, a hosted third party |
| Long-term memory | no first-party store; the integration gallery's memory options are third-party SaaS [^5] | included, on the same Postgres |
| Where your data sits | Vercel's platform | inside your network |

[^1]: [Workflow Pricing and Limits](https://vercel.com/docs/workflows/pricing) — the storage-retention table, and the `Workflow Data Retained` meter at $0.50 per GB-month (not available on Hobby). Verbatim: retention is "not configurable by default," and a custom period is a support request.
[^2]: [Observability Plus → Limitations](https://vercel.com/docs/observability/observability-plus#limitations). Agent Runs is a surface inside Vercel Observability — its dashboard route is `/[team]/[project]/observability/agent-runs` per [eve → Observability](https://vercel.com/docs/eve/observability) — so this is the retention table that governs it.
[^3]: [Drains](https://vercel.com/docs/drains) ships exactly five schemas: `log`, `trace`, `analytics`, `speed_insights`, `audit_log`. None of them carry agent runs or workflow runs.
[^4]: [Vercel Connect](https://vercel.com/docs/connect). The four Vercel Managed Connectors are Slack, GitHub, Snowflake and Salesforce; Customer Managed Connectors cover Custom OAuth ("OAuth 2.0 / OIDC against any service URL you provide") and API key. eve also connects to arbitrary [MCP servers](https://eve.dev/docs). "4 managed connectors" full stop was a real understatement and is corrected here.
[^5]: `node_modules/eve/docs/patterns/multi-tenant-memory.md` opens: "You can add long-term memory from the integration gallery using the Memory filter, or build tenant-aware memory from your own application store." The gallery's memory entries — Mem0, Upstash AgentKit — are third-party hosted services, and that page states the storage implementation is "deliberately outside eve." So: no first-party store, packaged options are someone else's SaaS. Not "not included."

Off-platform the only thing that costs money is model tokens. Ollama takes even that to zero,
with a real caveat — see [Local models](#local-models). The Composio connectors are the one
part that leaves your network: Composio is hosted and holds the OAuth tokens for the accounts
you connect, and it is off unless you set `COMPOSIO_API_KEY` — see
[docs/composio-auth.mdx](docs/composio-auth.mdx).

## The dashboard

What it renders today:

- **Sessions, turns, subagent trees** with duration, tokens, cached reads, and tool counts
- **Computed cost per turn.** eve only emits `gen_ai.usage.cost` for AI-Gateway calls, and a
  self-hosted agent calls its provider directly — so we price token counts ourselves. Models
  with no configured price are labelled `unpriced`, never silently counted as free.
- **Control**: start sessions, stream replies, resolve pending approvals, cancel runs
- **Integrations**: connect Gmail, GitHub, Slack, Notion and ~1,000 more in one browser flow

This section used to open "Everything Agent Runs shows you, plus the ability to act on it."
That is not true and is checkable in a minute against
[Vercel's own list](https://vercel.com/docs/eve/observability): Agent Runs renders per-turn
**Input and Output**, the model's **Reasoning**, and **Tool Calls with their arguments and
results**, plus step timings that include skill loads. evestack's dashboard **ingests** the
spans carrying prompts and tool payloads over OTLP and stores them — `lib/traces.ts` exposes
`listModelCalls()` and `listToolCalls()` — but **no page renders them yet**, and reasoning is
not captured at all. The honest line is that evestack wins on control, retention and data
ownership, and is behind on payload inspection.

It reads eve's own tables. eve tags every run with framework-owned `$eve.*` attributes, and
`@workflow/world-postgres` persists them to `workflow.workflow_runs.attributes` as JSONB —
the very data behind Agent Runs, sitting in your database. So the core view is a SQL query
with no ingest pipeline to keep in sync. OpenTelemetry is the second tier, and today it is
storage rather than a view.

## Use one piece, not the whole thing

evestack ships as an [eve registry](https://eve.dev/docs), so an existing eve project can take
a single part without migrating anything:

```bash
eve registry add @evestack=https://raw.githubusercontent.com/SammyTourani/evestack/main/registry/r/{name}.json
eve add @evestack/memory
```

The registry is served straight off `main` on GitHub rather than a branded domain — evestack
owns no domain, and a URL nobody can resolve is worse than an ugly one. See
[docs/registry.mdx](docs/registry.mdx#where-the-registry-is-hosted) before changing it.

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

## Local models

`EVESTACK_PROVIDER=ollama` runs the whole stack on your own machine for literally nothing. Two
things are required to make it work at all, and both are set for you:

- **`modelContextWindowTokens` must be declared.** eve sizes compaction from the AI Gateway's
  model catalog, and a local model is not in it. Without an explicit value the agent refuses to
  compile: *"Cannot compile agent compaction because the primary compaction trigger model
  `ollama/qwen3` does not have known AI Gateway context window metadata."*
- **`OLLAMA_BASE_URL` takes the bare host, no `/api`.** `ai-sdk-ollama` appends the path itself;
  include it and every call returns `OllamaError: 404 page not found`.

**Check your RAM before you turn this on.** On an 8 GB Apple Silicon laptop already running
Docker, Postgres, the dashboard and the agent, loading qwen3 (5.2 GB) took **over three minutes
to answer "say ok"**, a 1.3 GB model timed out on the same prompt, and the machine eventually
became unusable and shut down. eve hands the model a large harness prompt and a dozen-plus
tools, so local inference here is not a light request.

Budget roughly **model size + 4 GB** free before starting, and prefer a machine with a
dedicated GPU. evestack never selects a local model on its own for this reason — you have to
set `EVESTACK_PROVIDER=ollama` explicitly. On a laptop already running the rest of this stack,
a hosted provider is the practical choice.

## Requirements

- Node 24+
- Docker (Postgres and the agent sandbox)
- A model API key — or [Ollama](https://ollama.com) for a genuinely $0 stack

## Repository layout

```
templates/default/             the agent: Postgres durability, Docker sandbox, memory
packages/dashboard/            Next.js observability + control plane
packages/create-evestack/      the one-command scaffolder            -> npm: create-evestack
packages/evestack-composio/    Composio wiring for one-click tool auth -> npm: @evestack/composio
packages/sandbox-opensandbox/  OpenSandbox sandbox backend            -> npm: @evestack/sandbox-opensandbox
packages/website/              the landing page
registry/                      the @evestack eve registry
```

The dashboard, the website and the agent template are not published to npm — the dashboard runs
from this repository, and the template ships *inside* `create-evestack`. Release order for the
three that are published is in [RELEASING.md](./RELEASING.md).

## Notes from building this

Things that cost real time, written down so they don't cost you any:

- **Pin `@workflow/world-postgres` to `@beta`.** npm `latest` is 4.3.3; eve 0.29.x needs the
  5.0.0-beta line and the runtime rejects mismatched protocol versions.
- **Your reverse proxy must forward both `/eve/` and `/.well-known/workflow/`**, unrewritten.
  Forward only `/eve/` and sessions start, then stall when callbacks can't get back.
- **`placeholderAuth()` and `vercelOidc()` are both wrong off Vercel.** eve fails closed, so
  swap in `httpBasic` or you'll 401 everything that isn't loopback.
- **In self-hosted production, loopback gets a 401 too — that is correct.** From eve 0.30,
  `localDev()` grants only inside an `eve dev` / `vercel dev` process, so a built server
  (`eve build && eve start`) grants nothing implicitly and every request, including
  `127.0.0.1`, needs the Basic credentials. Measured: all hosts 401, correct credentials 200.
  On 0.29.x this was the reverse *and exploitable* — `localDev()` matched an unanchored
  `/^127\./` against the attacker-controlled `Host` header, so `127.evil.com` obtained an
  unauthenticated principal. We found and patched that; Vercel fixed it upstream in 0.30.0.
  Pin eve `^0.30.2` or newer.
- **Adding `agent/instrumentation.ts` disables eve's zero-config trace spool**, so `eve traces`
  stops working. The dashboard supersedes it; delete the file to get it back.
- **Cancellation is cooperative.** `POST /eve/v1/session/:id/cancel` returns 202 immediately,
  but the in-flight model call keeps streaming — we measured ~90s — and `turn.cancelled`
  arrives *after* a `session.waiting`. Don't build a stop button that assumes silence.
- **Approvals have no dedicated endpoint.** They resolve through the ordinary follow-up route
  with `inputResponses: [{requestId, optionId}]`, the same protocol as `ask_question`.
- **Next.js 16 needs TypeScript 6**; TS 7 doesn't expose the compiler API it wants.
- **A failed turn still records `status = 'completed'`.** eve's event stream emits
  `turn.failed`, but the workflow row disagrees — the workflow handled the error, so nothing
  failed as far as it knows. Trusting `status` alone paints a green badge on a turn that
  produced nothing. `$eve.model` is only written once a model call reports usage, so its
  absence on a finished turn is the surviving evidence.
- **Watch your provider's daily request cap.** An OpenAI account with no payment method
  allows 50 requests per day; a day of building against it will exhaust that long before you
  expect, and the failure arrives as an opaque `MODEL_CALL_FAILED`.

## License

Apache-2.0, same as eve. eve is a trademark of Vercel; evestack is an independent project and
is not affiliated with or endorsed by Vercel.
