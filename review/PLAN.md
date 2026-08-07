# evestack dashboard v2 — the plan

Companion to `RESEARCH.md`, which holds the evidence for every factual claim here.

**How to use this document.** It is a map of everything we want to build, at
workstream altitude. It is deliberately not a task list. Every workstream states a
goal, a rough scope, and what "done" looks like, and stops there. Expect the specifics
to change once someone is inside the code, and change them. If a workstream turns out
to be wrong, say so and rewrite it rather than following it off a cliff.

**Thesis.** The dashboard today is a set of SQL views over other people's tables. That
is its superpower (no ingest pipeline to keep in sync) and its ceiling (no time
dimension, no rollups, percentiles on exactly one page, every page a full scan). You do not get to a
Vercel- or Datadog-class dashboard by adding charts to this. You get there by adding
three layers underneath first: **attribution, facts, and a query API**. After that,
every chart is a config object and adding a metric stops being a code change.

**The number that mattered most — now fixed.** Model calls and tool calls (`chat *`,
`execute_tool *`) were attributed to a session at **0%**, so every SQL aggregation over
spans returned nothing while the trace viewer looked healthy. As of `b86cdfa` it is
**1,197 of 1,197**. Everything the observability story wants to say was downstream of
that, which is why nothing else shipped first.

The three layers below are therefore now: **facts and a query API** (W2), on top of
attribution that works.

**Read this before W1 (revised 2026-08-06).** An earlier draft of this plan said
attribution was "24 of 2,455 (1.0%), and the fix is one generated column on
`workflow.run.id`." A verification pass against the live database proved that wrong in
the way that matters most: `workflow.run.id` is present on 36,119 spans, of which
~36,100 are `workflow.stream.read.complete` engine noise. Adding it to the generated
column would move the headline number to 97% and attribute **zero additional model
calls and zero additional tool calls**. That is a confidently wrong number of exactly
the kind the ground rules at the bottom of this file forbid. `RESEARCH.md` §11 has the
measurements.

---

## Decisions (settled — do not relitigate without a reason)

1. **We take dependencies.** Tailwind 4, Geist, Recharts 3, vendored Tremor
   components, Radix primitives, cmdk, TanStack Table v8.
2. **We vendor Tremor rather than installing it.** Vercel acquired Tremor in Jan 2025
   and its founders now work on the Vercel dashboard, so this is literally their
   component library. But `@tremor/react` stable peer-deps React 18 and the v4 beta was
   abandoned on 2024-12-14, five weeks before the acquisition. Copy the source in. See
   `RESEARCH.md` §8.2.
3. **Rollups are materialized fact tables** in the `evestack` schema, refreshed
   incrementally on a watermark. Not views (too slow for percentiles), not a second
   datastore (breaks the "it's just your Postgres" promise).
4. **The Docker socket ships**, opt-in via `EVESTACK_DOCKER_SOCKET`, read-only by
   default, lifecycle actions behind a second flag and the approval audit, documented
   as a privilege escalation.
5. **Order: correctness → design system → session detail → overview and monitors.**

### One rule the dependency decision does not relax

The dashboard must still make **zero network requests at runtime**. That was the real
point of the old no-dependency rule, and it survives: Tailwind compiles to a static
stylesheet at build time, Geist self-hosts through `next/font`, and Recharts is a
bundled library. Nothing phones home. Any new dependency that breaks this is out,
regardless of how good it looks.

---

## The stack

```
Tailwind 4.3.x            styling, already used by packages/website
geist 1.7.x               Vercel's typeface, self-hosted via next/font
Recharts 3.10.x           chart engine (React 19 supported), under vendored Tremor
Tremor components         copied into components/ui and components/charts, restyled
Radix primitives          popover, tooltip, dialog, dropdown, tabs
cmdk                      command palette
@tanstack/react-table 8.x  faceted, sortable, virtualized tables (v9 is beta, pin 8)
tailwind-variants, clsx, date-fns
```

Hand-rolled SVG does not go away. **The span waterfall and the row sparklines stay
bespoke**, because Recharts has no waterfall and the existing implementation in
`packages/website/components/sections/monitors-panel.tsx` is good. Use Recharts for
timeseries, bar, area, and distribution. Use SVG for the rest.

---

## The reference bar

What we are matching, and where we intend to be better.

**Vercel Agent Runs** (the hosted eve dashboard) is the parity target for the session
experience: runs over time by trigger, tokens over time split in/out/cached, a runs
table, and per turn the step timings including skill loads, the input, the output, the
**reasoning**, and the tool calls with arguments and results. That is their whole
product. It is read-only and shows no cost.

**Vercel Observability** is the interaction target: drag-to-select on a chart then Zoom
In, a ranked list under every chart that re-sorts by error rate or duration, each row
drilling into a detail view that links out to the logs. Note that Vercel **sunset**
their standalone Monitoring product and folded it into curated insight sections plus
saved Notebooks. Curated defaults beat an empty canvas; build accordingly.

**Datadog** is the visualization and alerting target. About ten of their widget types
are relevant to us: Timeseries, Bar Chart, Query Value, Change, Distribution, Heatmap,
Table, Top List, Alert Graph, Monitor Summary. Their Agent Observability product adds
the idea worth stealing hardest: **Insights**, zero-configuration anomaly detection on
duration and error rate across span name, workflow type, and topic. Their `ml_obs.*`
cost model also decomposes cost into cache_write, cache_read, and non_cached, each at
its own rate, and treats reasoning as a first-class token and cost dimension. Both are
things evestack currently gets wrong or misses.

**Langfuse** is the query-model target. Their preset dashboard JSON and their
`{view, measures, dimensions, filters, timeDimension, orderBy, limit}` query shape are
proven, MIT, and directly borrowable. Full widget list in `RESEARCH.md` §4.3.

---

## Workstreams

### W1 · Truth

> **SHIPPED 2026-08-06 — `b86cdfa`.** Model and tool span attribution went from **0 of
> 1,198** to **1,197 of 1,197**, verified on a rebuilt seeded database and verified
> *correct* rather than merely non-null: every resolved session id is a real
> `$eve.type='session'` run, and every resolved turn id is a real turn whose
> `$eve.parent` equals the resolved session. 31 files, +3,274 lines, 17/17 contracts,
> 183 tests, tsc clean.
>
> Two things worth carrying forward. The fix is a materialized ancestor walk, **not** the
> generated column this plan originally specified — that would have attributed ~30,000
> engine-noise spans to `wrun_0000…0`, a run that has never existed, and reported 97%
> success. And the session list went 195.8ms / 128,990 buffers to 0.9ms / 613 on keyset
> pagination plus `evestack_`-prefixed additive indexes.
>
> Adversarial review confirmed 14 defects in the shipped work, remediated separately. The
> dominant failure mode was **code that does nothing**: an inert parameter no caller
> passed (the cache-write pricing change moved no dollar), a function with no readers, a
> generated column nothing selected, a branch nothing reached, and a test asserting a dead
> branch back to itself. Worth expecting in every later workstream.


**Goal.** Make what the dashboard already shows correct, and make the trace tier
actually attributable. No new pixels.

**Scope, the hard part first: attribution is a tree walk, not a column.**

Measured on the live database. `chat qwen3` and `execute_tool bash|remember|recall|forget`
carry no session id, no turn id, and no `workflow.run.id`. Their *parents* —
`step 1` and `invoke_agent qwen3` — carry all three, on every single row. So the
information is present and reachable; it just lives one hop up the trace tree.

A `GENERATED ALWAYS AS` column cannot express that, because it can only read the row it
is on. `buildSpanTree` in `lib/traces.ts` already does the ancestor walk at read time,
which is why the trace *viewer* looks fine while every SQL aggregation over spans comes
back empty. The fix is to make the same inheritance exist in the database:

- Keep `session_id` / `turn_id` as the "declared on this span" columns. Do not widen
  them with `workflow.run.id`; that key is on engine noise and would poison them.
- Add resolved columns (`resolved_session_id`, `resolved_turn_id`) populated by a
  recursive CTE that propagates the nearest non-null ancestor value down each trace,
  materialized at ingest and backfillable.
- `workflow.run.id` still earns its own plain column, because it is the join to
  `workflow_runs` — but note it points at a **session run on some spans and a turn run
  on others**, so it must be resolved through `workflow_runs.$eve.parent` before it can
  be treated as a session. And **8 of 48 distinct values point at runs that no longer
  exist**, so every join through it is a LEFT JOIN with a real "run pruned" branch.

**Scope, ingest hygiene.** 34,324 of 37,125 spans (92.5%) are
`workflow.stream.read.complete`. 38 MB of table for 42 runs, ~880 spans per run, no TTL
and no sampling anywhere in the repo. This is not cosmetic: it is 100× the rows any
fact-table build needs to scan, and at 10k sessions it is several GB sitting in the same
Postgres as durable session state. Needs a drop-list or sample rate at ingest, and a
retention policy with a default. `sql/approvals.sql` reasons explicitly about unbounded
retention and concludes "keep everything"; spans never got that decision made.

**Scope, the rest.** One time-formatting strategy across all pages, replacing the
double-correction currently masked by the container running UTC. Rename `tool_count` to
"tools offered" and derive real invocation counts. Expression indexes on the `$eve.*`
JSONB lookups. Cursor pagination. Collapse the `/traces/[id]` N+1. Delete the dead
`getTraceStats()`. Charge cache-write tokens at their own rate. Fix the fleet banner's
unreadable sentence. Surface the `invoke_agent` and `step N` spans that are ingested and
never shown.

**One trap, specifically.** `sql/traces.sql` ends in a `DO $$` migration that re-derives
the generated columns, guarded by
`current_expr NOT LIKE '%ai.settings.context.eve.session.id%'`. Any change to those
column expressions that *keeps* that substring leaves the guard false and the migration
silently inert on every existing database. Change the guard, or better, replace it with
a schema-version marker.

Full defect list with evidence in `RESEARCH.md` §6, corrections in §11.

**Done when.** Model-call and tool-call spans resolve to a session at above 90% on a
real database, the spans table has a stated retention policy with a default, timestamps
are correct running outside a UTC container, and no page shows a number that means
something other than its label.

---

### W2 · Substrate

> **SHIPPED 2026-08-06 — `ecb17e3`, fixes through `5c135f5`.** `fact_turn` and
> `fact_tool_call` materialized and reconciling exactly: nine measures computed from the
> fact tables against the same measures from `workflow_runs` agree on 1,922 turns and
> 700 sessions with an empty disagreement list. Refresh is 28ms and idempotent. One
> Langfuse-shaped endpoint on top.
>
> Two corrections the agent found that this brief had wrong. `updated_at` alone is not
> enough: spans arrive *after* the run row stops moving, so `span_coverage` would have
> frozen at `'none'` for every turn that did export spans — the field whose whole purpose
> is honesty, lying. It needs a second watermark on `spans.received_at`. And `>=` is not
> theoretical: 3,322 runs land on 3,038 distinct `updated_at` values.


**Goal.** A fact layer and a query API, so charts become configuration.

**Scope.** Two materialized tables in the `evestack` schema, refreshed incrementally:

- `fact_turn`, one row per turn, carrying identity (session, turn, agent, environment,
  channel, trigger, model, provider), timing (duration, TTFT, time per output chunk,
  tokens per second), tokens split four ways, cost decomposed the way Datadog does it
  (input / output / cache_read / cache_write / reasoning, each at its own rate), step
  and retry counts, tools offered vs called, finish reason, error, and two derived
  fields that carry disproportionate weight:
  - **`outcome`** (ok / failed / no_model_call / cancelled / budget_stopped / wedged).
    Necessary because `status` is a constant, eve leaves session runs `running` forever,
    and a failed turn still records `status='completed'`. Without this there is no
    error rate to chart.
  - **`span_coverage`** (none / partial / full). So a p95 TTFT drawn over 3 of 40 turns
    says so instead of rendering a confident line.
- `fact_tool_call`, one row per invocation.

Then a metric catalog (`{id, label, unit, source, expr, allowedAggregations,
allowedDimensions}`) and one endpoint, `POST /api/metrics/query`, shaped like
Langfuse's so the semantics are proven and their presets are importable later.
Aggregations: count, count_distinct, sum, avg, min, max, p50, p75, p90, p95, p99, rate.
Units: duration, cost, count, percent, bytes, tokens. Support Braintrust's
trace-scope vs span-scope filter distinction, because "sessions where any turn failed"
is a different question from "failed turns". Build SQL only from the catalog so there
is no injection surface, and refuse grouping on high-cardinality fields.

Name metrics after the OTel GenAI semantic conventions so the vocabulary is portable.

**Done when.** A single HTTP call can answer "p95 TTFT by model, hourly, last 24h,
failed turns only" against a real database, and adding a new metric is a catalog entry.

---

### W3 · Design system

> **SHIPPED 2026-08-06 — `ecb17e3`.** Tailwind 4 and Geist adopted with provably zero
> visual change, by taking `theme` and `utilities` and deliberately leaving `base`
> (preflight). Preflight is one line and belongs to the wave that restyles pages. The
> existing hand-rolled CSS moved into `@layer app`, because unlayered CSS outranks every
> layer and would have made the matching utilities silently inert. Then 37 files of chart
> and UI primitives, accessibility built in rather than retrofitted.
>
> **The lesson worth carrying into every later wave.** W2 and W3 ran in parallel on the
> stated understanding that they "meet at the chart props", and nobody wrote down what
> that seam was. Both halves then invented their own vocabulary: the query API stamps
> `duration/cost/percent`, the charts matched on `ms/usd/ratio`, so a series fed from the
> API — the one workflow the API exists to enable — rendered money as a bare count. The
> same thing happened twice more: two formatter stacks, and chart buttons keeping the
> OS's grey Arial chrome because `components/ui/style.ts` already solved it and the other
> agent did not know. **Specifying file ownership is not enough; the contract at the seam
> has to be built, not described.** Wave 3 started by pinning the outcome vocabulary to
> the SQL with a test before either agent ran.


**Goal.** One visual language across the site and the product, on the Vercel stack.

**The wiring to copy, verified in `packages/website`.** devDependencies `tailwindcss@^4.1`,
`@tailwindcss/postcss@^4.1`, `postcss@^8.5`; a one-line
`postcss.config.mjs` — `export default { plugins: { "@tailwindcss/postcss": {} } };`;
`@import "tailwindcss"` at the top of `app/globals.css` with `@theme` / `@theme inline`
blocks for tokens; and `geist@^1.7` imported as `geist/font/sans` and `geist/font/mono` in
`app/layout.tsx`. Both packages are already on Next 16.3.0 and React 19.2.8, so this is a
copy, not a port. The dashboard today has five runtime dependencies and no CSS framework.

**Scope.** Introduce Tailwind 4 and Geist into `packages/dashboard`. Build a token
layer (gray 100–1000, blue, ok/warn/err each in subtle/default/strong, 4pt spacing,
three radii, a six-step type scale) aligned to the Geist-derived tokens
`packages/website` already uses. Vendor and restyle the Tremor components we need.
Build the chart primitives on top: TimeSeries (line, bar, stacked, area), Sparkline,
BigNumber (value plus delta versus previous period plus sparkline), TopList,
Distribution, Waterfall, Heatmap. Shared crosshair, tooltip, legend, empty and loading
states. Drag-to-zoom on every time chart, because it is Vercel's best interaction and
it is cheap. Respect `prefers-reduced-motion`. Add a manual light/dark toggle; today it
is OS-only.

Three conventions the current UI gets right and must not lose: an unpriced model never
renders as `$0.00`; a metric computed over partial data says so; an absent value is an
em dash, never a zero.

Accessibility is part of the design system, not a later pass: keyboard reach for every
chart interaction that has a mouse one (drag-to-zoom needs a keyboard equivalent),
focus-visible states on the token layer, series distinguishable without relying on hue
alone, and charts that expose their underlying numbers to a screen reader rather than
being an unlabelled `<svg>`. Retrofitting this after eight chart primitives exist costs
several times what building it in does.

**Done when.** A chart can be dropped into any page with two lines and looks like it
came from the same company as evestack.vercel.app.

---

### W4 · Session detail

**Goal.** The page a user actually lives in, at parity with Agent Runs and past it.

**Scope.** Three panes: turn and step tree, timeline plus transcript, facts. A real
waterfall spanning turns, steps, model calls, and tool calls, built from
`workflow_steps` **plus** spans so it renders even with OTLP export off. A transcript
view (user message, reasoning, tool calls with collapsible arguments and results,
assistant text). A per-turn metric strip. Every action inline: cancel, message,
approve, fork, promote to eval, open this session's sandbox.

**Done when.** You can answer "what did this agent do, how long did each part take, and
what did it cost" without leaving the page or opening a SQL client.

**Note.** Reasoning capture is the one Agent Runs feature we lack entirely. Whether the
AI SDK emits reasoning parts inside `gen_ai.output.messages` is **unverified** and
needs checking early. If it does not, this needs an upstream change and should be
split out rather than blocking the page.

---

### W5 · Sessions list

**Goal.** Find the run you are looking for.

**Scope.** Faceted search and filters (outcome, model, trigger, channel, date, cost,
duration, has-error, has-approval, has-sandbox), sortable columns, cursor pagination,
saved views, CSV and JSON export, bulk select. Replace the `status` column, which reads
`running` for every row, with `outcome`. Row-level duration sparkline.

**Done when.** "Show me every failed turn on claude-opus-5 that cost over a dollar
yesterday" is three clicks.

---

### W6 · Overview and Live
> **SHIPPED — `f3cec00`.** Six tiles, two stacked series, two ranked lists, all config against the W2 query API. Live/SSE deferred: eve's HTTP surface is per-session only, so a fleet feed has to be polled; the roster is cheap and the value was in the monitor, not the ticker.


**Goal.** A front door that is a monitor, not a list.

**Scope.** Big numbers with sparkline and period-over-period delta (runs, success rate,
p95 turn latency, spend, tokens, active sandboxes). Runs over time stacked by trigger
and spend over time stacked by model, both Agent Runs parity items. Latency
distribution and TTFT by model. Top tools by calls and failure rate, top models by
spend, recent failures. A permanent left rail for anything wedged, awaiting a human, or
over budget, replacing the conditional fleet banner.

Plus a Live surface: running sessions with elapsed timers, current step, streaming token
counters, spend ticking up. Everything today is `force-dynamic` and refreshes by full
page reload.

**Corrected 2026-08-06 — not LISTEN/NOTIFY.** An earlier draft specified Postgres
LISTEN/NOTIFY with a poll fallback. There are **zero triggers in the `workflow` schema**,
so there is nothing to listen to, and adding one would mean writing to a schema this plan
declares read-only. It would also not survive an eve upgrade.

The better mechanism already exists and is already built. eve serves a **durable, indexed
NDJSON event stream** per session, and `app/api/control/sessions/[id]/stream/route.ts`
already proxies it to SSE with *exact* resumption — each frame carries its absolute index
as `id:`, a reconnecting `EventSource` returns it as `Last-Event-ID`, and that becomes the
next `startIndex`. No replayed events, no dropped ones. That is strictly better than
LISTEN/NOTIFY: durable, replayable, and it touches nothing we do not own.

The catch, and the actual design problem for this workstream: **eve's HTTP surface is
per-session only.** Four endpoints, verified against `05-http-protocol.contract.mjs`, and
the stream is `GET /eve/v1/session/:sessionId/stream`. There is no fleet-wide feed. So
the roster of *which* sessions are live has to come from polling the database no matter
what, and the durable stream attaches per session once you are looking at one. Design for
that shape rather than trying to invent a global stream.

**Done when.** The first screen answers "is anything wrong right now" before you click
anything.

---

### W7 · Sandboxes
> **SHIPPED — `e92b7c1`.** Docker over its socket, opt-in, GET only, four distinct states. Three flags as a pure function.


**Goal.** The feature a hosted dashboard structurally cannot ship.

**Scope.** A Docker client reading containers labelled `eve.sandbox=1`. eve already
writes `eve.sandbox.tag.sessionId`, which joins directly to `workflow_runs.id`, plus
agent, channel, dev run id, and template key. Add container status, uptime, image
digest, network mode, and `docker stats` (CPU, memory, network I/O, block I/O, PIDs).
One card per container with a network-policy badge, resource sparklines, a link to its
session, and lifecycle actions behind the second flag.

eve keeps one container per session with **no idle timeout**, so orphans accumulate
silently. That is both the justification for the page and its first default monitor.

**Two constraints found on 2026-08-06.**

*Docker is not the only backend.* `@evestack/sandbox-opensandbox` is published to npm and
duck-types eve's `SandboxBackend` — `09-sandbox-backend.contract.mjs` exists specifically
to keep that working. On an opensandbox install there are no Docker containers at all, so
everything above renders empty. Either make the surface backend-agnostic or scope the page
to Docker explicitly and give the other case a real empty state that says why.

*We do not own the labels.* `eve.sandbox.*` is written by `eve/sandbox/docker`, upstream,
not by any code in this repo — `grep` finds no label authorship on our side. They are an
upstream contract exactly like the `$eve.*` run attributes, and a rename would silently
empty this page. Contract 09 guards the interface *shape* and says nothing about label
names. Extend it before depending on them.

*And the join is soft.* `eve.sandbox.tag.sessionId` does not "join directly" — a container
can outlive the run row it points at. Verified during this session: 8 of 48 distinct run
ids referenced from telemetry pointed at runs no longer present, including one that was
the live `sessionId` label of a running container. LEFT JOIN, and design the orphan case.

**Done when.** You can see every sandbox on the machine, know which session owns it (or
that its session is gone), and tell at a glance whether any of them has network access it
should not.

---

### W8 · Monitors and alerts
> **SHIPPED — `7528a72`.** Nine defaults, on by default. `unknown` sorts above `ok`. Notification by webhook/channel deferred — the states are computed and rendered; delivery is a smaller, separable piece.


**Goal.** Be told, rather than having to look.

**This is not greenfield — read the existing code first.** `app/monitors/page.tsx` (226
lines), `lib/monitors.ts` (259 lines), `test/monitors.test.mjs` and
`contract/runtime/probes/05-monitor-percentiles.probe.mjs` already ship, from commit
`cfbff14` "Build the monitors the site has been showing a picture of." What exists
today: `percentile_cont` p50/p75/p95/p99/max/count, turn latency held separate from
session duration (with the reasoning written out — a session stays `running` while a
human keeps the tab open, so its duration measures the human), failure counted as
`error_code` **plus** finished-turns-with-no-`$eve.model`, `width_bucket` time bucketing
that densifies empty buckets rather than letting the chart redraw a quiet hour as
continuous load, and a 1h/6h/12h/24h/7d window selector.

That is a real, careful monitors *view*. What is missing is everything that makes it a
monitor rather than a chart: thresholds, evaluation on a schedule, firing state,
notification. Extend it. Do not rewrite it, and do not re-derive its failure-accounting
rules — they are correct and W2's `outcome` field should adopt them, not compete
with them.

**Scope.** A monitors table storing a saved W2 query plus comparator, threshold,
window, cooldown, and severity; an events table for firing history; one evaluator tick
callable from a route, a container cron, or the CLI. Notification by webhook and
through the agent's own channels, which already exist in
`templates/default/agent/channels/`, so the agent can tell you in Slack that its own
budget blew.

**Ship a default monitor set, not an empty builder.** Vercel's own retreat from a blank
dashboard builder toward curated insights is the signal here. Nine defaults, each
mapping to a failure this codebase has already documented: wedged sessions; turn error
rate; p95 turn latency; daily spend against the configured cap; a schedule's failing
streak; **no spans received while sessions are running** (the silent-401 ingest failure
in `docs/observability.mdx`); unpriced model spend above zero; sandbox count or age;
and any sandbox running without `NetworkMode=none`.

The last four do not exist in any commercial product, because none of them can see your
ingest path or your containers.

**Stretch, worth considering once fact tables exist.** Datadog's Insights model:
zero-configuration anomaly detection on duration and error rate, trained on the prior
week, surfaced in the current window. It needs no user setup, which makes it strictly
better than a builder for the common case.

---

### W9 · Costs
> **SHIPPED — `e3204e1`.** Four rates, per-model cache savings ($2.99 on the seeded month, verified by hand). Reasoning tokens are not split out: eve emits no reasoning counter, so the column would be a permanent zero.


**Goal.** The thing Vercel's Agent Runs does not show at all.

**Scope.** Spend by model, session, day, and principal. Caps versus actual with a
forecast. Unpriced spend called out rather than summed as zero. Cost decomposed the way
Datadog does it, into cache_write, cache_read, non_cached, and reasoning, each at its
own rate. And **cache savings**, `cache_read_tokens × (input_rate − cache_read_rate)`,
which as far as this survey found nobody else puts on a page.

`evestack.budget_steps` is already a clean per-step cost ledger keyed on retry-safe
coordinates. It has no UI at all today. It currently holds 21 rows, so build against
seeded data (W12), not against this.

**Design for the install where every number is zero.** `pricing.ts` prices `ollama/*` at
zero deliberately and correctly — local inference costs no API money — and the live dev
database here is running `qwen3` through Ollama. On that install, the entire cost
surface, which is this plan's flagship differentiator over Vercel's Agent Runs, renders
as `$0.00` everywhere. That is not a bug to fix but it is a first-run experience to
design: a local-only install should get tokens, throughput, cache-hit ratio, and latency
promoted into the space where spend would otherwise sit, rather than a grid of zeroes.
Detect it (every priced model in the window is free) and say so once, plainly.

---

### W10 · Reconcile the landing page
> **SHIPPED — `2607288`.** Copy now matches the product. A fresh screenshot still wants taking by hand.


**Goal.** Close the last gap between the picture and the product, and fix the stale
comment that hid it.

**Revised 2026-08-06 — this is much smaller than the first draft said.** That draft
claimed the landing page ships a Monitors screen that does not exist. It mostly does
exist now: `cfbff14` built `app/monitors/page.tsx` with real p50/p75/p95/p99, a real
error rate, and a real bucketed runs series, specifically to make the picture true. What
is still advertised and still absent is narrow: a **timeout rate** (zero occurrences of
"timeout" anywhere in the monitors code) and **per-row activity sparklines** on the
sessions table. Search and pagination both exist.

So the honest fix is two small features plus a copy pass, not a teardown.

**Scope.** Add the timeout rate to `lib/monitors.ts` and the row sparkline to the
sessions table, or drop both from the mock. Replace
`packages/website/components/sections/monitors-panel.tsx` (still imported by
`observability.tsx:2`, still live on evestack.vercel.app) with a real screenshot of the
real page once W3 has restyled it. Check the two other rows `copy.ts` records as removed
but which appear still deployed: the `Tool approvals | Vercel Passport` comparison row,
and the "Full-depth tracing … The span tree is the product" feature cell.

**And fix the comment.** `copy.ts:181-187` still asserts that
`grep -rniE "p95|percentile|Monitors" packages/dashboard/{app,lib,components}` returns
nothing and that there is no Monitors route. That grep now returns 33 matches across two
files, and the route is in the nav at `app/layout.tsx:22`. A stale honesty note in the
honesty contract is worse than no note, because it is the thing people read to find out
what is true — it is what made the first draft of this plan wrong. Cheapest fix on the
list, and it should not wait for the rest of W10.

---

### W11 · Traces and Evals
> **SHIPPED — `15a7d51`.** Evals' `failed` grade was unreachable; 0 to 19. Traces needed nothing — W1 had already rebuilt it.


**Goal.** Bring the two weakest surfaces up to the new baseline.

Traces keeps its viewer but rebuilds on fixed attribution and gets linked from every
session. Evals grows into runs over time, pass rate, and per-eval history. Both are
lower priority than everything above.

---

### W12 · Verification and seed data

**Goal.** Make it possible for parallel agents to prove their work, and to build charts
against data that exists.

**This repo already has the apparatus, and the rest of this plan ignored it.** There are
12 contracts in `contract/contracts/` (`node contract/run.mjs`), 5 runtime probes in
`contract/runtime/probes/` that assert against a live server (`node contract/runtime/run.mjs`),
and per-package `node:test` suites (`packages/dashboard/test/*.test.mjs`, run through a
TS resolver shim). The convention is already established and is a good one: pure
arithmetic is unit-tested in JS, and anything whose semantics belong to PostgreSQL is
asserted by a probe against a real server rather than by restating it in JavaScript
(`test/monitors.test.mjs` says so explicitly).

**Scope.** Every workstream above ships with its verification in the existing shape, not
a new one. Attribution, retention, and the fact-table refresh each need a probe, because
each is a claim about what PostgreSQL did. Extend `06-run-attributes.contract.mjs`
whenever a new `$eve.*` key becomes load-bearing.

**Seed data, and this one blocks W3–W6.** As of the second verification pass this is no
longer merely thin — **it is gone**. The `my-agent-postgres-1` stack every measurement in
`RESEARCH.md` was taken against was destroyed part-way through that pass, and the stack
that replaced it (`easymode-*`) holds **0 runs and 1 span**. These environments are
per-project and ephemeral by construction; tearing one down takes its history with it.
Treat every number in §3 and §11 as historical, and treat a reproducible seeded database
as the first thing anyone builds. At the time of writing there is nothing else to build
against. For the record, the corpus that was there measured **116 meaningful spans** and
**42 runs spanning two hours**. `fixtures/` contains only skills. You cannot build,
review, or screenshot a p99 latency chart, a cost-by-model breakdown, or a distribution
heatmap against that. Someone needs to produce a seeded dataset — a few thousand runs
across several models, deliberate error and retry clusters, at least one wedged session,
one budget stop, one unpriced model, and spans with real `gen_ai.*` timing — and a
one-command load. Do this early; every visual workstream is otherwise being built blind
and will be tuned to an empty state.

**Done when.** `pnpm test` covers the new surfaces, a probe fails when attribution
regresses, and any agent can get a realistic database in one command.

---

## Sequencing

| Wave | Workstreams | What lands |
| --- | --- | --- |
| 0 | W12 (seed half) | A realistic database in one command. Unblocks every visual workstream. |
| 1 | W1 | Correct numbers, model and tool spans actually attributed, spans table bounded. No visible change, and that is the point. |
| 2 | W2, W3 (parallel) | A query API that answers percentile questions; a design system that looks like Vercel. |
| 3 | W4, W5 | The page you live in, and the ability to find anything. |
| 4 | W6 | A front door, and live. |
| 5 | W7, W8, W9 | The three things a hosted dashboard cannot do. |
| 6 | W10, W11 | The site tells the truth; the stragglers catch up. |

W12's verification half is not a wave. It rides along with every workstream.

W2 and W3 genuinely parallelize: one is Postgres and TypeScript, the other is Tailwind
and React, and they meet at the chart props. Everything else is mostly sequential
because it depends on the fact tables.

Wave 0 is new and it is small, but skipping it means five agents each inventing their
own throwaway test data, and every chart being tuned against an empty state.

Waves 1 and 2 produce almost nothing visible. Resist compressing them. Every chart drawn
before them would be drawn over spans whose model calls resolve to no session,
mislabelled tool counts, and timestamps that shift by an offset outside UTC. Building the
pretty part first is exactly how the current landing page happened.

---

## What makes this a million-dollar dashboard rather than a nicer table

Four things, in order of defensibility.

1. **Sandboxes.** Live containers, network policy, resource use, orphan detection,
   joined to sessions by a label eve already writes. A hosted dashboard cannot show you
   processes on your own machine. Nobody in the survey has this.
2. **Durable-execution health.** Event-log growth, serialization ratio, suspension
   state, stream dwell time, step retries. All already in the database, all unread, and
   all invisible to LLM-observability tools because they watch the model, not the
   workflow engine.
3. **Control fused with observation.** Every product surveyed is read-only. evestack
   can already approve, cancel, fork, and replay. Putting those actions inside the chart
   (click the p99 spike, cancel the run) is a category the incumbents cannot enter.
4. **Cost you own.** Per turn, per model, per principal, decomposed by cache behaviour,
   with caps, stops, forecasts, savings, and an `unpriced` label that refuses to lie.
   Vercel's Agent Runs shows no cost at all.

Parity items to close on the way, because their absence is noticed in the first thirty
seconds: runs over time by trigger, tokens over time split in/out/cached, per-step
timings, inline turn input and output, and reasoning.

---

## Ground rules for anyone picking this up

- **Verify before you build on it.** Several findings here came from reading the live
  database and the live Docker daemon, not from the code. Do the same. Anything marked
  unverified in `RESEARCH.md` is unverified.
- **Do not trust a comment in this repo, including a good one.** The first draft of this
  plan claimed the dashboard had no percentile code anywhere. It said so because
  `packages/website/lib/copy.ts` says so, in a comment that quotes the exact grep to run.
  The comment was true when written and false by the next commit, which built
  `lib/monitors.ts`. Running the grep took four seconds and would have caught it. This
  codebase's comments are unusually good, which makes them unusually easy to accept.
  Run the command.
- **Count what you are actually counting.** 92.5% of the spans table is one engine-noise
  span name. Any ratio taken over "all spans" is a statement about
  `workflow.stream.read.complete` and nothing else. Before quoting a percentage, check
  that its denominator is the population the question is about.
- **`workflow` is not ours.** It belongs to `@workflow/world-postgres`. Read it, never
  write it. Everything we create goes in the `evestack` schema, and
  `DROP SCHEMA evestack CASCADE` must never cost a durable session.
- **The `$eve.*` keys are string literals inside SQL.** `tsc` cannot see them and a
  rename returns NULL rather than raising, so the dashboard would render a confident
  zero. That is what `contract/contracts/06-run-attributes.contract.mjs` is for. Extend
  it when you depend on a new key.
- **Do not let a number lie.** Unpriced is not free, partial coverage is not full, a
  missing value is not zero, and "tools available" is not "tools called". The existing
  code is unusually careful about this and the new code has to be too.
- **Keep the runtime offline.** No new dependency may make a network request at run
  time.
- **The toolchain works; start by proving it still does.** Node 26, pnpm 10.27.0,
  `pnpm install --frozen-lockfile` at the repo root (~15s), then `pnpm test` and
  `pnpm typecheck` in `packages/dashboard` — 120 tests pass and typegen is clean as of
  2026-08-06. If the workspace looks broken, the usual cause is that only the root has
  `node_modules`.
- **This is not the Next.js you know.** Both `packages/dashboard/AGENTS.md` and
  `packages/website/AGENTS.md` say so, and mean it: read the relevant guide under
  `node_modules/next/dist/docs/` before writing Next code. Those AGENTS.md/CLAUDE.md files
  are regenerated by `next dev`, so seeing them in a diff is normal — commit them with the
  work rather than reverting them.
- **The database under you is disposable.** Dev stacks are per-project and get torn down;
  one was destroyed mid-verification, taking 37k spans with it. Never build a claim on data
  you cannot regenerate, and prefer the seeded dataset from W12 over whatever happens to be
  running.
- **Update this plan when it is wrong.** It will be.
