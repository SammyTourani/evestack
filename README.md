<div align="center">

# evestack

### The whole eve stack. On your own machine.

A self-hosted distribution of [eve](https://github.com/vercel/eve), Vercel's agent framework.
Durable Postgres sessions, a Docker sandbox, long-term memory, and a dashboard that watches the
agent **and drives it**.

[![CI](https://github.com/SammyTourani/evestack/actions/workflows/ci.yml/badge.svg)](https://github.com/SammyTourani/evestack/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/evestack?color=2563eb&label=evestack)](https://www.npmjs.com/package/evestack)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)

**[See it running →](https://evestack.vercel.app)** · **[Docs →](https://evestack.vercel.app/docs)** · **[Changelog →](./CHANGELOG.md)**

</div>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/dashboard-dark.webp">
  <img alt="The evestack dashboard's Sessions page: a banner reading '8 sessions wedged — a turn started and never finished, nothing in eve will notice or retry it', above a searchable table of 250 real agent runs with outcome, trigger, model, provider, environment and turn count across openai, anthropic, ollama and acme providers, two rows marked failed in red among the rest." src=".github/dashboard-light.webp">
</picture>

## Quickstart

```bash
npx evestack create my-agent
```

Four questions — where, which model, tools, and whether to bring it up — all asked before any
work starts. Answering yes to the last one starts Postgres, creates the schema, pulls the
dashboard and then offers to start the agent, so there is nothing left to paste. It finishes by
drawing the four parts with the ports **your** machine actually had free.

In another terminal:

```bash
npx evestack status                        # is it up? and if not, what to run
npx evestack tour                          # a guided first run: one message, followed
                                           # through the terminal, Postgres and the dashboard
```

`npx evestack verify` is the thorough version — every part, with the command that fixes anything
broken. All three work from anywhere inside the project.

`npx` because nothing has installed the command yet: scaffolding runs it once and leaves nothing
on your PATH. `npm i -g evestack` drops the `npx ` from every line above, and is worth it if you
run more than one of these.

The scaffolder generates your credentials and prints them once; `evestack open` prints them
again and opens the dashboard. Every route is behind that credential — the dashboard starts runs
and approves shell commands, so it fails closed.

The last line is a **pull**, not a build: `ghcr.io/sammytourani/evestack-dashboard` is published
for `linux/amd64` and `linux/arm64`.

Already have an eve project? `npx evestack attach .` adds evestack to it without overwriting
anything, and prints an undo line for everything it writes.

## What you get

| | | |
| --- | --- | --- |
| **Sessions** | Every run on your machine — turns, subagent trees, tokens, cached reads, tool counts | [docs](docs/dashboard.mdx) |
| **Cost** | Priced per turn from token counts. A model with no configured price shows `unpriced`, never a silent $0.00 | [docs](docs/architecture.mdx) |
| **Monitors** | p50/p75/p95/p99 turn latency, failure rates, throughput — computed in Postgres over a rolling window | [docs](docs/dashboard.mdx) |
| **Traces** | OpenTelemetry spans per session: model calls, tool calls, arguments and results | [docs](docs/observability.mdx) |
| **Control** | Start a session, stream the reply, send a follow-up, cancel a run — from the browser | [docs](docs/dashboard.mdx) |
| **Approvals** | Gated tool calls park the session and wait for a human, with an audit log of who decided what | [docs](docs/dashboard.mdx) |
| **Memory** | Semantic recall on the Postgres you already run, via pgvector. No vector service. Needs an embeddings provider — OpenAI, or Ollama locally; Anthropic has none | [docs](docs/memory.mdx) |
| **Schedules** | Durable cron with a history of every fire, and a pause switch that needs no redeploy | [docs](docs/proactive.mdx) |
| **Evals** | Promote any real session — especially one that went wrong — into an `evals/*.eval.ts` | [docs](docs/dashboard.mdx) |
| **Integrations** | One-click OAuth into 1,070 toolkits via Composio | [docs](docs/composio-auth.mdx) |
| **Skills** | Inspect what the agent has loaded, and scan skills before it does | [docs](docs/dashboard.mdx) |
| **`evestack doctor`** | Read-only forensics for a durable job that is stuck. Prints the SQL; never writes | [docs](docs/cli.mdx) |

## Why self-host

|  | Managed | evestack |
| --- | --- | --- |
| Runs on | Vercel | your machine, VPS or cluster |
| Session state | Vercel Workflows | your Postgres |
| Run history | purged after 1–30 days depending on plan, then billed at $0.50/GB-month ([pricing](https://vercel.com/docs/workflows/pricing)) | a table you `SELECT` |
| Observability | 12 hours to 30 days depending on plan ([limits](https://vercel.com/docs/observability/observability-plus#limitations)) | your disk, your retention |
| Dashboard | Agent Runs — read-only | included, and it drives the agent |
| Memory | no first-party store | included, same Postgres |
| Your data | Vercel's platform | inside your network |

Off-platform the only thing that costs money is model tokens, and [Ollama](#local-models) takes
that to zero. One exception: Composio is a hosted third party and holds the OAuth tokens for
accounts you connect. It's off unless you set `COMPOSIO_API_KEY` — see
[docs/composio-auth.mdx](docs/composio-auth.mdx).

## Take one piece instead

evestack ships as an eve registry, so an existing project can take a single part:

```bash
eve registry add @evestack=https://raw.githubusercontent.com/SammyTourani/evestack/main/registry/r/{name}.json
eve add @evestack/memory
```

Seven items: `memory`, `instrumentation`, `docker-sandbox`, `basic-auth`, and Slack, Telegram
and Discord channels. See [docs/registry.mdx](docs/registry.mdx).

## Local models

`EVESTACK_PROVIDER=ollama` runs the whole stack for nothing. Three things matter, and only two of
them are set for you: `modelContextWindowTokens` must be declared (eve sizes compaction from the
AI Gateway catalog, and a local model isn't in it), and `OLLAMA_BASE_URL` takes the bare host with
no `/api`. The third is yours: **the embedding model is a second pull.** `ollama pull
nomic-embed-text` (274 MB) is what makes `remember` and `recall` work — a chat model is not an
embedding model — and everything else runs without it. `npm run verify` checks for it by name.

**Check your RAM first.** On an 8 GB laptop already running Docker, Postgres, the dashboard and
the agent, loading qwen3 took over three minutes to answer "say ok" and the machine eventually
shut down. Budget **both model sizes + 4 GB** free — a `remember` call needs the chat model and
the 274 MB embedding model, not one of them. evestack never picks a local model on its own — you
have to ask for it.

## Requirements, and what is actually tested

Node 24, Docker, and a model API key (or Ollama).

"Node 24" is not a floor with a tested range above it — 24 is the only major CI installs, and
all seven published packages declare `"engines": { "node": ">=24" }`, as do the root manifest
and the template a scaffold gets. The rest, stated plainly because the code contains platform
branches that might suggest otherwise:

| | |
| --- | --- |
| **Linux x86-64** | Tested. Every job in `.github/workflows/ci.yml` runs on `ubuntu-latest` |
| **Linux arm64** | The dashboard image is built and published for it; the CLI and template are not tested there |
| **macOS** | Untested by CI — no workflow runs a macOS runner |
| **Windows** | **Untested.** Nine `process.platform === "win32"` branches ship and none is exercised anywhere. Use WSL2 |
| **Postgres** | `pgvector/pgvector:pg17`, which is what both compose files run and what CI starts |

[docs/support.mdx](docs/support.mdx) has the rest of the support statement — which versions get
fixes (the newest, and only the newest), what a `0.x` bump promises, and where each of the nine
Windows branches is. [docs/upgrading.mdx](docs/upgrading.mdx) is how you move an existing
project forward: new dashboard image, new template, new eve pin.

## Repository layout

```
templates/default/             the agent that gets scaffolded
packages/evestack-cli/         the `evestack` command          -> npm: evestack
packages/create-evestack/      the scaffolder both names run   -> npm: create-evestack
packages/dashboard/            Next.js control plane           -> ghcr.io/sammytourani/evestack-dashboard
packages/evestack-budget/      dollar spend caps               -> npm: @evestack/budget
packages/evestack-schedules/   durable cron with history       -> npm: @evestack/schedules
packages/evestack-composio/    one-click tool auth             -> npm: @evestack/composio
packages/evestack-mcp/         the dashboard as MCP tools      -> npm: @evestack/mcp
packages/sandbox-opensandbox/  OpenSandbox sandbox backend     -> npm: @evestack/sandbox-opensandbox
packages/website/              the landing page and docs
contract/                      the suite that pins eve's behaviour
registry/                      the @evestack eve registry
```

`evestack create` and `npx create-evestack` run the same code, so a bug is fixed once. The
dashboard ships as a container rather than an npm package. Release order is in
[RELEASING.md](./RELEASING.md), and what actually changed in each of those releases is in
[CHANGELOG.md](./CHANGELOG.md) — grouped by package rather than by date, because the seven npm
packages and the one container image above are versioned independently.

## Things that cost us time

Written down so they don't cost you any.

- **Pin `@workflow/world-postgres` to `@beta`.** npm `latest` is 4.3.3; eve needs the 5.0.0-beta
  line and the runtime rejects a protocol mismatch.
- **Forward both `/eve/` and `/.well-known/workflow/`** through your proxy, unrewritten. Forward
  only the first and sessions start, then stall when callbacks can't get back.
- **In production, loopback gets a 401 too — that's correct.** From eve 0.30 `localDev()` grants
  only inside `eve dev`, so a built server needs Basic credentials from every host. On 0.29.x it
  was the reverse *and exploitable*: `localDev()` matched an unanchored `/^127\./` against the
  attacker-controlled `Host` header, so `127.evil.com` got an unauthenticated principal. We
  found and patched it; Vercel fixed it upstream in 0.30.0. Pin `^0.30.2` or newer.
- **Adding `agent/instrumentation.ts` disables eve's zero-config trace spool**, so `eve traces`
  stops working. The dashboard replaces it; delete the file to get it back.
- **Cancellation is cooperative.** The cancel route returns 202 immediately but the in-flight
  model call keeps streaming — we measured ~90 seconds. Don't build a stop button that assumes
  silence.
- **A failed turn still records `status = 'completed'`.** The stream emits `turn.failed`; the
  workflow row disagrees, because the workflow handled the error. `$eve.model` is only written
  once a model call reports usage, so its absence on a finished turn is the surviving evidence.
- **Watch your provider's daily cap.** An OpenAI account with no payment method allows 50
  requests per day, and the failure arrives as an opaque `MODEL_CALL_FAILED`.

We also found [vercel/eve#1658](https://github.com/vercel/eve/issues/1658) — denying a tool
approval permanently fails the durable session (p1, open).

## License

Apache-2.0, same as eve. See [NOTICE](./NOTICE).

eve is a trademark of Vercel. evestack is an independent project, not affiliated with or
endorsed by Vercel.
