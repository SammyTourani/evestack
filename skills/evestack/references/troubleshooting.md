# When it will not run

Work down this list. Most reports of "it's broken" are one of the first four.

## First: run the checker

```bash
npm run verify        # or: evestack verify
```

It checks config, docker, postgres, schema, pgvector, model, memory, agent, dashboard and
traces, and names the fix for whatever failed. Turning a vague report into a named failing check
is worth more than any guess made from a description.

If the stack is up but a *run* is stuck, that is a different command:

```bash
evestack doctor       # read-only forensics; prints SQL, writes nothing
```

## `ECONNREFUSED` on bootstrap

Almost always `npx --package=@workflow/world-postgres bootstrap` instead of
`npm run db:bootstrap`. The upstream CLI reads `.env` through dotenv and never `.env.local`,
which is the only env file the scaffolder writes, so it falls back to
`postgres://world:world@localhost:5432/world`.

## `npm run dev` starts but nothing persists

The `workflow` schema was never created. Nothing creates it implicitly —
`@workflow/world-postgres` runs its migrations only from its own CLI and eve never invokes it.

```bash
docker compose up -d postgres
npm run db:bootstrap
```

`evestack status` reports this as its own state rather than a generic red tick, because the fix
is specific.

## `EADDRINUSE` on boot

`npm run dev` passes `EVESTACK_AGENT_PORT` to `eve dev` as `--port`, and **eve only scans for a
free port when no port is given at all**. So there is no auto-increment: if something grabbed
that port since scaffolding, the boot fails rather than moving.

Free the port, or change `EVESTACK_AGENT_PORT` in `.env.local` — and if you change it, change
the `EVESTACK_AGENT_URL` default in `docker-compose.yml` to match, because the scaffolder wrote
that number in at generation time.

Related: a stale server can hold a port while looking dead. Kill by port, not by name —
`pkill -f "next start"` does not match the process, which reports as `next-server`:

```bash
lsof -ti:3000 | xargs kill -9
```

## Two scaffolds fighting over one database

Every generated `docker-compose.yml` used to hardcode `name: evestack`. Compose treats `name:`
as project identity, so a second scaffold recreated the first project's `evestack-postgres-1`
and both agents shared one database. It is derived from the project directory now — but two
scaffolds still both want host port 5433, which is a loud failure by design.

**A related trap when cleaning up:** `docker ps --filter name=X` is a *substring* match, not an
exact one. It will happily match and stop a container you did not mean.

## Dashboard unhealthy, everything 503s except `/signin`

The credential did not reach the container. The compose service reads `.env.local`; both
`EVESTACK_AUTH_USER` and `EVESTACK_AUTH_PASSWORD` are required and a blank value counts as
unset.

Blank values are a recurring shape here: `process.env.X ?? DEFAULT` does **not** fall back on an
empty string. One blank line in `.env.local` was enough to set `EVESTACK_MODEL`,
`OLLAMA_BASE_URL` and `EVESTACK_CONTEXT_WINDOW` (where `Number("") === 0`) to nothing. Reads
are `?.trim() || DEFAULT` now.

## The agent dies at boot naming AI Gateway context-window metadata

`EVESTACK_PROVIDER` is missing or misspelled. A model name without the provider leaves the agent
on the previous provider — usually `openai` — which then receives a local model name. Unset
means `openai` because that is a choice; misspelled is a hard error because that is a mistake.

## `remember` / `recall` do nothing

The provider has no embeddings model. Anthropic has none at all — that path needs an
`OPENAI_API_KEY` alongside it, or `EVESTACK_EMBED_PROVIDER=ollama`. On Ollama, embeddings are a
**second pull**: `ollama pull nomic-embed-text`. The first `remember` call names the variable
that fixes it.

If `recall` returns fewer rows than requested, it is bounded by `hnsw.ef_search`, not by the
data.

## A denied tool approval kills the session

`vercel/eve#1658` — denying a tool approval permanently fails the durable session on affected
combinations. The mechanism: `output.type="execution-denied"` is unmappable by older
`@ai-sdk/openai`, which yields `output: undefined` and an OpenAI 400.

Bisected: `@ai-sdk/openai` **2.0.117 reproduces**, **4.0.30 survives**. `execution-denied` is in
`@ai-sdk/provider` 4.0.5 and absent from 2.0.3. eve declares no peer range on `@ai-sdk/openai`,
so an app on `ai@7` can still resolve v2 and hit it. The template pins `^4.0.0`; the
`wrapLanguageModel` middleware in `agent.ts` stays as a no-op on the shipped stack because older
peers are still admissible elsewhere.

## After upgrading eve

**Contracts and typecheck going green is not sufficient.** They pin route strings and module
exports, not response bodies. eve 0.31.x removed `continuationToken` from the HTTP session
bodies — it moved to the `session.waiting` stream event — and that shipped as a live break while
every static check stayed green.

Only the live seam probes catch this class:

```bash
node contract/runtime/run.mjs --require=dashboard,agent,postgres --only=seam
```

Never accept an eve bump on contracts + tsc green alone.

## A run that will not move, with everything up

```bash
evestack doctor --verbose
evestack doctor --sql        # remediation SQL only
```

One shape worth recognising, because it bricks a deployment permanently rather than failing one
run: `status`, `completed_at`, `output_cbor` and `error_cbor` are **one value in four columns**.
`WorkflowRunSchema` is a discriminated union whose pending/running branch declares all three of
the latter `undefined`, and startup parses *every* `status='running'` row before filtering —
outside the try. So a single row with `running` + `completed_at` + `output_cbor` stops the world
from starting.

Write the whole branch in one statement, or not at all. Repair SQL is in
`docs/troubleshooting.mdx`, and it needs the `::workflow.status` cast because the column is an
enum.

## Ollama took the machine down

Not a figure of speech. Loading a multi-gigabyte model alongside Docker, Postgres and the
dashboard has exhausted an 8 GB host and shut the desktop down. Budget model size plus ~4 GB
free, and use a hosted key for any end-to-end test — the local path is not needed to verify
evestack itself.
