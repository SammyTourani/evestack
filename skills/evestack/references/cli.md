# The `evestack` CLI

One command, eight verbs. `-h`/`--help` and `-V`/`--version` work anywhere, and **asking for
help never writes, starts or opens anything.**

```
evestack create [name]     scaffold an agent, a database and a dashboard
evestack status            is it up? what do I run?
evestack tour              a guided first run, on a stack that is already up
evestack open              the dashboard URL and its password, in a browser
evestack verify            check every part and name the fix for anything broken
evestack skills            teach your coding agent this project
evestack attach [dir]      add evestack to an eve project you already have
evestack doctor            a run stopped moving — read-only forensics
```

A bare `evestack` inside a project runs `status`. Outside one it prints the command list and
exits `0` — typing the program's name is not an error. An unrecognised command gets one
suggestion when there is a close match (`evestack verfiy` → *Did you mean `evestack verify`?*)
and never a guess when there is not.

## Picking the right diagnostic

The three checking commands answer genuinely different questions. Choosing wrong wastes a
round trip:

| | Question it answers | Cost |
| --- | --- | --- |
| `status` | Is it running right now, and where? | four parallel probes, read-only |
| `verify` | Is it *configured* correctly, part by part? | talks to Docker, Postgres and the ingest route |
| `doctor` | Everything is up and a run still will not move — why? | reads Postgres, writes nothing |

## `evestack create` / `npx create-evestack`

```bash
npx evestack create [name] [--yes] [--verbose]
```

| Flag | Effect |
| --- | --- |
| `[name]` | Project directory. Prompted for if omitted, interactively. |
| `--yes` / `-y` | Skip prompts, use defaults. Also triggered automatically when stdin is not a TTY (CI, a piped script), where it additionally declines to start containers — nobody is there to say no to a 200 MB pull. |
| `--verbose` | Raw `npm` and `docker` output instead of one progress row each. |

Four questions, all asked **before** any work starts, so the install and image pull are a wait
the user can walk away from: where, which model provider, whether to enable Composio, and
whether to bring the stack up.

What it generates:

- the agent project from `templates/default`
- `.env.local` with a **uniquely generated** `EVESTACK_AUTH_PASSWORD` — never a shipped default
- `.env` with the database password, the only file Compose interpolates from
- `.gitignore` covering `.env*`
- `docker-compose.yml` for Postgres, with the dashboard behind a profile

**Exit codes:** `0` only when the project was created *and* its dependencies installed. If
`npm install` fails, or `node_modules/eve` is missing afterwards, it exits `1` and prints what
to run — so an `&&` chain stops there rather than walking into an empty `node_modules`. If the
user accepts the offer to start the agent, the exit code becomes the agent's.

The scaffolder has **zero dependencies** — Node's built-in `readline`, `crypto` and `fs` only.

## `evestack status`

```bash
evestack status [--json]
```

Four parts: agent, Postgres and dashboard probed in parallel, plus the model configuration read
from `.env.local` rather than called — a status command that spends money is one people stop
typing. The fix for anything down is printed under it.

The Postgres connection is pinned `default_transaction_read_only = on` by the same helper
`doctor` uses, so it is safe to point at production. It reports two things beyond reachability:
whether the workflow schema was ever created (forgetting `db:bootstrap` is a distinct state with
a distinct fix, not a red tick), and how many runs and memories are in it.

When Postgres *and* the dashboard are both unreachable it checks Docker before printing two
compose commands that would fail, and says that instead.

| Code | Meaning |
| --- | --- |
| `0` | Everything this project needs is answering. |
| `1` | Something is down, and it printed what to run. |
| `2` | Not an evestack project. |

## `evestack tour`

```bash
evestack tour [--yes] [--message=TEXT] [--no-open]
```

A guided first run on a stack that is already up. It sends **one real message** to the agent,
streams the reply, then links that same turn in the dashboard.

That one message is a real model call and costs real money — a fraction of a cent on
`gpt-5-mini`. Nothing else in the tour calls a model, and it says so before sending.

**With no terminal to ask, it refuses and exits `3`.** Under a pipe, in CI, or with stdin
closed, the confirmation has nobody to answer it, so the tour stops rather than treating
silence as consent. `--yes` accepts the charge up front.

## `evestack verify`

Checks every part in order and names the fix for whatever is broken. This is the command to
reach for when a user says "it isn't working" without more detail — it turns a vague report into
a specific failing check.

The checks: config, docker, postgres, schema, pgvector, model, memory, agent, dashboard,
traces. The memory check only appears on providers that can embed.

## `evestack doctor`

```bash
evestack doctor [options]
```

Read-only forensics for a durable job that stopped moving. It never writes to the database;
when there is something to fix it prints the SQL and lets a human decide. Safe against
production.

| Flag | Default |
| --- | --- |
| `--schema=NAME` | `graphile_worker` |
| `--workflow=NAME` | `workflow` |
| `--url=URL` | `$WORKFLOW_POSTGRES_URL`, then `$DATABASE_URL` |
| `--agent-url=URL` | `$EVESTACK_AGENT_URL`, then `http://127.0.0.1:2000` |
| `--limit=N` | `50` rows per section; counts are never capped |
| `--probes=N` | `25` sessions probed, `0` to skip |
| `--idle=MINUTES` | `30` before a quiet session is worth probing |
| `--timeout=MS` | `15000`, for both `statement_timeout` and HTTP |
| `--sql` | print only the remediation SQL |
| `--json` | the whole diagnosis as JSON |
| `--verbose` | add the raw rows behind each finding |

| Code | Meaning |
| --- | --- |
| `0` | Looked, found nothing costing a run right now. |
| `1` | At least one fault — a stranded run, a wedged job, a wedged session. |
| `2` | Could not look (no database, wrong schema, bad arguments). |

## `evestack skills`

```bash
evestack skills [--dir=PATH] [--print] [--force] [--json]
```

Installs this pack — the one you are reading — into the user's own agent, so it persists instead
of living in one conversation. Suggest it once you have been pasted somewhere durable is useful.

| Flag | Effect |
| --- | --- |
| `--dir=PATH` | Where to write it. Default: `agent/skills/evestack` inside an eve project, otherwise `.claude/skills/evestack`. |
| `--print` | Write to stdout, touch no files. |
| `--force` | Overwrite existing files. Without it, one existing file stops the run and nothing is written. |
| `--json` | Report what was written, as JSON. |

The default target is chosen, not guessed: inside a scaffolded project `agent/skills` is a real
runtime location that eve scans, so the pack becomes loadable by the agent being *built*.

It fetches the pack from the site rather than carrying a bundled copy, so it cannot go stale —
which means it needs a network connection. Exit `1` names the URL if it cannot reach it.

## `evestack attach`

Adds evestack to an eve project that already exists, rather than scaffolding a new one. Use it
when the user has a working eve app and wants the durable store, sandbox and dashboard around
it.

## Project scripts

Inside a scaffolded project these are npm scripts, not CLI verbs:

```bash
npm run db:bootstrap    # create the workflow schema — required once, before first dev
npm run dev             # eve dev on EVESTACK_AGENT_PORT
npm run verify          # same checker as `evestack verify`
```
