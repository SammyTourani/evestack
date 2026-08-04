/* Single source of every user-facing string, claim, and stat on the site.
   THE HONESTY CONTRACT: every number and factual claim here must be traceable
   to /FINDINGS.md (verified by running the stack) or to shipped code.
   Do not add marketing claims that cannot be reproduced on a clean machine.

   NOTE: the site must not be deployed publicly until `create-evestack` and the
   GitHub repo are published — the hero command and GitHub links assume both. */

export const site = {
  name: "evestack",
  mark: "▚",
  title: "evestack — the open replacement for Vercel Agent Runs",
  tagline: "The open replacement for Vercel Agent Runs.",
  subhead:
    "A fully free, self-hosted distribution of the eve agent framework. Durable sessions, sandbox, dashboard — one command. No Vercel account. No metered compute.",
  eyebrow: "Open source · Apache-2.0",
  command: "npx create-evestack",
  github: "https://github.com/evestack/evestack",
  attribution:
    "evestack is built on vercel/eve (Apache-2.0). Not affiliated with Vercel.",
  motto: "Nothing here phones home.",
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
  caption: "One command scaffolds it. $0 runs it.",
} as const;

/* §4 comparison — answers eve.dev's own managed-vs-self-hosted table.
   Their docs name the self-host path; evestack ships it. */
export const comparison = {
  heading: "Everything Vercel hosts. Nothing Vercel holds.",
  sub: "eve is Apache-2.0 and runs entirely without a Vercel account. evestack packages the self-hosted column their docs describe — and adds the dashboard they kept.",
  columns: ["", "Vercel hosted", "evestack"],
  rows: [
    ["Account required", "Vercel account", "None"],
    ["Compute", "Metered", "Your machine — $0.00"],
    ["Agent state", "Managed workflow store", "Your Postgres on :5433"],
    ["Trace retention", "Platform-defined", "Unbounded — your database"],
    ["Agent Runs dashboard", "Read-only, hosted", "Observe and control, self-hosted"],
    ["Approve gated tools", "—", "From your browser"],
    ["Telemetry", "Platform", "Nothing here phones home"],
    ["License", "Proprietary dashboard", "Apache-2.0, all of it"],
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
      title: "Full-depth tracing",
      body: "agent.session down to every model stream, streamed to your own dashboard over OTLP. The span tree is the product.",
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
  heading: "One compose file. Zero services you rent.",
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

/* §8 observability — the span tree verbatim from a live run (FINDINGS.md). */
export const observability = {
  heading: "The dashboard Vercel kept. Yours now.",
  sub: "Session list, full span trees, token rollups, computed cost — read straight from your own Postgres. This is the Agent Runs tab, without the account.",
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
  sub: "Agent Runs shows you what happened. evestack lets you decide what happens next — approve or deny gated tool calls, start sessions, and chat, from the browser.",
  demo: {
    tool: "send_email",
    args: '{ "to": "team@…", "subject": "Deploy done" }',
    states: ["requested", "approved", "executed"] as const,
  },
} as const;

/* §11 integrations — brand marks are nominative use (services the agent
   connects to); SVGs generated locally by scripts/gen-logos.mjs. Slack's
   mark was removed from simple-icons at the brand's request → text only. */
export const integrations = {
  heading: "Your tools, one click",
  sub: "Composio connects the agent to Gmail, GitHub, Slack, Notion, Linear, and hundreds more — sign in once from the dashboard.",
  chips: [
    { name: "Gmail", slug: "gmail" },
    { name: "GitHub", slug: "github" },
    { name: "Notion", slug: "notion" },
    { name: "Linear", slug: "linear" },
    { name: "Google Calendar", slug: "googlecalendar" },
    { name: "Slack" },
    { name: "Airtable", slug: "airtable" },
    { name: "Discord", slug: "discord" },
    { name: "Jira", slug: "jira" },
    { name: "HubSpot", slug: "hubspot" },
    { name: "Stripe", slug: "stripe" },
    { name: "…and hundreds more" },
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
      body: "eve dev on :2000. Nothing here bills you — no Vercel account, no metered compute.",
    },
  ],
} as const;

export const closing = {
  heading: "Own your agent stack today.",
  sub: "One command. Your servers. $0.",
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
      { label: "GitHub", href: site.github },
      { label: "License — Apache-2.0", href: `${site.github}/blob/main/LICENSE.txt` },
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
