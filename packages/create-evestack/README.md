# create-evestack

**One command to a self-hosted [eve](https://github.com/vercel/eve) agent: durable Postgres
sessions, a Docker sandbox, long-term memory, and a dashboard you can actually drive.
No Vercel account. $0 infrastructure.**

```bash
npx create-evestack my-agent
cd my-agent
docker compose up -d postgres
npm run db:bootstrap
npm run dev
```

That is the whole setup. The scaffolder asks for a model provider and (optionally) a Composio
key, writes a `.env.local` with a freshly generated auth password, and installs dependencies.
Pass `--yes` to skip the prompts and fill in `.env.local` yourself.

The only thing that costs money is model tokens.

## What you get

A project containing:

| | |
| --- | --- |
| `agent/` | the eve agent — instructions, tools, channels, sandbox config |
| `lib/memory.ts` | semantic long-term memory on your own Postgres via pgvector |
| `evals/` | a runnable eval suite (`npx eve eval`) |
| `docker-compose.yml` | the pgvector Postgres that stores durable sessions |
| `.env.local` | generated, gitignored, with a unique `EVESTACK_AUTH_PASSWORD` |

and, wired up for you:

- **Durable sessions on your Postgres** via `@workflow/world-postgres` — restarting the process
  loses nothing, because the state never lived in the process.
- **A local Docker sandbox** instead of hosted Vercel Sandbox.
- **HTTP Basic route auth**, because eve's stock `vercelOidc()` / `placeholderAuth()` are both
  wrong off Vercel and fail closed.
- **One-click sign-in to 1,000+ tools** through Composio, if you supply a key. Skipped cleanly
  if you don't.
- **Trace export** to the evestack dashboard, if `EVESTACK_DASHBOARD_URL` is set.

## Requirements

- Node 24+
- Docker, running — Postgres and the agent sandbox both need it
- A model API key (OpenAI or Anthropic), or [Ollama](https://ollama.com) for a genuinely $0
  stack. Check your free RAM before choosing Ollama: budget roughly *model size + 4 GB*.

## The dashboard

The agent is only half of evestack. The other half is an open replacement for Vercel's Agent
Runs — sessions, turns, subagent trees, computed cost per turn, plus the ability to start
sessions, stream replies and resolve approvals. It lives in the
[evestack repository](https://github.com/SammyTourani/evestack), not in this package:

```bash
git clone https://github.com/SammyTourani/evestack
cd evestack/packages/dashboard
pnpm install && pnpm run dev     # http://localhost:4000
```

Point it at the same `WORKFLOW_POSTGRES_URL` your agent uses.

## Documentation

Full docs, architecture notes and troubleshooting live in the
[evestack repository](https://github.com/SammyTourani/evestack).

## License

Apache-2.0, same as eve. eve is a trademark of Vercel; evestack is an independent project and
is not affiliated with or endorsed by Vercel.
