# create-evestack

**One command to a self-hosted [eve](https://github.com/vercel/eve) agent: durable Postgres
sessions, a Docker sandbox, long-term memory, and a dashboard you can actually drive.
No Vercel account. $0 infrastructure.**

```bash
npx create-evestack my-agent
cd my-agent
docker compose up -d postgres              # durable sessions
npm run db:bootstrap                       # create the workflow schema
docker compose --profile dashboard up -d   # the dashboard, usually on :4000
npm run dev                                # the agent — holds this terminal
```

That is the whole setup. The order matters: `npm run dev` is a foreground process that holds
the terminal until you Ctrl-C it, so it goes last — which is also the order the scaffolder
prints when it leaves the stack for you to start. The dashboard port is whichever one was free
when you scaffolded, 4000 unless something already had it; `.env.local` and `docker-compose.yml`
carry the real number, and `npx evestack open` prints it.

The scaffolder asks for a model provider and (optionally) a Composio key, writes a `.env.local`
with a freshly generated auth password, and installs dependencies. Pass `--yes` to skip the
prompts and fill in `.env.local` yourself.

The only thing that costs money is model tokens.

## Two names, one scaffolder

`npx evestack create my-agent` runs this exact code. [`evestack`](https://www.npmjs.com/package/evestack)
is the single command, and it answers to seven verbs — `create`, `status`, `tour`, `open`,
`verify`, `attach`, `doctor` — of which `create` and `attach` are routed straight into this
package's own modules. `create-evestack` is the name npm's `create-*` convention leads people
to, and it keeps working. Same prompts, same flags, one place a bug gets fixed.

This package is dependency-free on purpose, which is why the implementation lives here rather
than the other way round: `evestack doctor` needs a Postgres driver, and nobody should download
one to scaffold a project.

## What you get

A project containing:

| | |
| --- | --- |
| `agent/` | the eve agent — instructions, tools, channels, sandbox config |
| `lib/memory.ts` | semantic long-term memory on your own Postgres via pgvector |
| `evals/` | a runnable eval suite (`npx eve eval`) |
| `docker-compose.yml` | the pgvector Postgres that stores durable sessions — safe to commit, because the password is not in it |
| `.env.local` | generated, gitignored, with a unique `EVESTACK_AUTH_PASSWORD` |
| `.env` | generated, gitignored, holding `EVESTACK_DB_PASSWORD` — the one variable `docker-compose.yml` interpolates. Compose reads `.env` and never `.env.local`, which is the whole reason there are two files. Rotate it in both together: Postgres only applies a new password when the data volume is first created |

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
- A model API key, or [Ollama](https://ollama.com) for a genuinely $0 stack. Check your free RAM
  before choosing Ollama: budget roughly *model size + 4 GB*.

## Model providers

The scaffolder asks which one you want and writes both variables to `.env.local`.
`EVESTACK_PROVIDER` is the one `agent/agent.ts` branches on — a model name written without it
goes to whichever provider was already selected, so change them together:

| `EVESTACK_PROVIDER` | Key | Default `EVESTACK_MODEL` |
| --- | --- | --- |
| unset, or `openai` | `OPENAI_API_KEY` | `gpt-5-mini` |
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-5` |
| `ollama` | none | `qwen3` |

## The dashboard

The agent is only half of evestack. The other half is an open replacement for Vercel's Agent
Runs — sessions, turns, subagent trees, computed cost per turn, plus the ability to start
sessions, stream replies and resolve approvals.

It is already in the `docker-compose.yml` this scaffolder writes, behind a profile so a plain
`docker compose up -d` does not pull ~400 MB on someone who only asked for a database:

```bash
docker compose --profile dashboard up -d
```

Nothing to clone and nothing to build: the service pulls
`ghcr.io/sammytourani/evestack-dashboard`, reads the same `.env.local` your agent reads, and
reaches the same Postgres. Sign in with the `EVESTACK_AUTH_USER` / `EVESTACK_AUTH_PASSWORD` the
scaffolder generated — it prints them when it finishes.

Set `EVESTACK_DASHBOARD_IMAGE` to run an image of your own instead.

## Documentation

Full docs, architecture notes and troubleshooting live in the
[evestack repository](https://github.com/SammyTourani/evestack).

## License

Apache-2.0, same as eve. eve is a trademark of Vercel; evestack is an independent project and
is not affiliated with or endorsed by Vercel.
