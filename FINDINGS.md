# evestack — verified ground truth

Everything here was verified by running it locally on 2026-08-04, not read off a website.

## Confirmed: eve runs fully self-hosted, $0

- `eve@0.29.5`, Apache-2.0. Only hard peer dep is `ai` (AI SDK).
- `npx eve init` scaffolds; `eve dev --no-ui` boots a server on **port 2000** (not 3000).
- `GET /eve/v1/health` → `{"ok":true,"status":"ready","workflowId":"workflow//eve//workflowEntry"}`
- `POST /eve/v1/session` → `202 Accepted` + `x-eve-session-id` header + `continuationToken`.
- Vercel-only CLI commands are just `link` and `deploy`. Everything else is local.

## Confirmed: durability without Vercel

Default local Workflow world writes an event log to `.eve/.workflow-data/`:

```
runs/<runId>.json          # one per run
events/<runId>-<evtId>.json
steps/<runId>-<stepId>.json
hooks/ .locks/ version.txt
```

Event types observed: `run_created`, `run_started`, `run_completed`, `run_cancelled`,
`step_created`, `step_started`, `step_completed`, `hook_created`, `hook_received`,
`hook_disposed`, `wait_created`. One user message produced **3 runs** (session + turn + subrun).

Docs: "Mount that directory on persistent storage so runs survive process and container
replacement." So durability works with a volume mount alone — Postgres is the upgrade, not
the requirement.

### ⚠️ Version pin gotcha

`agent.ts` selects a world via `experimental.workflow.world`. The runtime **rejects
incompatible protocol versions**; eve 0.29.5 requires the `@workflow/*` **5.0.0-beta** line.

- `@workflow/world-postgres` → npm `latest` is **4.3.3** (WRONG, would be rejected)
- must pin **`@workflow/world-postgres@beta`** → currently `5.0.0-beta.31`
- runtime reported `workflowCoreVersion: 5.0.0-beta.38`

## Confirmed: the dashboard is buildable from documented data

Two framework-owned sources, neither requiring Vercel.

### 1. `.eve/traces/v1/` — zero-config OTLP/JSON spool

Written automatically by `eve dev` when no `instrumentation.ts` exists. Immutable, survives
exit. `eve traces ls` lists them. Verified span tree:

```
agent.session                 (ROOT)
└── agent.turn
    ├── agent.step
    │   └── ai.streamText
    │       └── ai.streamText.doStream
    └── agent.turn.terminal
```

Verified attribute keys: `agent.session.id`, `agent.root.session.id`, `agent.turn.id`,
`agent.turn.sequence`, `agent.step.index`, `agent.step.attempt`, `agent.model.id`,
`agent.model.provider`, `agent.name`, `agent.framework.{name,version}`, `agent.session.window`,
`ai.prompt.system`, `ai.prompt.messages`, `gen_ai.{operation.name,provider.name,request.model}`.

With a real model key these also carry (per docs): `agent.usage.input_tokens` /
`agent.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`,
`gen_ai.usage.cache_creation.input_tokens`, and `ai.toolCall` spans with args + results
(capped 32 KB). Cost attrs (`gen_ai.usage.cost`) only appear for AI-Gateway-served calls —
self-hosted users hit providers directly, so **we compute cost ourselves from token counts.**

Retention is bounded: `EVE_TRACES_MAX_AGE_MS` (7d), `EVE_TRACES_MAX_TOTAL_BYTES` (512MB),
`EVE_TRACES_RETAIN_COUNT` (20). Our dashboard must ingest into its own store, not rely on
the spool as the system of record.

`EVE_TRACES_CONTENT=off` strips prompts/results — expose this as a privacy toggle.

### 2. `$eve.*` workflow run tags — literally what powers Agent Runs

Docs, verbatim: "These tags power the **Agent Runs** tab in the Vercel dashboard."
Framework-owned, emitted always, cannot be overridden by user code.

Structural: `$eve.type` (`session`|`turn`|`subagent`), `$eve.parent`, `$eve.root`,
`$eve.subagent`, `$eve.trigger` (channel kind), `$eve.title`.
Usage (per turn, cumulative, last-write-wins): `$eve.model`, `$eve.input_tokens`,
`$eve.output_tokens`, `$eve.cache_read_tokens`, `$eve.tool_count`.

**We do not need to reverse-engineer Vercel's UI.** The inputs are public and documented.

## Self-hosting requirements (from bundled `guides/deployment/self-hosting.md`)

- `eve build` → Nitro server in `.output/`; `PORT=3000 eve start --host 0.0.0.0`
- Reverse proxy MUST forward **both** `/eve/` and `/.well-known/workflow/` without rewriting.
  Only forwarding `/eve/` lets sessions start but stalls runs when callbacks can't return.
- Replace `vercelOidc()` — it is not a valid production authenticator off Vercel.
  Use httpBasic / JWT / OIDC / custom.
- Sandbox: `defaultBackend()` picks local in availability order; Docker / microsandbox /
  custom also available. Do NOT use `vercel()`.
- `eve build && eve start` starts Nitro's schedule runner (cron works self-hosted).

## PHASE 1 VERIFIED (2026-08-04) — and one discovery that reshapes Phase 2

Stack: `templates/default` + `docker-compose.yml` (pgvector/pgvector:pg17 on host port 5433).

- `@workflow/world-postgres` resolved to **5.0.0-beta.31** via the `beta` pin. The gotcha was
  real and the fix works.
- `bootstrap` created schemas `workflow`, `workflow_drizzle`, `graphile_worker`. Tables:
  `workflow_runs`, `workflow_events`, `workflow_steps`, `workflow_hooks`, `workflow_waits`,
  `workflow_stream_chunks` — mirroring the on-disk layout exactly.
- Live session wrote **3 runs / 38 events to Postgres and 0 files to disk** → Postgres world
  confirmed active, not a silent fallback.
- Docker sandbox: container `eve-sbx-ses-docker-…-<runId>-__root__` came up per session;
  verified `bash`, `uname -s` → Linux, cwd `/workspace`.
- **Restart persistence PROVEN the hard way:** killed the dev server, `docker compose stop` +
  `start` on Postgres, restarted the agent → log showed
  `[world-postgres] Re-enqueued 2 active run(s) on startup`, and a follow-up on the
  pre-restart session recalled the first message verbatim (`echo evestack-sandbox-ok &&
  uname -s`).
- Trace attrs confirmed present with a real provider: `agent.usage.input_tokens`,
  `agent.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`.

### 🔑 The `$eve.*` tags live in Postgres as queryable JSONB

`workflow.workflow_runs.attributes` holds them directly. Real row from the run above:

```json
{"$eve.root":"wrun_…","$eve.type":"turn","$eve.model":"openai/gpt-5-mini",
 "$eve.parent":"wrun_…","$eve.tool_count":"11","$eve.input_tokens":"4550",
 "$eve.output_tokens":"101","$eve.cache_read_tokens":"2176","$eve.cache_write_tokens":"0",
 "$rootRunId":"wrun_…","$parentRunId":"wrun_…"}
```

Session rows carry `{"$eve.type":"session","$eve.title":…,"$eve.trigger":"http"}`.
Also found `$eve.cache_write_tokens`, which the docs don't list.

**Consequence: the dashboard's core view is a SQL query, not an OTLP pipeline.** Session list,
run tree (`$rootRunId`/`$parentRunId`), model, token totals, and status all come from
`workflow_runs` with plain SQL. OTLP ingest drops to a *second* tier, needed only for prompt
/response bodies and tool-call arguments. Build SQL-first, add OTLP after.

### Other Phase 1 notes

- `eve dev` auto-increments its port when one is taken (2000 → 2001). Kill stale servers or
  read the port from the log; don't assume 2000.
- world-postgres warns `maxPoolSize (10) < concurrency (50)` on every boot. Tunable with
  `WORKFLOW_POSTGRES_MAX_POOL_SIZE` / `WORKFLOW_POSTGRES_WORKER_CONCURRENCY` (both set to 20
  in `.env.example`).
- `@ai-sdk/openai` emits a benign `unsupported-tool` warning for the provider `web_search`
  tool; the turn completes normally.
- gpt-5-mini answered the bash question without calling the tool. Sandbox works (verified
  directly); this is model laziness. Consider `gpt-5` in the template if tool use matters.

## Open risks

1. **Composio breach (May 2026)** — ~5,241 API keys + ~5,001 GitHub OAuth tokens exfiltrated;
   all GitHub tokens revoked. Root cause: one compromised employee Gmail OAuth token →
   magic-link interception → production secrets. Mitigation: ship Composio as an opt-in
   bonus, default OFF, with a documented path to self-owned OAuth apps.
2. **`@composio/experimental` is experimental** — 0.2.1, undocumented, API may change.
3. **OAuth friction is physics.** Frictionless requires *someone else's* OAuth app
   (their consent screen, their rate limits, their servers holding tokens). Self-owned apps
   mean per-service registration. Cannot have both; document the tradeoff honestly.
4. **eve is beta** and ships weekly — pin versions, test against upgrades.
