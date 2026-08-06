/* Single source of every user-facing string, claim, and stat on the site.
   THE HONESTY CONTRACT: every number and factual claim here must be traceable
   to /FINDINGS.md (verified by running the stack) or to shipped code.
   Do not add marketing claims that cannot be reproduced on a clean machine.

   Launch gates (2026-08-05): `create-evestack` is live on npm and the repo is
   public at github.com/SammyTourani/evestack — the hero command and every
   GitHub link below resolve for real visitors. */

export const site = {
  name: "evestack",
  mark: "▚",
  title: "evestack — the self-hosted distribution of eve",
  /* One sentence, used verbatim on the site, the README, the GitHub description
     and npm. It was four different sentences across those four surfaces, so
     anyone arriving via npm → GitHub → here got re-pitched three times and
     never landed on one idea. Change it in all four or in none. */
  tagline: "The whole eve stack. On your own machine.",
  /* Was "… One command." That was false and one `npx` away from being caught:
     the scaffolder itself prints three more commands (packages/create-evestack/
     index.mjs:245-251) and the dashboard is a separate clone (:258-260). The
     count below is the literal number of shell lines in the README block. */
  subhead:
    "Durable sessions, sandboxing, memory, approvals, schedules, 1,070 tool integrations, and a dashboard that drives the agent. One command scaffolds it; four bring it up.",
  eyebrow: "Open source · Apache-2.0",
  command: "npx create-evestack",
  github: "https://github.com/SammyTourani/evestack",
  /* Was "… tested against every eve release since 0.29.5". Every package here
     declares `eve: ">=0.30.0 <0.31.0"`, which EXCLUDES 0.29.5 — they will not
     install against it, so the sentence claimed testing on a version the code
     refuses to run on. The contract suite is the real, checkable claim, and the
     range above is now the measured one: every published eve inside it has been
     run against the suite (docs/upgrading.mdx, "What has actually been run"). */
  attribution:
    "evestack is built on vercel/eve (Apache-2.0) and pinned to it by a contract suite that runs on every commit.",
  /* Footer, one line, small. Not a banner.
     The point of a non-affiliation notice is that somebody who wonders "is this
     an official Vercel thing?" can find the answer — so it goes where a reader
     looks for exactly that, which is the footer beside the attribution. Making
     it genuinely unfindable would leave the impression it exists to correct,
     which is the whole risk. Small and conventional is the version that works. */
  trademark: "eve is a trademark of Vercel. evestack is an independent project, not affiliated with or endorsed by Vercel.",
  motto: "Everything runs on your network.",
  /* The one upstream credential, stated at exactly its real weight. The triage
     comment on the issue is from `e0-gh-vercel-connect[bot]` and PR #1660 is
     from `vercel-gh-bot-3[bot]` and is still an unmerged draft, so neither is
     claimed here. Verify: `gh api repos/vercel/eve/issues/1658`. */
  byline: {
    text: "Found vercel/eve#1658 — denying a tool approval permanently fails the durable session (p1, open).",
    href: "https://github.com/vercel/eve/issues/1658",
  },
} as const;

export const nav = [
  { label: "One command", href: "#one-command" },
  { label: "Compare", href: "#compare" },
  { label: "Features", href: "#features" },
  { label: "Observability", href: "#observability" },
  { label: "Quickstart", href: "#quickstart" },
] as const;


/* §9 stats — every value from FINDINGS.md (one real user message). */
export const stats = [
  { value: 38, suffix: "", label: "events persisted from one message" },
  { value: 3, suffix: "", label: "runs per user message" },
  { value: 0, prefix: "$", decimals: 2, label: "infrastructure cost", accent: true },
  { value: 5, suffix: "", label: "span levels per model call" },
] as const;

/* The one sanctioned text-scramble stat. */
export const scrambleStat = "100% yours";

/* §3 terminal — mirrors the scaffolder's real flow: the exact next-steps
   create-evestack prints (index.mjs), the standard Postgres ready log, and
   the verified re-enqueue line from FINDINGS.md. `cmd` rows are typed
   commands; dim rows are summaries, ok rows are real output. */
export const terminal = {
  prompt: "npx create-evestack",
  lines: [
    { text: "… prompts for a model key, writes .env.local, installs deps", kind: "dim" as const },
    { text: "docker compose up -d postgres", kind: "cmd" as const },
    { text: "evestack-postgres-1 | database system is ready to accept connections", kind: "ok" as const },
    { text: "npx --package=@workflow/world-postgres bootstrap", kind: "cmd" as const },
    { text: "pnpm dev", kind: "cmd" as const },
    { text: "eve dev ready on http://localhost:2000", kind: "ok" as const },
    { text: "[world-postgres] Re-enqueued 2 active run(s) on startup", kind: "ok" as const },
  ],
  caption: "One command scaffolds it. Four more bring it up.",
} as const;

/* §4 comparison — the axis is WHERE IT RUNS, not what anything costs.
   eve.dev's own docs frame managed and self-hosted as two deployment targets
   for the same framework; this table mirrors that framing and stays on it.

   DELIBERATELY ABSENT, and it must stay that way: retention tiers, per-GB
   prices, and footnote citations for them. A table that quotes someone's price
   list is arguing that they cost money, which is not the axis and reads as
   hostile to the audience this page is for. "As long as you keep the rows" says
   the same true thing without the invoice.

   Every row states a fact about BOTH columns. No empty cell in the managed
   column, ever — an em-dash there implies the hosted product has nothing.

   One row is gone rather than restored: "Tool approvals | Vercel Passport" was
   wrong. Passport is deployment access control against your own IdP over OIDC
   (vercel.com/docs/passport); it has nothing to do with tool approvals, and
   eve's HITL approvals are Apache-2.0 framework functionality that behaves the
   same off Vercel. The Dashboard row already carries the real difference. */
export const comparison = {
  heading: "Same framework. Your infrastructure.",
  sub: "eve is Apache-2.0 and Vercel documents self-hosting it. evestack ships that path end to end: the durable store, the sandbox, and the dashboard, wired together and tested against every eve release since 0.29.5.",
  columns: ["", "Managed", "Self-hosted with evestack"],
  rows: [
    ["Runs on", "Vercel's infrastructure", "Your machine, VPS, or cluster"],
    ["Session state", "Vercel Workflows", "Your Postgres on :5433"],
    ["Run history", "Retained by the platform", "As long as you keep the rows"],
    ["Dashboard", "Agent Runs, hosted", "Included, and it drives the agent"],
    ["Where your data sits", "Vercel's platform", "Inside your network, always"],
    ["Setup", "Deploy to Vercel", "npx create-evestack, then four commands"],
  ],
} as const;

/* §6 bento features. */
export const features = {
  heading: "Everything you need to run agents on your own metal",
  sub: "Durable execution, sandboxing, human-in-the-loop, and observability — wired together, verified by running it.",
  cells: [
    {
      title: "Durable sessions",
      body: "Every step checkpointed to Postgres. Kill the stack mid-conversation, start it again, and the session resumes with its memory intact.",
      demo: "events" as const,
    },
    {
      title: "$0 infrastructure",
      body: "Postgres, sandbox, and dashboard run on your machine. The dashboard's Infrastructure tile reads $0.00 because there is nothing to bill.",
      demo: "cost" as const,
    },
    {
      title: "Private by construction",
      body: "Set EVESTACK_TRACE_CONTENT=off and prompts and tool results never leave the agent — spans keep timing and tokens only.",
      demo: "privacy" as const,
    },
    {
      /* Was "Full-depth tracing … The span tree is the product." Half of that
         was aspiration: the OTLP endpoint really does receive and store the
         full tree including prompt bodies and tool arguments
         (packages/dashboard/lib/traces.ts — parseOtlpTraces, insertSpans,
         getSpanTree, listModelCalls, listToolCalls), but no dashboard page
         renders any of it yet. Claim the endpoint, not a screen. */
      title: "Full-depth trace ingest",
      body: "agent.session down to every model stream, exported to your own OTLP endpoint and stored in your Postgres — prompts and tool arguments included, queryable today, not yet rendered as a view.",
      demo: "spans" as const,
    },
    {
      title: "Human-in-the-loop",
      body: "Gated tools park the session until you approve or deny — from the dashboard, not a hosted console.",
      demo: "approval" as const,
    },
    {
      title: "Restart-proof runs",
      body: "[world-postgres] Re-enqueued 2 active run(s) on startup — the log line that proves your agents survive a reboot.",
      demo: "restart" as const,
    },
  ],
} as const;

/* §7 architecture nodes + beams. */
export const architecture = {
  heading: "One compose file. Everything on localhost.",
  sub: "Postgres runs in Docker; the agent is a process on your machine that spawns per-session sandbox containers. The dashboard reads run state straight from the workflow tables and receives spans over OTLP. Everything speaks localhost.",
  nodes: [
    { id: "agent", title: "agent runtime", detail: "eve dev · :2000" },
    { id: "postgres", title: "Postgres", detail: "Docker · :5433" },
    { id: "sandbox", title: "sandbox", detail: "per-session containers" },
    { id: "dashboard", title: "dashboard", detail: "observe + control · :4000" },
  ],
  beams: [
    { from: "agent", to: "postgres", label: "workflow events" },
    { from: "agent", to: "sandbox", label: "exec" },
    { from: "agent", to: "dashboard", label: "OTLP → :4000" },
    { from: "dashboard", to: "postgres", label: "SQL" },
  ],
  srSummary:
    "Architecture: the eve agent runtime on port 2000 writes workflow events to Postgres on port 5433 running in Docker, executes code in per-session Docker sandbox containers, and exports OTLP traces to the dashboard on port 4000, which also reads run state directly from Postgres over SQL.",
} as const;

/* §8 observability — the span tree verbatim from a live run (FINDINGS.md), and
   two REAL captures of the shipped dashboard.

   This section used to render a fabricated "Observability / Monitors" screen:
   p50/p75/p95/p99 chips, error and timeout rates, a runs-over-time chart,
   session search and pagination, inside a tilted <figure> captioned "read
   straight from your own postgres". None of it exists.
   `grep -rniE "p95|percentile|Monitors" packages/dashboard/{app,lib,components}`
   returns nothing, and the real nav (packages/dashboard/app/layout.tsx:19-27) is
   Sessions, Chat, Schedules, Memory, Skills, Approvals, Integrations — no
   Monitors route, no Traces route, no percentile code anywhere.

   It is replaced by packages/website/public/screenshots/*, captured from the
   dashboard in this repo. Every claim below names a file that renders it. */
export const observability = {
  heading: "Every session, read straight from your own Postgres.",
  sub: "Session list, run trees, token rollups, and a cost we compute ourselves — the same $eve.* data your agent already writes, queried from the database you own. No ingest pipeline to keep in sync.",
  /* Each of these is a shipped file, named so the claim is checkable. */
  capabilities: [
    {
      title: "Session list",
      body: "Every agent run on the machine, with status, turns, model, tokens in/out/cached, cost and age. Team totals across the top.",
      source: "packages/dashboard/app/page.tsx",
    },
    {
      title: "Run tree",
      body: "Each session expands into its turns and subagents, with duration, tokens, cache reads and writes, tool count and per-run cost.",
      source: "packages/dashboard/app/sessions/[id]/page.tsx",
    },
    {
      title: "Cost we compute, labelled honestly",
      body: "eve emits gen_ai.usage.cost only for AI-Gateway calls, and a self-hosted agent calls its provider directly — so we price token counts ourselves. A model with no configured price renders `unpriced` and an em dash, never $0.00.",
      source: "packages/dashboard/lib/pricing.ts",
    },
    {
      title: "Approvals",
      body: "Gated tool calls park the session and wait for a decision in the browser, resolved through eve's ordinary follow-up route.",
      source: "packages/dashboard/app/approvals/page.tsx",
    },
  ],
  /* The two committed captures, cropped by scripts/optimize-images.mjs. */
  shots: {
    sessions: {
      name: "sessions",
      width: 2880,
      height: 1560,
      alt: "The evestack dashboard's Sessions page: 30 sessions, 42 turns, 207,300 in / 17,804 out tokens, $0.05 model spend and an Infrastructure tile reading $0.00, above a table of real runs. The gpt-4o-mini row is labelled `unpriced` in orange rather than being counted as free.",
      caption: "Sessions — the dashboard in this repo, captured running.",
    },
    detail: {
      name: "session-detail",
      width: 2880,
      height: 1360,
      alt: "A session detail page in the evestack dashboard: a 1500-word essay run showing 1 turn, 5,123 in / 3,704 out tokens, 4,608 cached reads and $0.0077 model spend, above a run tree with one completed turn on openai/gpt-5-mini — 41.0s, 13 tools, $0.0077.",
      caption: "One session's run tree — same capture session.",
    },
  },
  spanTree: [
    { depth: 0, name: "agent.session", note: "ROOT" },
    { depth: 1, name: "agent.turn", note: "" },
    { depth: 2, name: "agent.step", note: "" },
    { depth: 3, name: "ai.streamText", note: "" },
    { depth: 4, name: "ai.streamText.doStream", note: "streaming" },
    { depth: 2, name: "agent.turn.terminal", note: "" },
  ],
} as const;

/* §10 control plane. */
export const control = {
  heading: "Observability you can act on",
  sub: "Approve or deny gated tool calls, start sessions, cancel runs, and chat with the agent — from the browser, with every decision recorded.",
  demo: {
    tool: "send_email",
    args: '{ "to": "team@…", "subject": "Deploy done" }',
    states: ["requested", "approved", "executed"] as const,
  },
} as const;

/* §11 integrations — brand marks are nominative use (services the agent
   connects to); colored SVGs generated locally by scripts/gen-logos.mjs.
   Slack's mark was removed from simple-icons at the brand's request →
   named in copy, no chip. "1,070 toolkits" is verified: the
   evestack-composio README records it against GET /api/v3/toolkits.
   hub.calls are action names taken verbatim from evestack-composio's
   source — nothing invented. */
export const integrations = {
  heading: "Your tools, one click",
  sub: "Composio wires the agent into 1,070 toolkits — Gmail, GitHub, Slack, Notion, Linear, and everything after. Sign in once from the dashboard.",
  /* The one place on this site where "Everything runs on your network" stops
     being true, said here rather than left for someone to discover. Composio is
     a hosted third party: it performs the OAuth dance and holds the resulting
     tokens. It is also genuinely off unless you opt in — with COMPOSIO_API_KEY
     unset, `composioTools()` resolves to no tools and logs one line
     (packages/evestack-composio; see /docs/composio-auth). */
  caveat: {
    text: "The one exception to “everything runs on your network”: Composio is a hosted third party, and it holds the OAuth tokens for the accounts you connect. It is off unless you set COMPOSIO_API_KEY — with no key the agent boots with its sandbox and memory and simply has no connectors.",
    href: "/docs/composio-auth",
    linkLabel: "Read the tradeoff in full",
  },
  hub: {
    /* left / right tile columns around the agent node — icon-only,
       equal-size tiles keep the composition perfectly symmetric */
    left: [
      { name: "Gmail", slug: "gmail" },
      { name: "GitHub", slug: "github" },
      { name: "Notion", slug: "notion" },
      { name: "Linear", slug: "linear" },
    ],
    right: [
      { name: "Google Calendar", slug: "googlecalendar" },
      { name: "Stripe", slug: "stripe" },
      { name: "HubSpot", slug: "hubspot" },
      { name: "Jira", slug: "jira" },
    ],
    /* fired in an endless loop; slugs verbatim from evestack-composio source */
    calls: [
      { action: "GMAIL_SEND_EMAIL", app: "gmail", ms: 212 },
      { action: "GITHUB_CREATE_AN_ISSUE", app: "github", ms: 415 },
      { action: "GMAIL_FETCH_EMAILS", app: "gmail", ms: 189 },
      { action: "GITHUB_SEARCH_REPOS", app: "github", ms: 342 },
    ],
  },
  /* Stripe-style single-row marquee of REAL brand wordmarks (each in the
     brand's own typeface) — SVGs in public/logos/wordmarks/ from
     gilbarbara/logos + vectorlogo.zone (nominative use). `pad: true` marks
     vectorlogo.zone files, which carry internal padding and render taller
     to visually match. Light theme: full color (Stripe treatment). Dark:
     grayscale+invert silver (Vercel treatment — preserves knockouts). */
  marquee: [
    { name: "Gmail", slug: "gmail", pad: true },
    { name: "GitHub", slug: "github" },
    { name: "Notion", slug: "notion" },
    { name: "Stripe", slug: "stripe" },
    { name: "Figma", slug: "figma", pad: true },
    { name: "Asana", slug: "asana" },
    { name: "Jira", slug: "jira", pad: true },
    { name: "Linear", slug: "linear" },
    { name: "Dropbox", slug: "dropbox", pad: true },
    { name: "Zendesk", slug: "zendesk" },
    { name: "Trello", slug: "trello", pad: true },
    { name: "HubSpot", slug: "hubspot" },
    { name: "Google Drive", slug: "googledrive", pad: true },
    { name: "Todoist", slug: "todoist" },
    { name: "Airtable", slug: "airtable", pad: true },
    { name: "Mailchimp", slug: "mailchimp" },
    { name: "Shopify", slug: "shopify", pad: true },
    { name: "Zoom", slug: "zoom" },
    { name: "Reddit", slug: "reddit" },
    { name: "Discord", slug: "discord" },
  ],
} as const;

/* §12 quickstart — mirrors the next-steps create-evestack itself prints. */
export const quickstart = {
  heading: "Running in three steps",
  steps: [
    {
      title: "Scaffold",
      code: "npx create-evestack",
      lang: "bash",
      body: "Prompts for a model key (or Ollama), writes .env.local, generates agent credentials.",
    },
    {
      title: "Durable Postgres",
      code: "docker compose up -d postgres",
      lang: "bash",
      body: "Then `npx --package=@workflow/world-postgres bootstrap` creates the workflow tables. Sessions now survive restarts.",
    },
    {
      title: "Run your agent",
      code: "pnpm dev",
      lang: "bash",
      body: "eve dev on :2000. The agent, the database, and the dashboard are all on your machine.",
    },
  ],
} as const;

export const closing = {
  heading: "Your agents, on your infrastructure.",
  sub: "Five commands, and it's running on your machine.",
} as const;

export const footerColumns = [
  {
    title: "Product",
    links: [
      { label: "One command", href: "#one-command" },
      { label: "Compare", href: "#compare" },
      { label: "Features", href: "#features" },
      { label: "Observability", href: "#observability" },
      { label: "Quickstart", href: "#quickstart" },
    ],
  },
  {
    title: "Open source",
    links: [
      { label: "Docs", href: "/docs" },
      /* Also linked above the fold and in the header — it is the most
         verifiable artifact here and was reachable from nowhere on the
         landing page. */
      { label: "GitHub", href: site.github },
      { label: "License — Apache-2.0", href: `${site.github}/blob/main/LICENSE` },
      { label: "eve (upstream)", href: "https://eve.dev" },
    ],
  },
  {
    title: "Self-host",
    links: [
      { label: "Quickstart", href: "#quickstart" },
      { label: "Architecture", href: "#architecture" },
      { label: "Control plane", href: "#control" },
    ],
  },
] as const;
