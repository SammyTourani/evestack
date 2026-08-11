# evestack dashboard v2 — research

Everything here was verified on 2026-08-05/06 against this checkout, the deployed
landing page, the live Postgres in `my-agent-postgres-1`, the live Docker daemon,
and upstream docs. Claims that are inference, not measurement, are marked
**[inferred]**.

> **Read §11 first.** A second verification pass on 2026-08-06 overturned three
> load-bearing claims in §2, §3.5 and §6, including the span-attribution fix the whole
> plan was sequenced around. Where §11 disagrees with anything above it, §11 wins.

---

## 1. What evestack is

A self-hosted distribution of Vercel's `eve` agent framework. Not a fork —
a packaging plus the operational layer self-hosting still needs.

| Piece | Path | Ships as |
| --- | --- | --- |
| Agent template | `templates/default/` | inside `create-evestack` |
| Dashboard | `packages/dashboard/` | container image `ghcr.io/sammytourani/evestack-dashboard` |
| CLI | `packages/evestack-cli/` | npm `evestack` |
| Scaffolder | `packages/create-evestack/` | npm `create-evestack` |
| Composio wiring | `packages/evestack-composio/` | npm `@evestack/composio` |
| Budget hook | `packages/evestack-budget/` | not published (workspace) |
| Schedules | `packages/evestack-schedules/` | workspace dep of the dashboard |
| OpenSandbox backend | `packages/sandbox-opensandbox/` | npm `@evestack/sandbox-opensandbox` |
| Landing page + docs | `packages/website/` | evestack.vercel.app |
| eve registry | `registry/` | raw.githubusercontent off `main` |
| Contract suite | `contract/` | `pnpm contract` |

Repo: `github.com/SammyTourani/evestack`, public, Apache-2.0, created 2026-08-04,
0 stars, 0 issues, 2 merged PRs (dep bumps). Homepage `evestack.vercel.app`.

Runtime shape: `eve dev` on :2000 → Postgres (pgvector) on :5433 → per-session
Docker sandbox containers → dashboard on :4000 reading Postgres over SQL and
receiving OTLP over HTTP.

### The two data tiers evestack is built on

- **Tier 1 — `workflow.workflow_runs`.** eve stamps every session/turn/subagent run
  with framework-owned `$eve.*` attributes; `@workflow/world-postgres` persists them
  to a JSONB column. This is the same data behind Vercel's Agent Runs, sitting in a
  table you own. No ingest pipeline. **This is the whole reason evestack works.**
- **Tier 2 — `evestack.spans`.** OTLP spans posted by the agent's
  `agent/instrumentation.ts`. Holds prompts, tool arguments, tool results —
  everything Tier 1 cannot hold. Opt-in.

Critical upstream coupling, already discovered and documented in
`docs/observability.mdx`: **authoring `agent/instrumentation.ts` (required to export
anywhere) silently disables eve's own `agent.*` tracer.** So an exporting deployment
receives the AI-SDK vocabulary (`gen_ai.*`, `ai.settings.context.eve.*`), never the
`agent.session`/`agent.turn`/`agent.step` family. Confirmed in the live DB below:
**0 of 2,455 spans carry `agent.session.id`.**

---

## 2. The dashboard as it exists today — complete inventory

> **Corrected by §11.1.** This inventory misses `app/monitors/page.tsx` and
> `lib/monitors.ts`, which already implement p50/p75/p95/p99, error rate and a bucketed
> time series. Any statement below that the dashboard has no percentiles is false.

Nav at repo HEAD: Sessions · Traces · Monitors · Chat · Schedules · Memory · Skills ·
Approvals · Evals · Integrations.
(The currently-running image is older — no Traces, no Evals.)

### Pages

| Route | What it renders |
| --- | --- |
| `/` | 5 stat tiles + conditional fleet banner + session table (100 rows, no paging/sort/filter/search) |
| `/sessions/[id]` | header meta, 4–5 stat tiles, Promote-to-eval, Replay panel, nested run-tree cards |
| `/traces` | 6 stat tiles + traced-session table; 3 distinct empty states |
| `/traces/[id]` | 5 stat tiles, span waterfall (600-row cap), tool-call cards, model-call cards, 3 diagnostic notices |
| `/chat` | start session, stream reply, inline approve/deny, cancel |
| `/schedules` | schedule summaries, recent runs, pause switch, failing-streak alarm |
| `/memory` | list, plain-text search, delete with audit |
| `/skills` | skill inventory + static security scan + severity findings + canary self-test |
| `/approvals` | audit table: when / decision / tool / approver / proof / session |
| `/evals` | ranked promotion candidates (denial > failed > plain > empty) |
| `/evals/[id]` | generated eval preview + copy source |
| `/integrations` | Composio catalog, connected accounts, connect flow |
| `/signin` | Basic-credential form |

### API

`/api/health`, `/api/health/detail`, `/api/fleet`, `/api/budget`, `/api/approvals`,
`/api/skills`, `/api/skills/[name]`, `/api/schedules/[name]`, `/api/memories/[id]`,
`/api/evals/promote/[id]`, `/api/ingest/v1/traces`, `/api/auth/{session,signout}`,
`/api/control/sessions` + `[id]/{message,stream,cancel,approve,fork}`.

### Every metric the dashboard renders today — the exhaustive list

**Counts** — sessions, turns, subagents, spans, traces, distinct traced sessions,
model calls, tool calls, unattributed spans, memories, skills, scan findings by
severity, approvals, unidentified approvals, schedule runs, promotable/denial/failed
eval candidates.

**Tokens** — input, output, cache read (per turn, per session, global);
cache write (per turn only, and only when > 0).

**Money** — computed cost per turn / per session / global; `unpriced` label;
`Infrastructure $0.00` (a hardcoded constant, not a measurement).

**Time** — per-run duration (`completed_at − started_at`), session elapsed,
span duration, span window (first-start → last-start), relative "ago",
schedule `duration_ms`.

**Health** — fleet classification (idle / active / awaiting-human / wedged /
unknown), `noModelCall`, schedule failing streak, skill-scanner canary verdict.

**That is the complete list.** There is no rate, no percentile, no time series,
no error rate, no throughput, no TTFT, no period-over-period comparison, no
grouping, no filter, no search, no sort, no pagination, no alert, no export.

### Design system as it exists

`app/globals.css`, 207 lines, hand-rolled, no framework, no external fonts —
deliberate ("the whole point is a stack that runs with no network calls").
15 CSS variables (`--bg`, `--bg-raised`, `--bg-hover`, `--border`, `--text`,
`--text-dim`, `--text-faint`, `--accent`, `--ok`, `--warn`, `--err`, `--radius`,
`--mono`, `--sans`). Dark-first with a `prefers-color-scheme` light override and
no manual toggle. Body 14px, labels 11px — effectively a two-step type scale.
Layout is a 52px sticky topbar over a 1180px centered column.

Dependencies: `next`, `react`, `react-dom`, `pg`, `@evestack/schedules`. **Zero UI
dependencies.** No Tailwind, no chart library, no icon set, no component library.

---

## 3. The data substrate — what actually exists to plot

Measured against `my-agent-postgres-1` (33 runs, 491 events, 82 steps, 2,455 spans).

### 3.1 `workflow.workflow_runs` — 33 rows

Columns: `id, name, status, error, error_code, created_at, started_at,
completed_at, updated_at, expired_at, deployment_id, input, output,
execution_context, output_cbor, input_cbor, execution_context_cbor, error_cbor,
spec_version, encryption_public_key, attributes`.

`name` values observed: `workflow//eve//workflowEntry` (10),
`workflow//eve//turnWorkflow` (13), `workflow//eve//sessionTimeoutWorkflow` (10).
`status`: `running` 20, `completed` 13.

`attributes` keys observed live: `$eve.type`, `$eve.parent`, `$eve.root`,
`$eve.title`, `$eve.trigger`, `$eve.model`, `$eve.input_tokens`,
`$eve.output_tokens`, `$eve.cache_read_tokens`, `$eve.cache_write_tokens`,
`$eve.tool_count`, plus world-postgres's own `$parentRunId`, `$rootRunId`.

**Read by the dashboard.** Not read: `error`, `error_code`, `deployment_id`,
`expired_at`, `input`, `output`, `execution_context`.

### 3.2 `workflow.workflow_steps` — 82 rows — **completely unread**

Columns: `run_id, step_id, step_name, status, input, output, error, attempt,
started_at, completed_at, created_at, updated_at, retry_after, spec_version`.

Step names observed, all versioned by eve release:
`step//eve@0.30.8//turnStep` (15), `sendTurnControlStep` (13),
`dispatchTurnStep` (13), `resolveInitialTurnCallerStep` (10),
`createSessionStep` (10), `startSessionTimeoutStep` (10),
`notifyTurnCallerStep` (8), `settleCancelledTurnStep` (1),
`forwardTurnCancellationStep` (1), `cancelDescendantTurnsStep` (1).

This is **per-step latency and retry data with zero instrumentation cost**, and it
works whether or not OTLP export is on. It is enough to draw a real waterfall.

### 3.3 `workflow.workflow_events` — 491 rows — **completely unread**

Columns: `id, type, correlation_id, run_id, created_at, payload`.
Types: `hook_created` 82, `step_created` 82, `step_started` 82, `step_completed` 82,
`hook_disposed` 41, `run_started` 33, `run_created` 33, `hook_received` 19,
`attr_set` 14, `run_completed` 13, `wait_created` 10.

This is the event-sourced timeline. `attr_set` is *when* the `$eve.*` token counters
were written — i.e. token accrual over time, per turn.

### 3.4 `workflow.workflow_waits` / `workflow_hooks` / `workflow_stream_chunks` — unread

Waits and hooks are literally "what this session is blocked on". The fleet detector
currently answers that with one HTTP probe per session, bounded at 25.

### 3.5 `evestack.spans` — 2,455 rows / 278 traces

> **Superseded by §11.2.** Now 37,125 rows / 34,914 traces, and the conclusion below —
> that adding `workflow.run.id` to the generated column fixes attribution — is wrong.
> That key sits almost entirely on `workflow.stream.read.complete` engine noise; the
> model-call and tool-call spans carry no ids at all and must inherit from their parent.

**Attribution is broken and the number is stark:**

| Key | Spans carrying it |
| --- | --- |
| `agent.session.id` | **0** |
| `ai.settings.context.eve.session.id` | **24** |
| `workflow.run.id` | **1,760** |
| resulting `session_id` generated column | **24 (1.0%)** |

`sql/traces.sql` generates `session_id` from `COALESCE(agent.session.id,
ai.settings.context.eve.session.id)`. It never looks at `workflow.run.id`, which is
present on **72% of spans** and is a direct foreign key into
`workflow.workflow_runs.id` — from which `$eve.root`/`$eve.parent` gives the session
in one more hop. **99% of ingested telemetry is currently invisible to the UI.**

Span names, top of the distribution: `workflow.stream.flush` (1,098),
`workflow.route.get_world` (136), `workflow.route.flow` (136),
`workflow.loadEvents` (116), `workflow.run workflow//eve//workflowEntry` (109),
`fetch POST .../flow` (85), `step.hydrate/dehydrate/execute` (66 each),
`chat qwen3` (12), `invoke_agent qwen3` (12), `step 1` (12),
`fetch POST .../api/chat` (12), `execute_tool …` (2).

`invoke_agent …` and `step N` spans are matched by **no** predicate in
`lib/traces.ts` today.

**GenAI attributes verified present on real spans:**

```
gen_ai.client.operation.duration              ← operation latency, seconds
gen_ai.client.operation.time_to_first_chunk   ← TTFT, seconds
gen_ai.client.operation.time_per_output_chunk ← inter-token latency, seconds
gen_ai.execute_tool.duration                  ← tool latency, seconds
gen_ai.usage.input_tokens / output_tokens
gen_ai.request.model / provider.name / operation.name / agent.name
gen_ai.response.id / response.finish_reasons
gen_ai.system_instructions / input.messages / output.messages
gen_ai.tool.definitions / tool.name / tool.type
gen_ai.tool.call.id / call.arguments / call.result
```

eve context on the same spans: `ai.settings.context.eve.{session.id, turn.id,
turn.sequence, step.index, channel.kind, environment, version, retry.reason}`.

**The headline: TTFT and time-per-output-chunk — the two latency metrics on the
front page of every commercial LLM dashboard — are already in evestack's Postgres,
emitted by the AI SDK, and nothing reads them.** `lib/traces.ts` reads
`durationMs` and renders it as a bar width; it never touches
`gen_ai.client.operation.*`.

**Durable-execution telemetry nobody else has**, also present and unread:

```
workflow.stream.flush.buffer_dwell_ms / .chunks / .bytes   (1,098 spans)
workflow.stream.write.chunk_rtt                            (1,098)
workflow.events.count / .pages_loaded                        (375)
workflow.serialization.{codec,compressed,uncompressed_bytes,
                        stored_bytes,compression_ratio}      (321)
workflow.suspension.{state,wait_count,step_count,hook_count} (190)
workflow.arguments.count                                     (228)
messaging.{system,operation.type,destination.name,message.id}(191)
workflow.run.id / .name / .run.status
```

Event-log growth (`workflow.events.count`) is *the* scaling failure mode of durable
execution, and evestack has the number.

### 3.6 evestack's own tables

| Table | Contents | Rendered? |
| --- | --- | --- |
| `evestack.approvals` | who decided what, when, and how identity was established | yes, `/approvals` |
| `evestack.memories` | content, tags, session, `vector(N)` embedding, HNSW index | yes, `/memory` |
| `evestack.memory_deletions` | verbatim deleted content + actor + provenance | **no page** |
| `evestack.budget_steps` | per-(session,turn,step,sequence) cost ledger: model, cost, tokens, `priced` | **no page** |
| `evestack.budget_usage` | rollups per (scope, key): session and principal-day | **no page** |
| `evestack.budget_events` | why a cap tripped: scope, limit, spent, action | **no page** |
| `evestack.budget_stops` | current stop state | **no page** |
| `evestack.schedule_runs` | name, cron, fire_at, started, finished, duration_ms, status, error, caught_up, session_id | yes, `/schedules` |
| `evestack.schedule_state` | paused, paused_at, paused_by | yes |

`budget_steps` is already a clean, deduplicated, per-step cost fact table keyed on
retry-safe coordinates. It is the best cost data in the system and there is no UI
for it — only `/api/budget` returning JSON.

### 3.7 Docker — verified live, zero code exists

A live eve sandbox container was running during this audit. Its labels:

```
eve.sandbox                 = 1
eve.sandbox.role            = session
eve.sandbox.tag.agent       = warden
eve.sandbox.tag.channel     = http
eve.sandbox.tag.devRunId    = 1fe21e26-ee76-4231-a63b-e99fe12329f7
eve.sandbox.tag.sessionId   = wrun_01KZAQEH63D39ZFXF579XE1QSA   ← joins to workflow_runs.id
eve.sandbox.template-key    = eve-sbx-tpl-docker-…
org.opencontainers.image.*  = eve Sandbox, 26.04, github.com/vercel/eve
```

Plus `State.Status=running`, `State.StartedAt`, `HostConfig.NetworkMode=none`
(i.e. the template's `deny-all` policy is *verifiable at runtime*), and from
`docker stats`: CPU %, mem usage/limit, net I/O, block I/O, PIDs.

eve keeps **one long-lived container per durable session**, persists `/workspace`
across turns, and applies **no idle timeout** (`templates/default/agent/sandbox/sandbox.ts`).
So orphaned sandboxes accumulate silently and nothing anywhere shows them.

**Answer to "have we built live sandbox visibility?": no — not one line. But the
data is fully labelled, joins straight to sessions, and needs no new
instrumentation.** This is the single most defensible feature on the list: a hosted
dashboard structurally cannot show you containers on your own machine.

---

## 4. The competitive bar

### 4.1 Vercel Agent Runs — the hosted dashboard, complete surface

From `vercel.com/docs/eve/observability` (last updated 2026-06-24), verbatim scope:

**Overview**
- Runs over time, **broken down by trigger** (Slack, HTTP, …)
- Token usage over the same window, **split into input / output / cached**
- Table of runs: triggering message · trigger type · tokens in · tokens out ·
  turn count · duration · time

**Run detail** — model, trigger, deployment, then per turn:
- **Timings for each step**, including skill loads and individual tool calls
- **Input** and **Output** for the turn
- **Reasoning** the model produced
- **Tool Calls** with arguments and results
- Input / cached / output token counts

**That is the entire product.** No cost. No percentiles. No error rate. No alerts.
No search or filter documented. Read-only.

Span context eve injects when OTel is on: `eve.version`, `eve.session.id`,
`eve.environment`, `eve.turn.id`, `eve.turn.sequence`, `eve.step.index`,
`eve.channel.kind`. Trace shape: `ai.eve.turn` → `ai.streamText` →
`ai.streamText.doStream` / `ai.toolCall`.

**Scorecard vs evestack today**

| | Agent Runs | evestack |
| --- | --- | --- |
| Runs over time by trigger | ✅ | ❌ |
| Tokens over time (in/out/cached) | ✅ | ❌ (totals only) |
| Runs table | ✅ | ✅ |
| Per-step timings incl. skill loads | ✅ | ❌ |
| Turn Input/Output inline | ✅ | partial — only `/traces/[id]`, only if export is on |
| **Reasoning** | ✅ | ❌ not captured at all |
| Tool calls + args + results | ✅ | ✅ (traces page) |
| Cost | ❌ | ✅ computed, with `unpriced` honesty |
| Retention | 12h–30d by plan | unbounded |
| Control (start/cancel/approve/fork) | ❌ | ✅ |
| Approvals audit with identity | ❌ | ✅ |
| Memory / Schedules / Skills / Evals | ❌ | ✅ |

evestack already beats the hosted product on six axes. It loses on five, and three
of those (**reasoning, step timings, over-time charts**) are the ones a user notices
in the first thirty seconds.

### 4.2 Braintrust

Preset charts: **Spans, Latency, Total LLM cost, Token count, Time to first token**.
Chart types: time series (line / stacked bar), top list, big number.
Aggregators: `sum, avg, min, max, count, count distinct, percentile`, plus arbitrary
SQL aggregates (`100 * sum(errors) / count(id)`).
Filters: **trace filters** (match a trace where *any* span matches) vs **span
filters** (only matching spans) — a distinction evestack will need too.
Group-by: any SQL dimension, e.g. `metadata.model`.
Time: presets, click-drag zoom, `LIVE` auto-refresh toggle, bucket target
Auto / Week / Day / Hour, bucket on ingest time or `metrics.start`.
Units: duration (s), cost (USD), count, percent, bytes (base-1024).
Plus: Topics (auto-classification of traces into Task / Sentiment / Issues facets),
saved views, CSV/JSON export, and an in-product NL agent ("Loop").

### 4.3 Langfuse — the preset dashboard set, read from their repo

`worker/src/constants/langfuse-dashboards.json`, three preset dashboards
(Cost, Latency, Usage Management) built from these widgets:

Total costs · Cost by Model Name · Cost by Environment · Top 20 Users by Cost ·
Top 20 Use Cases (Trace) by Cost · Top 20 Use Cases (Observation) by Cost ·
P95 Cost per Trace · P95 Input Cost per Observation · P95 Output Cost per
Observation · P95 Latency by Model · P95 Latency by Use Case · P95 Latency by Level ·
Max Latency by User Id · Avg Output Tokens Per Second by Model ·
P95 Time To First Token by Model · Avg Time To First Token by Prompt Name ·
Total Trace Count (total / over time / by env) · Total Observation Count
(total / over time / by env) · Total Score Count (numeric) · Total Score Count
(categorical).

Chart types: `LINE_TIME_SERIES`, `BAR_TIME_SERIES`, `VERTICAL_BAR`,
`HORIZONTAL_BAR`, `NUMBER`, `PIE`.
Measures: `count, latency, totalCost, inputCost, outputCost, timeToFirstToken,
outputTokensPerSecond`.
Dimensions: `environment, level, name, promptName, providedModelName, userId`.
Query API v2 views: `observations`, `scores-numeric`, `scores-categorical`,
`scores-boolean`. Grouping blocked on high-cardinality fields (`id`, `traceId`,
`userId`, `sessionId`) — filterable but not groupable. Row limit 100, max 1,000.

**This is the most directly stealable artifact in the whole survey** — it is a
battle-tested default metric set and a proven query-model shape.

### 4.4 Helicone

Dashboard: Total Requests · Total Cost · Average Latency · Error Rate, then time
series for Requests / Cost / Latency / Errors. Latency p50/p95/p99, TTFT,
throughput (req/s), tokens total/prompt/completion/avg-per-request.
Alerts on: error rate, cost, latency, token metrics (total, prompt, completion,
cache read, cache write), request count — each with threshold, time window, and
`sum` or `avg` aggregation.

### 4.5 OpenTelemetry GenAI semantic conventions — the metric standard

All histograms:

```
gen_ai.client.token.usage                      {token}
gen_ai.client.operation.duration               s
gen_ai.client.operation.time_to_first_chunk    s
gen_ai.client.operation.time_per_output_chunk  s
gen_ai.server.request.duration                 s
gen_ai.server.time_to_first_token              s
gen_ai.server.time_per_output_token            s
gen_ai.execute_tool.duration                   s
gen_ai.invoke_agent.duration                   s
gen_ai.invoke_agent.inference_calls            {inference_call}
gen_ai.invoke_agent.tool_calls                 {tool_call}
gen_ai.invoke_workflow.duration                s
```

evestack should name its metrics after these. Four of them
(`client.operation.duration`, `time_to_first_chunk`, `time_per_output_chunk`,
`execute_tool.duration`) are already arriving as span attributes.

---

## 5. The landing page already ships the design we haven't built

`packages/website/components/sections/monitors-panel.tsx` (439 lines) renders a
complete **Observability / Monitors** application screen, live at
evestack.vercel.app §06:

- Left sidebar: Overview · Sessions · Chat · Integrations, then an **Observability**
  section with **Monitors** and **Traces**
- Toolbar: `Observability / Monitors` breadcrumb, **Production** environment picker,
  **Last 12 hours** range picker, `self-hosted` pill
- **Runs** chart: spike series over a 12h window, with `Error 0%` and `Timeout 0%`
  legend dots and a flat error series
- **Session duration** chart: area + line, **p50 / p75 / p95 / p99** chips, a dashed
  **p95** reference line, a peak marker, and a crosshair tooltip
- **Search sessions…** with a `/` hotkey affordance
- Sessions table: activity **sparkline** per row, tokens, duration, cost, chevron
- Pagination: `Show 10`, `1 of 1`, prev/next

**None of it exists in the product.** `packages/website/lib/copy.ts` even documents
this — it records that the fabricated screen was found, that
`grep -rniE "p95|percentile|Monitors"` over the dashboard returns nothing, and says
it "is replaced by packages/website/public/screenshots/*". The *capabilities copy*
was replaced. **The panel itself is still imported by `observability.tsx:2` and is
still on the deployed site.** The deployed page also still carries two other rows
copy.ts says were removed: the `Tool approvals | Vercel Passport` comparison row and
the "Full-depth tracing … The span tree is the product" feature cell.

Two consequences:

1. **This is a live honesty defect** in a project whose landing page opens with an
   explicit honesty contract. It should be fixed by building the screen, not by
   deleting it — but until it's built, the site is claiming a product surface that
   does not exist.
2. **It is also, already, a good design spec.** 439 lines of dependency-free SVG in
   the exact visual language the product should adopt. Porting it into the dashboard
   is a large head start, not a rewrite.

---

## 6. Verified defects found while auditing

Each of these is measured, not suspected.

1. **Span attribution: 1%.** ~~`sql/traces.sql` ignores `workflow.run.id`
   (1,760/2,455 spans).~~ **Diagnosis corrected in §11.2** — the defect is real and
   worse than stated (model and tool spans are at 0%), but the cause is that those spans
   carry no ids at all and must inherit from their parent, not that `workflow.run.id` is
   unread. Everything in the trace tier is downstream of this.
2. **Time formatting is wrong off-UTC.** `lib/db.ts` installs a UTC parser for
   `timestamp without time zone`, so `queries.ts` already returns correct instants.
   `app/sessions/[id]/page.tsx:67` and `app/evals/page.tsx:91` then re-shift with
   `d.getHours()` / `d.getDate()`, which is a **second** correction. It is masked in
   production only because the container's TZ is UTC (verified: container `date`
   prints UTC). Run `pnpm run dev` on a PDT laptop and a 04:40 UTC turn renders as
   "Aug 5 21:40". Meanwhile `/approvals`, `/schedules`, `/skills`, `/memory` use
   `toLocaleString(..., { timeZone: "UTC" })`. Three strategies, four pages.
3. **`$eve.tool_count` is tools *available*, not tools *invoked*** — documented in
   `docs/observability.mdx` — but the session page labels it `TOOLS` next to
   duration and cost, where it reads as activity. Every turn in the live instance
   shows `TOOLS 14`.
4. **The fleet banner composes an unreadable sentence.** It uses session *titles*
   as inline link text, truncated at 40 chars. Live output:
   "8 sessions wedged. … Use your bash tool to run exactly this a, ping-no-origin,
   ping and 5 more".
5. **Status is a constant.** eve leaves the session run `running` for the life of the
   session, so the Status column read `running` for 10 of 10 sessions live. The
   column carries no information and the real state lives in the fleet classifier.
6. **`getTraceStats()` is dead and wrong.** It counts `name = 'ai.toolCall'` and
   `'ai.streamText.doStream'` exactly — the *local tracer's* names, which by
   construction never reach an exporting deployment. `getTraceOverview()` supersedes
   it. Two functions, one correct.
7. **N+1 on `/traces/[id]`** — `getSpanTree`, `listModelCalls` and `listToolCalls`
   each re-run the same span query (acknowledged in a code comment).
8. **No index on `workflow_runs.attributes`.** Every page does
   `attributes->>'$eve.type' = '…'` as a sequential scan.
9. **No pagination anywhere.** `listSessions(100)` hard cap, no cursor, no total.
10. **The fleet probe costs an HTTP round trip per session**, bounded at 25 —
    while `workflow_waits` / `workflow_hooks` answer the same question in SQL.
11. **`invoke_agent …` and `step N` spans match no predicate** in `lib/traces.ts`,
    so they are ingested and never surfaced.
12. **Cache-write tokens are counted at the input rate.** `pricing.ts` records a
    `cacheWrite` price per model and `costUsd()` takes no cache-write argument, even
    though `queries.ts` already reads `$eve.cache_write_tokens`. Acknowledged in the
    file's own comment. Anthropic charges 6.25/M to write vs 5/M for input.

---

## 7. Open source worth using or reading

| Project | License | What to take |
| --- | --- | --- |
| **Langfuse** | MIT (core) | The **query model** — `{view, measures[{measure,aggregation}], dimensions, filters, timeDimension{granularity}, orderBy, limit}` — and the widget/dashboard JSON schema. Also their 20-widget preset list as our default metric set. Do **not** take the code (Next + ClickHouse + Prisma). |
| **Braintrust** (docs) | proprietary | The aggregator + unit model, and the **trace-filter vs span-filter** distinction. |
| **Helicone** | Apache-2.0 | The **alert model**: metric × threshold × window × aggregation. Simple and complete. |
| **Arize Phoenix** | ELv2 | Project/experiment framing for the Evals surface. |
| **Perses** | Apache-2.0 (CNCF) | Dashboards-as-code JSON schema, if we ever want dashboards to be files in the repo. |
| **uPlot** | MIT, ~45 KB | Only if we hit a rendering wall past ~10k points. Canvas, no React. |
| **Recharts / Tremor / visx** | MIT | Heavier, React-idiomatic. Tremor is the fastest path to a "good enough" look but pulls Tailwind. |
| **Observable Plot** | ISC | Lovely API, ~1 MB. Too heavy for a container that promises to phone nobody. |
| **shadcn/ui charts** | MIT | Read for tooltip/legend/token conventions even if not installed. |
| **Vercel Geist** | — | The website already uses Geist-derived tokens. Aligning the dashboard to them makes site and product read as one product. |

**Superseded 2026-08-06.** The original recommendation here was to hand-roll SVG and
stay dependency-free. Sammy chose dependencies, and the follow-up research in §8
supports that: Tremor is now Vercel's own component library, and the only real thing
the no-deps rule protected (no runtime network) survives intact. See §8 for the
verified stack and §10 for what actually got decided.

---

## 8. How Vercel and Datadog build dashboards, and what we can take

### 8.1 Tremor is Vercel's chart library now

Vercel **acquired Tremor on 2025-01-22**. From the announcement: the two cofounders
joined Vercel's **Design Engineering team** and are applying their experience to
"improving the Vercel Dashboard"; the previously paid Tremor Blocks became **free and
open source under MIT**; and the library feeds v0's generative UI so it can produce
"data-heavy interfaces."

So adopting Tremor is not adopting a lookalike. It is adopting the component library
maintained by the people who build Vercel's dashboard. That is the most direct
possible answer to "we want to use their UI."

### 8.2 …but do not take an npm dependency on it. Vendor the source.

Measured against the live registry on 2026-08-06:

| Artifact | Version | Published | React peer | Verdict |
| --- | --- | --- | --- | --- |
| `@tremor/react` stable | 3.18.7 | — | **`^18.0.0`** | Won't declare support for our React 19.2.8 |
| `@tremor/react` v4 | 4.0.0-beta-tremor-v4.4 | **2024-12-14** | `^19.0.0` | Abandoned at the acquisition; 19 months stale; pins Recharts **2** |
| `tremorlabs/tremor` repo | Apache-2.0, 3.5k★ | last push **2025-10-10** | — | Not archived, effectively dormant |

The v4 beta is the trap: it declares React 19 and looks like the answer, but its last
publish predates the acquisition by five weeks and nothing has shipped since.

This is also what tremor.so itself now leads with: **copy-and-paste React source
files**, the shadcn model. Vendoring gets the exact look, no peer-dependency lock, no
abandonware in the dependency tree, and full freedom to restyle to our tokens.

### 8.3 The verified stack

| Package | Version | Published | Status |
| --- | --- | --- | --- |
| `tailwindcss` | 4.3.3 | 2026-08-05 | current; `packages/website` already runs Tailwind 4 |
| `recharts` | 3.10.1 | 2026-08-05 | peer deps explicitly include React 19; Tremor's and shadcn's engine |
| `geist` | 1.7.2 | 2026-08-06 | Vercel's typeface, **self-hosted via `next/font`, zero runtime network** |
| `@tanstack/react-table` | **8.21.3** stable | — | v9 is `9.0.0-beta.65`; pin v8 |
| `cmdk` | 1.1.1 | 2026-08-05 | command palette |
| Radix primitives | current | 2026-08-05 | popover / tooltip / dialog / dropdown |
| `tailwind-variants`, `clsx`, `date-fns` | current | — | supporting |

The `geist` package resolves the one genuine tension. The dashboard's no-dependency
rule existed to keep a self-hosted install from phoning anybody
(`app/globals.css:1-3`). `next/font` inlines and self-hosts the font files at build
time, so we get Vercel's actual typeface with no runtime request. The promise holds.

### 8.4 Vercel Observability, the product

From `vercel.com/docs/observability` (updated 2026-07-06). Worth copying:

- **Drag-to-select on a chart, then a Zoom In button.** The single best interaction in
  their UI and cheap to build.
- Insight sections per data source rather than one generic explorer.
- A ranked list under every chart, **re-sortable by error rate or duration**, where
  each row drills into a detail view.
- Detail view links straight out to the logs for that thing.
- **Notebooks** for saving and organising queries.
- Error Rate as a first-class chart, not a derived stat.

One caution: Vercel **sunset the standalone Monitoring product** on Pro at the end of
the Nov 2025 billing cycle and folded it into Observability plus Notebooks. Their
current model is curated insight sections plus saved queries, not a blank dashboard
builder. That is a useful signal about where to put effort: **curated defaults beat an
empty canvas.**

### 8.5 Datadog's widget taxonomy

The complete inventory, as the reference for "as many visualisations as Datadog":

- **Graphs** — Timeseries, Bar Chart, Change, Distribution, Geomap, Heatmap, Pie Chart,
  Point Plot, Query Value, Scatter Plot, Table, Top List, Treemap, Wildcard
- **Groups** — Group, Powerpack, Split Graph
- **Cloud Cost** — Budget Summary, Cost Summary
- **Product Analytics** — Sankey, Funnel, Retention
- **Architecture** — Cloudcraft Diagram, Hostmap, Topology Map, Service Summary
- **Annotations** — Free Text, Iframe, Image, Notes and Links
- **Lists and streams** — List
- **Alerting** — Alert Graph, Alert Value, Check Status, Monitor Summary, Run Workflow
- **Performance** — Profiling Flame Graph, SLO, SLO Summary

Roughly ten of these are relevant to an agent dashboard: Timeseries, Bar Chart, Query
Value, Change, Distribution, Heatmap, Table, Top List, Alert Graph, Monitor Summary.
The rest are infrastructure or BI surface we should not chase.

Dashboard-level features worth taking: **tabs**, conditional formatting, units per
widget, custom links from a widget to a filtered view, and cloning from presets.

### 8.6 Datadog Agent Observability (their LLM product) — the real bar

Surfaces: an Agent Observability trace list of prompt-response pairs; a trace side
panel with a dedicated **Errors tab**; an out-of-the-box **Operational Insights**
dashboard covering cost, latency, performance and usage trends; an **Insights** banner
that surfaces anomalies; and **Patterns**, automated hierarchical topic clustering of
production traffic.

**Insights** is the most interesting idea: automatic outlier detection on duration and
error rate, computed across three dimensions (span name, workflow type, topic), trained
on the prior week and surfaced inside your selected window. It is anomaly detection
that requires no configuration, which is the opposite of an empty monitor builder.

Their metric catalogue, `ml_obs.*`:

```
ml_obs.span                                       Count
ml_obs.span.duration                              Distribution
ml_obs.span.error                                 Count
ml_obs.trace                                      Count
ml_obs.trace.duration                             Distribution
ml_obs.trace.error                                Count

ml_obs.span.llm.input.tokens        / .output.tokens
ml_obs.span.llm.prompt.tokens       / .completion.tokens  / .total.tokens
ml_obs.span.llm.output.reasoning.tokens
ml_obs.span.llm.input.cache_write.tokens
ml_obs.span.llm.input.cache_read.tokens
ml_obs.span.llm.input.non_cached.tokens
ml_obs.span.llm.input.characters    / .output.characters
ml_obs.span.embedding.input.tokens

ml_obs.span.llm.input.cost          / .output.cost      / .total.cost
ml_obs.span.llm.output.reasoning.cost
ml_obs.span.llm.input.cache_write.cost
ml_obs.span.llm.input.cache_read.cost
ml_obs.span.llm.input.non_cached.cost
ml_obs.span.embedding.input.cost

ml_obs.estimated_usage.llm.{input,output,total}.tokens
```

Two things to steal outright:

1. **Cost is decomposed into cache_write / cache_read / non_cached, each with its own
   rate.** That is exactly the defect found in `pricing.ts` (§6.12): evestack records a
   `cacheWrite` price per model and then bills those tokens at the plain input rate.
   Datadog's schema is the correct shape.
2. **Reasoning is a first-class token and cost dimension.** Reasoning is also the one
   Agent Runs feature evestack lacks entirely. Both point the same way.

---

## 9. Chart-library options considered

| Option | Verdict |
| --- | --- |
| **Vendored Tremor + Recharts 3** | **Chosen.** Vercel's own library, MIT/Apache-2.0, no peer-dep lock, restyleable. |
| `@tremor/react` as a dependency | Rejected. React 18 peer on stable; v4 beta abandoned 2024-12-14. |
| shadcn/ui charts | Same Recharts engine, also vendored. Worth reading for tooltip/legend conventions; take patterns, not a second component set. |
| Hand-rolled SVG | The original recommendation. Still the right call for the waterfall and sparklines, where Recharts is a poor fit. Keep `monitors-panel.tsx` as the source for those. |
| uPlot | Hold. Only if a series exceeds ~10k points. |
| Observable Plot / visx | Rejected. Too heavy or too low-level for the payoff. |

Note that hand-rolled SVG does not disappear. **The span waterfall and the row
sparklines should stay bespoke** — Recharts has no waterfall, and the existing
`monitors-panel.tsx` implementation is good. Recharts covers timeseries, bar,
distribution, and area. Use each where it is strong.

---

## 10. Decisions taken (2026-08-06)

1. **Dependencies: yes.** Tailwind 4, Geist (self-hosted), Recharts 3, vendored Tremor
   components, Radix primitives, cmdk, TanStack Table v8. No `@tremor/react` package.
2. **Rollups: materialized fact tables** in the `evestack` schema, refreshed on a
   watermark.
3. **Docker socket: ship it**, opt-in via `EVESTACK_DOCKER_SOCKET`, read-only by
   default, lifecycle actions behind a second flag and the approval audit, documented
   as a privilege escalation.
4. **Sequence:** correctness and attribution first, then the design system, then
   Session Detail, then Overview and Monitors. Design system moves earlier than
   originally proposed because adopting Tailwind is now a prerequisite rather than a
   later refinement, and doing it after the pages would mean writing them twice.

---

## 11. Verification pass (2026-08-06) — corrections to §2, §3 and §6

Everything above §11 was written earlier the same day. This section re-measured the
load-bearing claims against the live database and the repository. Three of them were
wrong. Where §11 and an earlier section disagree, §11 wins.

### 11.1 The dashboard already has a Monitors page. §2 is wrong.

§2 inventories 13 pages and says "there is no rate, no percentile, no time series."
There are 14 pages, and the fourteenth is `app/monitors/page.tsx` — 226 lines of
percentiles, error rates and a bucketed time series. It shipped in `cfbff14`, "Build the
monitors the site has been showing a picture of," and `git cat-file -e` confirms it was
present at this session's starting commit. I did not miss a new commit; I missed a file.

Why: `packages/website/lib/copy.ts:199-205` (was `:181-187`; round 3 added a comment block
above it) states that
`grep -rniE "p95|percentile|Monitors" packages/dashboard/{app,lib,components}` returns
nothing. That comment was accurate when written and stale by the next commit. I quoted it
instead of running it. The grep returns **33 matches across 2 files**, and `/monitors` is
in the nav at `app/layout.tsx:22`.

What exists in `lib/monitors.ts` (259 lines):

| Capability | Detail |
| --- | --- |
| Percentiles | `percentile_cont` at 0.50 / 0.75 / 0.95 / 0.99, plus max and count |
| Latency vs duration | Held separate on purpose — a `session` run stays `running` while a human keeps the tab open, so its duration measures the human, not the agent |
| Failure accounting | `error_code IS NOT NULL` **plus** finished turns with no `$eve.model`, counted and reported separately |
| Time series | `width_bucket` over epoch seconds, 12 buckets, densified so an idle hour draws as zero instead of being skipped |
| Windows | 1h / 6h / 12h / 24h / 7d |
| Tests | `test/monitors.test.mjs` (pure arithmetic) + `contract/runtime/probes/05-monitor-percentiles.probe.mjs` (PostgreSQL semantics against a live server) |

Consequences: W8 is an extension, not a greenfield build. W2's proposed `outcome` field
should adopt this failure definition rather than invent a competing one. W1's premise
that no page shows percentiles is false.

### 11.2 The attribution fix in §6 and W1 would not have worked. §3.5 is wrong.

§3.5 measured 2,455 spans and reported `workflow.run.id` on 1,760 of them (72%),
concluding that adding that key to the `session_id` generated column moves attribution
from 1% to above 90%. Re-measured:

| | §3.5 (earlier) | Verified now |
| --- | --- | --- |
| Spans | 2,455 | **37,125** |
| `session_id` populated | 24 (1.0%) | **36 (0.1%)** |
| `workflow.run.id` present | 1,760 (72%) | **36,119 (97.3%)** |

The 97.3% looks like the fix working. It is not. Span names:

| Span name | Rows |
| --- | --- |
| `workflow.stream.read.complete` | **34,324** |
| `workflow.stream.flush` | 1,269 |
| everything else `workflow.*` / `step.*` / `queue.*` | ~1,278 |
| **non-engine spans** | **254** |

92.5% of the table is one engine-noise span name, and it is what carries
`workflow.run.id`. Restricted to spans anyone would want to see:

| Span name | Rows | `session_id` | `workflow.run.id` |
| --- | --- | --- | --- |
| `chat qwen3` | 18 | **0** | **0** |
| `execute_tool bash/remember/recall/forget` | 5 | **0** | **0** |
| `invoke_agent qwen3` | 18 | 18 | 0 |
| `step 1` | 18 | 18 | 0 |
| `hook.resume` | 34 | 0 | 19 |
| `ai.eve.turn` | 14 | 0 | 0 |

So the two span families the dashboard's own `MODEL_CALL_PREDICATE` and
`TOOL_CALL_PREDICATE` query are attributed at **0%**, and adding `workflow.run.id` to the
generated column would attribute **zero** of them while reporting 97% success.

**The information is there, one hop up.** Every `chat *` and `execute_tool *` span's
parent is a `step 1` or `invoke_agent qwen3` span that carries a resolvable session id —
verified across all 17 distinct parent/child pairs, no exceptions. A
`GENERATED ALWAYS AS` column cannot read another row, so attribution has to be a
materialized recursive walk down the trace tree. `buildSpanTree` in `lib/traces.ts`
already does exactly this at read time, which is why the trace *viewer* looks healthy
while every SQL aggregation over spans returns nothing.

Two further facts about `workflow.run.id`, for whoever builds the join:

- It points at a **session** run on 1,793 spans and a **turn** run on 241. It is not a
  session id and must be resolved through `workflow_runs` `$eve.parent` / `$rootRunId`.
- **8 of 48 distinct values reference runs absent from `workflow_runs`.** Every join
  through it needs a real "run no longer exists" branch.

Trace-level: **34,914 traces, of which 14 contain any span with a session id.**

### 11.3 The spans table has no retention policy and is 92.5% noise

38 MB for 42 runs — roughly **880 spans per run**. `grep -rniE "retention|prune|ttl"`
finds nothing for spans anywhere in `packages/dashboard`, `packages/evestack-cli` or
`docs/`. `sql/approvals.sql` explicitly reasons about retention and concludes "keep
everything," which is right for approvals and was never decided for spans.
`docs/index.mdx:49` sells self-hosted run-state retention as "as long as you keep the
rows," so nothing upstream bounds this either. Straight-line: ~9 GB at 10k sessions, in
the same Postgres as durable session state. This is now in W1.

### 11.4 The verification apparatus this plan had been ignoring

12 contracts in `contract/contracts/` (`node contract/run.mjs`), 5 runtime probes in
`contract/runtime/probes/` asserting against a live server (`node contract/runtime/run.mjs`),
and per-package `node:test` suites. The established convention, stated in
`test/monitors.test.mjs`: pure arithmetic is unit-tested in JS, and anything whose
semantics belong to PostgreSQL gets a probe against a real server rather than a
restatement in JavaScript. New workstreams should ship in that shape. Now W12.

### 11.5 There is not enough data to build against

116 meaningful spans, 42 runs across two hours, 21 rows in `evestack.budget_steps`,
14 in `budget_usage`, 1 each in `budget_events` and `budget_stops`, 2 approvals.
`fixtures/` contains only skills. No p99 chart, cost breakdown or distribution heatmap
can be built, reviewed or screenshotted against this. Seeded data is a wave-0
prerequisite, not a nicety. Now W12.

### 11.6 The live install runs a local model, so every cost reads zero

The agent is running `qwen3` against Ollama on `127.0.0.1:11434`. `pricing.ts:72` prices
`ollama/*` at zero deliberately — correct, since local inference costs no API money, and
the comment records that the gateway catalog has zero `ollama/` entries out of 317. The
consequence for W9: on a local-only install the entire cost surface, the flagship
differentiator over Vercel's Agent Runs, renders `$0.00` everywhere. That needs a
designed first-run state, not a grid of zeroes.

### 11.7 A migration guard that would silently swallow the W1 change

`sql/traces.sql:126` re-derives the generated columns only when
`current_expr NOT LIKE '%ai.settings.context.eve.session.id%'`. Any future edit that
keeps that substring — which the W1 change would — leaves the guard false and the
migration inert on every existing database, while passing cleanly on a fresh one.
Replace it with a schema-version marker.

### 11.8 Claims from earlier sections that re-verified clean

- TTFT is real: `gen_ai.client.operation.time_to_first_chunk` present on 17 spans,
  matching the 18 `chat` spans, and read by nothing.
- Docker labels are real and complete: `eve.sandbox.tag.sessionId` etc., verified live.
- `workflow_steps` / `workflow_events` remain unread by the dashboard.
- The two-vocabulary problem in `sql/traces.sql:56-70` is real and correctly documented.
- Tremor's npm incompatibility (§8.2) is unchanged; vendoring remains right.

### 11.9 Working tree

At the time of writing: `templates/default/agent/channels/{discord,slack,telegram}.ts`
and `templates/default/package.json` modified, `agent/channels/idle.ts` and
`scripts/dev.mjs` untracked. The set changed twice during this pass, and branch history
was rewritten (commit hashes differ from session start for identical messages, and
`4de9897..HEAD` is only the two `next dev`-generated AGENTS.md/CLAUDE.md files). Another
process is editing this workspace. Nothing in it touches `packages/dashboard`. Branch
before starting W1.

---

## 12. Second verification pass (2026-08-06, later) — pre-implementation checks

§11 audited the findings. This section audits the *architectural assumptions* each
workstream rests on, before anyone starts building. Five were wrong or incomplete.

### 12.1 The measured environment no longer exists

`my-agent-postgres-1` was destroyed part-way through this pass, along with
`evestack-postgres-1`, `my-agent-dashboard-1` and `warden-dashboard`. The replacement
stack, `easymode-*`, came up two minutes later holding **0 runs and 1 span**. Schemas
(`workflow`, `evestack`) are present and correct; the data is not.

Every quantity in §3 and §11 is therefore historical. It was accurate when measured and
cannot be re-run. This is not an accident to route around — `create-evestack` makes a
named per-project stack, and destroying it destroys the history. It moves seeded data
from "would be nice" to "the only way anyone builds a chart," and it is why W12 is wave 0.

### 12.2 W6's live mechanism was wrong, and something better already exists

`select count(*) from information_schema.triggers where trigger_schema='workflow'` → **0**.
There is nothing to `LISTEN` to, and creating a trigger would be a write to a schema the
plan declares read-only and which `@workflow/world-postgres` owns.

What exists instead is better. eve serves a durable, indexed NDJSON stream at
`GET /eve/v1/session/:sessionId/stream`, and `app/api/control/sessions/[id]/stream/route.ts`
already transcodes it to SSE with exact resumption: each frame's absolute index is sent as
`id:`, a reconnecting `EventSource` echoes it as `Last-Event-ID`, and that becomes the next
`startIndex`. Replay-free and gap-free, with `?format=ndjson` passing bytes through for
fetch-based readers.

The real constraint: eve's HTTP surface is per-session only — four endpoints, confirmed
against `05-http-protocol.contract.mjs` (`/eve/v1`, `/eve/v1/session`,
`/eve/v1/session/:id`, `/eve/v1/session/:id/cancel`, plus the stream). **No fleet-wide
feed exists.** A live overview must poll for the roster and attach the durable stream per
session.

### 12.3 W2 has a watermark, but its maintenance is unconfirmed

`workflow.workflow_runs` carries `created_at`, `updated_at`, `started_at`, `completed_at`,
`expired_at`. `updated_at` is the right column for an incremental refresh, since a run row
is mutated after insert as its status changes and a `created_at` watermark would miss
those updates. **Whether world-postgres actually maintains `updated_at` on every mutation
is unverified** — the package is not installed at the repo root, so its migrations could
not be read, and the fresh database is empty. Confirm before the fact-table refresh
depends on it; the fallback is a status-aware re-scan of unfinished runs.

### 12.4 W7 rests on two things it does not own

- **Docker is not the only backend.** `@evestack/sandbox-opensandbox` is published and
  duck-types eve's `SandboxBackend`; `09-sandbox-backend.contract.mjs` exists to keep that
  compatible. Everything W7 describes — `docker stats`, `NetworkMode`, image digest — is
  Docker-specific and renders empty on that install.
- **The `eve.sandbox.*` labels are upstream's.** They are written by `eve/sandbox/docker`;
  no code in this repo authors them. They are an upstream contract in the same category as
  the `$eve.*` run attributes, and contract 09 guards the backend interface shape without
  asserting a single label name. A rename upstream empties the page silently.

### 12.5 Toolchain and design-system template — both verified clean

Root had `node_modules`, `packages/*` did not. `pnpm install --frozen-lockfile` resolved
564 packages in 14.4s. Then, in `packages/dashboard`:

- `pnpm test` → **120 pass, 0 fail** (Node 26, `node:test` via a TS resolver shim)
- `pnpm typecheck` → `next typegen` + `tsc --noEmit`, clean

Worth noting one passing test by name: *"eve's session and turn ids are inherited by the
AI SDK spans beneath them."* The read-path ancestor inheritance described in §11.2 is not
only present, it is already under test. Only the SQL side is missing.

The Tailwind 4 wiring W3 copies from `packages/website`, verified rather than assumed:
`tailwindcss@^4.1` + `@tailwindcss/postcss@^4.1` + `postcss@^8.5` in devDependencies, a
one-line `postcss.config.mjs`, `@import "tailwindcss"` plus `@theme` / `@theme inline` in
`app/globals.css`, and `geist@^1.7` via `geist/font/sans` and `geist/font/mono` in
`app/layout.tsx`. Both packages are already Next 16.3.0 / React 19.2.8. The dashboard
currently has five runtime dependencies and no CSS framework.

Both `AGENTS.md` files warn that this Next release differs from training data and direct
readers to `node_modules/next/dist/docs/`. Those files are regenerated by `next dev`, so
their appearance in a diff is expected.

### 12.6 Still unverified, and why it is acceptable

- **Reasoning parts in `gen_ai.output.messages`** (W4). Needs span data; none exists now.
  Already scoped in W4 as splittable so it cannot block the page.
- **`updated_at` maintenance** (12.3). Cheap to confirm once any run exists.
- **The Docker label join end-to-end** (W7). The label set was verified live earlier in
  the session against a running container; re-confirm against a live sandbox once one is up.

All three are answerable in minutes once W12's seed data lands, which is the argument for
doing W12 first.

---

## 13. What building the fixture proved (2026-08-06, W12 shipped)

Reproducing the broken state faithfully turned out to be the fastest way to understand
it. Three things only became visible while writing `packages/dashboard/scripts/seed.mjs`.

### 13.1 The engine-noise spans carry a placeholder run id, not a real one

§11.2 argued that widening the `session_id` generated column with `workflow.run.id` would
attribute engine noise. That was right but understated. Sampling a real
`workflow.stream.read.complete` span:

```json
{
  "operation.name": "workflow.client",
  "workflow.run.id": "wrun_00000000000000000000000000",
  "workflow.stream.name": "strm_00000000000000000000000000_user",
  "workflow.stream.operation": "read_complete"
}
```

An **all-zero ULID**. So the earlier measurement — 48 distinct `workflow.run.id` values,
40 resolving and 8 dangling — was really one placeholder covering tens of thousands of
rows plus a handful of genuinely pruned runs. Widening the generated column would not
merely attribute noise: it would attribute roughly 30,000 spans to a run that has never
existed and cannot ever exist. Confidently wrong, at scale, with a healthy-looking
percentage on top. Worth restating as a rule: a key being *present* on 97% of rows says
nothing about whether its values *mean* anything.

### 13.2 The fixture is the proof obligation

The seeder writes model and tool spans with no ids, hanging beneath parents that have
them, because that is what eve really emits. Being "helpful" and tagging them would have
destroyed the only thing that can demonstrate the attribution fix works. Two tests in
`test/seed.test.mjs` now hold that shape down: one asserts the children carry no ids, the
other asserts every one of them resolves to a session by walking up. If someone later
"fixes" the fixture, those fail.

Same reasoning for cost. The fixture contains both zero states — `ollama/qwen3` priced at
zero because local inference is genuinely free, and `acme/experimental-v1` absent from the
catalog entirely. Both record `cost_usd = 0`; only the `priced` boolean separates them.
Any code that sums cost without reading that boolean reports unpriced spend as free, and
now there is data that catches it.

### 13.3 Emitting SQL beat connecting to Postgres

The seeder was first written against the `pg` client and abandoned after `pg` vanished
from `node_modules` twice mid-command — this workspace is churned by something outside
the session. Emitting `COPY` on stdout removed the dependency, and turned out to be
better on every axis that matters: 3,322 runs and 32,991 spans load in **1.4 seconds**,
the fixture is reviewable as text before it touches a database, and it matches how this
package already ships schema. The guard travels with the data as a `DO` block that
`RAISE`s, so a refused seed aborts the whole transaction rather than half-writing.

### 13.4 The corpus, as verified after loading

| | |
| --- | --- |
| Runs | 3,322 over 30 days (700 sessions, 1,922 turns incl. subagents, 700 untagged timeout companions) |
| Turn outcomes | 113 errored · 62 no-model-call · 37 cancelled · 8 unfinished |
| Turn latency | p50 6.6s · p95 31.3s · p99 57.4s · max 122.5s |
| Spans | 32,991, of which **92.6%** engine noise (live database measured 92.5%) |
| **Model + tool spans** | **1,198, attributed to a session: 0** |
| Spend | Sonnet $8.14 · gpt-5-mini $2.91 · ollama $0.00 *(free)* · acme $0.00 *(unpriced)* |

That last row of the spans block is the W1 target, and it is now a number that can be
watched move.

### 13.5 Two product defects the seeded database exposed immediately

Loading a month of history and opening the dashboard surfaced two things no amount of
reading found, because both only appear at volume or with history.

**Fleet health does N round trips to the live agent, one per session.** The overview
renders a banner reading *"25 sessions could not be checked — the agent did not answer"*
and then *"1 further idle session was not checked; each check costs a round trip to the
agent. Raise the bound with /api/fleet?limit=."* The bound exists because the cost is
linear in sessions. At 700 sessions that design cannot be raised into correctness — it
either lies by sampling or it takes 700 round trips. `/api/fleet` needs a different
shape before the overview can claim to describe the fleet.

**A database with history and no running agent renders as alarming rather than
historical.** Every one of those sessions classifies `unknown` with reason "the agent
could not be reached". That is honest per session and wrong in aggregate: a month-old
completed session is not unknown, it is finished, and nothing about it requires asking a
live agent. The classifier should settle anything the database can settle on its own and
reserve the agent round trip for sessions that are plausibly still live.

Both belong to W6 (the overview) and W7 rather than W1, and neither is a regression — they
are pre-existing and were simply invisible against three runs. Noting the consequence for
W1's fleet work: the classifier's agent-dependent states cannot be validated against
seeded data at all, because seeded sessions do not exist in any agent's memory. Test the
classifier as a pure function over its inputs; a confusion matrix against the live
`/api/fleet` will only ever report `unknown`.
