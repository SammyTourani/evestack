# Wave 2 brief — W2 substrate and W3 design system

Prepared while W1 remediation ran. This is the input to the Wave 2 workflow, kept here
so the reasoning survives the workflow script.

## Why these two run together

They meet at the chart props and touch no common file: W2 is Postgres and TypeScript
under `lib/` and `sql/`, W3 is Tailwind and React under `app/globals.css` and a new
`components/` tree. Everything after them depends on both.

## The one real interaction, and how it is handled

Tailwind 4's preflight resets element styles. `app/globals.css` today is 207 lines of
hand-rolled CSS that every existing page depends on, so adding `@import "tailwindcss"`
naively changes the appearance of ten shipped pages at once and nobody can tell a port
error from an intended change.

So W3's first agent owns exactly one job: **adopt Tailwind without changing how a single
existing page looks.** The check is mechanical — capture the rendered HTML and computed
styling of every page before and after, and account for every difference. Only once that
is clean do the primitives land on top. This is the same discipline as W1: correctness
first, appearance second, and never both in one step.

## W2 · Substrate

**fact_turn** — one row per turn. Identity (session, turn, agent, environment, channel,
trigger, model, provider), timing (duration, TTFT, time-per-output-chunk, tokens/sec),
tokens split four ways, cost decomposed Datadog-style (input / output / cache_read /
cache_write / reasoning), step and retry counts, tools offered vs called, finish reason,
error, plus two fields nothing else has:

```
outcome        ok | failed | no_model_call | cancelled | budget_stopped | wedged
span_coverage  none | partial | full
```

`outcome` must adopt the definition already in `lib/monitors.ts` — `error_code` plus
finished-turns-with-no-`$eve.model`, counted separately. That module is the source of
truth and W1's fleet work already conformed to it. A third definition is a defect.

`span_coverage` exists because a metric computed over partial data must say so. It is the
field that stops a TTFT chart quietly averaging the 3% of turns that happened to export
spans and presenting it as the fleet.

**fact_tool_call** — one row per invocation: tool, session, turn, duration, ok/failed,
error class, arguments size, result size.

**Refresh** on the `workflow_runs.updated_at` watermark, not `created_at` — a run row is
mutated after insert as its status changes, so a created_at watermark silently misses
every completion.

**Verified 2026-08-06 against 171 real (non-seeded) runs in `my-agent-postgres-1`:**
world-postgres does maintain `updated_at`. 127 of 171 have moved past `created_at`,
**zero** have never moved, all 57 completed runs have moved, and 171 of 171 sit within
two seconds of their last known state change (`completed_at`, else `started_at`, else
`created_at`). The watermark is sound; the status-aware re-scan fallback this brief
previously called for is not needed. Build on `updated_at` directly.

One caveat worth designing for anyway: a watermark refresh must use `>=` with a dedupe,
not `>`, because several rows can share a timestamp at second granularity and a strict
`>` drops every row after the first at that instant.

**Query API** — one endpoint shaped like Langfuse's, which is proven and MIT:
`{view, measures, dimensions, filters, timeDimension, orderBy, limit}`. Once this exists
a new chart is a config object rather than a code change, which is the entire point of
the wave.

## W3 · Design system

Verified wiring to copy from `packages/website`: `tailwindcss@^4.1`,
`@tailwindcss/postcss@^4.1`, `postcss@^8.5` in devDependencies; a one-line
`postcss.config.mjs`; `@import "tailwindcss"` plus `@theme` blocks in `app/globals.css`;
`geist@^1.7` via `geist/font/sans` and `geist/font/mono`. Both packages are already on
Next 16.3.0 and React 19.2.8, so this is a copy, not a port.

Tremor is **vendored, not installed** — `@tremor/react` stable peer-deps React 18 and the
v4 beta was abandoned five weeks before Vercel acquired them.

Primitives: timeseries, stacked area, bar, horizontal bar / top-list, distribution
histogram, heatmap, sparkline, query-value tile with period-over-period delta. Plus the
interaction Vercel Observability is the reference for: drag-to-select then Zoom In, and a
ranked list under every chart that re-sorts by error rate or duration.

Three conventions the current UI gets right and must not lose: an unpriced model never
renders `$0.00`; a metric over partial data says so; an absent value is an em dash, never
a zero.

Accessibility is built in, not retrofitted: keyboard equivalents for every mouse
interaction, focus-visible on the token layer, series distinguishable without hue alone,
and charts that expose their numbers to a screen reader rather than being an unlabelled
`<svg>`.

## Standing hazards for every agent in this wave

- Another Claude session edits `packages/create-evestack/**` in this same checkout. Not
  yours, not a defect, never revert it.
- `node_modules` gets churned by that session; `pnpm install` at the root fixes it.
- Never pipe `scripts/seed.mjs` into `head` — SIGPIPE truncates it mid-write and the
  failure looks like malformed JSON.
- The W1 lesson to expect in your own work: the dominant defect class was **code that
  does nothing**. An inert parameter, a function with no readers, a column nothing
  selects, a test asserting a dead branch back to itself. Delete rather than justify.
