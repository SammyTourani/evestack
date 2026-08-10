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
  /* ONE COMMAND, and the whole page has to mean the same thing by it.
     `npx evestack create` asks four questions; the fourth is "bring it up?", and
     yes starts Postgres, creates the schema, pulls the dashboard and then offers
     to run the agent too (packages/create-evestack/create.mjs:462-478, :746-808).
     So one command is literally true. Say no and it prints FOUR commands
     (create.mjs:770-780) — that is the only other number allowed on this page,
     and it is always labelled as the manual path. The page previously said one,
     three, four and five in five different places.
     "1,000+" not "1,070": we counted 1,070 toolkits against Composio's
     GET /api/v3/toolkits on 2026-08-04 and their public directory listed 1,069
     five days later, so an exact figure is stale on arrival. */
  subhead:
    "Durable sessions, sandboxing, memory, approvals, schedules, 1,000+ tool integrations, and a dashboard that drives the agent. One command scaffolds it and offers to bring it up.",
  eyebrow: "Open source · Apache-2.0",
  command: "npx evestack create",
  github: "https://github.com/SammyTourani/evestack",
  /* Was "… tested against every eve release since 0.29.5". Every package here
     declares `eve: ">=0.30.0 <1.0.0"`, which EXCLUDES 0.29.5 — they will not
     install against it, so the sentence claimed testing on a version the code
     refuses to run on. The contract suite is the real, checkable claim. */
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

/* The stats strip says "measured in Postgres — see FINDINGS.md" and never said
   where FINDINGS.md is. It is at the repo root; now it is one click away. */
export const findingsUrl = `${site.github}/blob/main/FINDINGS.md`;

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
   create-evestack prints, the standard Postgres ready log, and the verified
   re-enqueue line from FINDINGS.md. `cmd` rows are typed commands; dim rows
   are summaries, ok rows are real output.

   THESE MUST BE THE COMMANDS THE SCAFFOLDER PRINTS, and for a long time two of
   them were not:

     - `npx --package=@workflow/world-postgres bootstrap`. It looks equivalent
       to the project's own script and is not: upstream's CLI loads `.env`
       through dotenv and never reads `.env.local`, which is the only place the
       generated connection string exists. Run in a real scaffolded project it
       dials `postgres://…@localhost:5432/world` and dies on
       `role "world" does not exist`. create.mjs has carried a comment about
       this for a while; this file never got the message, so the first code
       block a visitor sees was the one command guaranteed to fail. It is
       `npm run db:bootstrap`, which wires .env.local in explicitly.
     - `pnpm dev`. A scaffolded project is an npm project with a `dev` script.
       pnpm is correct inside this repository and nowhere a visitor will be.

   Anything typed here should be copy-pasteable into a fresh project and work.
   If it cannot be, it does not belong in the artwork. */
export const terminal = {
  prompt: "npx evestack create",
  lines: [
    { text: "… prompts for a model key, writes .env.local, installs deps", kind: "dim" as const },
    { text: "docker compose up -d postgres", kind: "cmd" as const },
    { text: "evestack-postgres-1 | database system is ready to accept connections", kind: "ok" as const },
    { text: "npm run db:bootstrap", kind: "cmd" as const },
    { text: "Schema created.", kind: "ok" as const },
    { text: "npm run dev", kind: "cmd" as const },
    { text: "eve dev ready on http://localhost:2000", kind: "ok" as const },
    { text: "[world-postgres] Re-enqueued 2 active run(s) on startup", kind: "ok" as const },
  ],
  caption: "One command scaffolds it, and offers to bring it up for you.",
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
  /* The trailing clause was "… and tested against every eve release since
     0.29.5" — the same sentence deleted from `site.attribution` above, for the
     same reason: every publishable package declares `eve: ">=0.30.0 <1.0.0"`,
     which excludes 0.29.5, so it claimed testing on a version the code refuses
     to install against. It was fixed in one field and left standing here, and
     shipped live for four days. Both now say the checkable thing instead. */
  sub: "eve is Apache-2.0 and Vercel documents self-hosting it. evestack ships that path end to end: the durable store, the sandbox, and the dashboard, wired together and pinned to eve by a contract suite that runs on every commit.",
  columns: ["", "Managed", "Self-hosted with evestack"],
  rows: [
    ["Runs on", "Vercel's infrastructure", "Your machine, VPS, or cluster"],
    ["Session state", "Vercel Workflows", "Your Postgres on :5433"],
    ["Run history", "Retained by the platform", "As long as you keep the rows"],
    ["Dashboard", "Agent Runs, hosted", "Included, and it drives the agent"],
    ["Where your data sits", "Vercel's platform", "Inside your network, always"],
    ["Setup", "Deploy to Vercel", "npx evestack create, which offers to bring it up"],
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
      /* Was "Full-depth tracing … The span tree is the product.", corrected
         down to "queryable today, not yet rendered as a view" on the grounds
         that "no dashboard page renders any of it yet". That correction has
         since gone stale in the other direction: app/traces/[id]/page.tsx:72-74
         calls the exact three functions this comment named as unrendered —
         getSpanTree, listModelCalls, listToolCalls — and app/traces/page.tsx
         renders the overview, with Traces in the nav. Claim the screen now. */
      title: "Full-depth trace ingest",
      body: "agent.session down to every model stream, exported to your own OTLP endpoint and stored in your Postgres — prompts and tool arguments included, and rendered as a span tree you can open per session.",
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

   This section once rendered a fabricated "Observability / Monitors" screen:
   p50/p75/p95/p99 chips, error and timeout rates, a runs-over-time chart,
   session search and pagination, captioned "read straight from your own
   postgres" while none of it existed.

   THAT NOTE THEN WENT STALE IN BOTH DIRECTIONS, which is worth recording
   because a stale honesty note is its own honesty defect — it is read as
   current and it is not.

   First it under-claimed. `cfbff14` built app/monitors/page.tsx and
   lib/monitors.ts and made most of the picture true: percentile_cont
   p50/p75/p95/p99, an error rate that counts turns carrying an error_code
   separately from finished turns that never reached a provider, a width_bucket
   runs-over-time series, and a 1h/6h/12h/24h/7d window. Monitors and Traces are
   both in the nav. Search and pagination exist. The grep the old note told you
   to run now returns matches, so run it rather than trusting this paragraph.

   Then it over-claimed. The two things the artwork advertised that were never
   built — a TIMEOUT rate, and per-row activity sparklines on the sessions table
   — are gone from components/sections/monitors-panel.tsx rather than added to
   the dashboard, on the same grounds the comparison table lost its Passport row.
   eve does not distinguish a timeout in error_code, so that figure could only
   have been invented; the sparkline series was `s.tokensOut % 37`, shaped like
   data and derived from nothing.

   So the mock and the product now agree, and the honest way to keep them that
   way is the order cfbff14 used: build it in packages/dashboard first, then
   draw it here.

   It is replaced by packages/website/public/screenshots/*, captured from the
   dashboard in this repo. Every claim below names a file that renders it. */
export const observability = {
  heading: "Every session, read straight from your own Postgres.",
  sub: "Session list, run trees, token rollups, and a cost we compute ourselves — the same $eve.* data your agent already writes, queried from the database you own. No ingest pipeline to keep in sync.",
  /* Each of these is a shipped file, named so the claim is checkable. */
  capabilities: [
    {
      /* The source path moved and the claim had to move with it. Dashboard v2
         made app/page.tsx an overview of charts and monitors; the session list
         is its own page now. Leaving the old path here would have broken the one
         rule this list has — that naming the file is what makes the claim
         checkable — by pointing a reader at a file that renders something else. */
      title: "Session list",
      body: "Every agent run on the machine, with outcome, trigger, model, provider, environment and turns. Searchable, filterable by facet, sortable, and exportable as CSV.",
      source: "packages/dashboard/app/sessions/page.tsx",
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
    /*
     * Recaptured after the dashboard redesign, against a live agent.
     *
     * The alt text is precise about figures on purpose — that is what makes it
     * checkable, and it is also what makes it go stale. The previous pair
     * described "30 sessions, 42 turns, 207,300 in / 17,804 out tokens" above a
     * grid of tiles, which was the OVERVIEW: dashboard v2 moved the tiles to `/`
     * and made this the session list, so the words and the picture had come
     * apart. Both are read off the new capture.
     *
     * The heights are 1800 rather than the old 1560/1360 because the restyled
     * pages fill the viewport — scripts/optimize-images.mjs measures where the
     * content ends now instead of carrying a remembered number, and it reports
     * no crop for any of the four.
     */
    sessions: {
      name: "sessions",
      width: 2880,
      height: 1800,
      alt: "The evestack dashboard's Sessions page: a red banner reading '8 sessions wedged — a turn started and never finished, nothing in eve will notice or retry it' with links to each, above a searchable table of 250 real runs showing outcome, trigger, model, provider, environment, run type and turn count. Rows span openai/gpt-5-mini, anthropic/claude-sonnet-5, ollama/qwen3 and acme/experimental-v1, with two 'failed' rows in red among the 'ok' ones.",
      caption: "Sessions — the dashboard in this repo, captured running against a live agent.",
    },
    detail: {
      name: "session-detail",
      width: 2880,
      height: 1800,
      alt: "A session detail page in the evestack dashboard: a scheduled run titled 'Write a detailed essay about database indexing', completed, open 1m 45s end to end, with tiles reading 4 turns, 28.5s turn time, 73,077 tokens in, 6,192 out and $0.02 spend. Below, a timeline of all four turns with their durations and costs, and turn 1 of 4 on openai/gpt-5-mini expanded to show 6.08s duration, 2.47s to first chunk, an output rate of 343.1 tokens per second, 15,223 tokens in, 2,088 out, 7,744 cache writes, 5 steps, 0 retries and 18 tools offered against 0 called.",
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
   named in copy, no chip. "1,000+ toolkits" is the count every evestack surface
   uses; see the note in site.subhead above for why it is not an exact figure.
   hub.calls are action names taken verbatim from evestack-composio's
   source — nothing invented. */
export const integrations = {
  heading: "Your tools, one click",
  sub: "Composio wires the agent into 1,000+ toolkits — Gmail, GitHub, Slack, Notion, Linear, and everything after. Sign in once from the dashboard.",
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

/* §12 quickstart — the pipeline and the receipt.

   The steps render as a self-completing pipeline (stations flip ✓, a spine
   draws down) beside a "receipt": the output of a first `npm run verify`,
   line for line. Nothing here is typed or invented — the premium convention
   (and ours) is finished, real artifacts:

     - each step's receipt line is verbatim from the tool that prints it
       (packages/create-evestack/create.mjs ok() lines, templates/default/
       scripts/bootstrap.mjs, the eve dev ready line from FINDINGS.md);
     - the verify panel mirrors templates/default/scripts/verify.mjs exactly —
       the openai path, which is the scaffolder's option 1 with its default
       model. That run prints these ELEVEN checks. The count has been wrong here
       three times: first a plain miscount, then "nine, and the ollama path adds
       a tenth (`memory`)" — wrong, because verify.mjs:275-276 passes `memory` on
       the openai path too as soon as OPENAI_API_KEY is set
       (`embeddings via openai/text-embedding-3-small`) — and then ten, which
       silently dropped the last one verify.mjs emits on a healthy run. The check
       list is identical on both paths; only memory's detail line differs.
       docs/cli.mdx says eleven and names the eleventh. So no step body counts
       the checks: if this array and verify.mjs ever disagree again, the array is
       the one that is wrong.
     - the agent answers on 127.0.0.1 and the dashboard is printed as
       localhost — that asymmetry is real (verify.mjs builds the dashboard
       URL for a human to click, findAgent probes loopback).

   `commands` splits each line so the payload renders bright over dim
   boilerplate (the opencode/Convex/Bun convergence).

   NO COMMAND COUNT IN THIS SECTION'S COPY. It used to say "Five commands", the
   closing section said "Five commands", the compare table said "then four
   commands" and section 01 said "three commands" — four numbers for one job,
   and not one of them mentioned that answering yes to the scaffolder's fourth
   question does the middle steps for you. The rows below are the manual path,
   shown rather than counted; the count that matters is in the hero. */
export const quickstart = {
  heading: "Running in four steps",
  sub: "The manual path, with its real receipts — the scaffolder offers to do the middle two for you.",
  /* No step bodies, deliberately: the receipt line under each command IS the
     explanation, in the tool's own words. Prose the panel already proves is
     prose the section does not need (user-tightened 2026-08-06). */
  steps: [
    {
      slug: "scaffold",
      title: "Scaffold",
      commands: [{ pre: "npx ", cmd: "evestack create" }],
      /* The scaffolder's last ok() before "Done." — picked over its longer
         `Generated .env.local with a unique auth password and trace-ingest
         token`, which wrapped to two lines and made this step taller than
         the rest. Every receipt is now one line, verbatim. */
      receipt: "Dependencies installed",
    },
    {
      slug: "postgres",
      title: "Durable Postgres",
      commands: [
        { pre: "docker ", cmd: "compose up -d postgres" },
        /* `npm run db:bootstrap`, never the upstream bootstrap bin — see the
           note on the terminal artwork above for what that one actually does. */
        { pre: "npm run ", cmd: "db:bootstrap" },
      ],
      receipt: "Schema created.",
    },
    {
      slug: "run",
      title: "Run your agent",
      commands: [{ pre: "npm run ", cmd: "dev" }],
      receipt: "eve dev ready on http://localhost:2000",
    },
    {
      slug: "verify",
      title: "Check it",
      commands: [{ pre: "npm run ", cmd: "verify" }],
      /* The rail's last receipt is the panel's payoff line — same run, and
         every receipt here is now a verbatim quote rather than a summary. */
      receipt: "Everything works.",
    },
  ],
  verify: {
    header: "evestack verify",
    checks: [
      { name: "config", detail: ".env.local" },
      { name: "docker", detail: "daemon is responding" },
      { name: "postgres", detail: "reachable at 127.0.0.1:5433" },
      { name: "schema", detail: "workflow tables exist" },
      { name: "pgvector", detail: "installed — long-term memory can store vectors" },
      { name: "model", detail: "openai/gpt-5-mini, OPENAI_API_KEY is set" },
      { name: "memory", detail: "embeddings via openai/text-embedding-3-small" },
      { name: "agent", detail: "answering at http://127.0.0.1:2000" },
      { name: "dashboard", detail: "answering at http://localhost:4000, database connected" },
      { name: "traces", detail: "the agent's ingest token is accepted by the dashboard" },
      { name: "dashboard image", detail: "0.4.0, matching the pin" },
    ],
    done: "Everything works.",
    dashboard: { label: "Your dashboard", value: "http://localhost:4000" },
    /* The real script prints the generated password here — a per-project
       secret, so the receipt masks it the way the demo masks API keys.
       (The script's closing curl snippet was rendered here once and cut for
       space at the user's call — restore from git if it earns its lines.) */
    signin: { label: "Sign in", user: "evestack", mask: "••••••••••" },
    prompt: "Open the dashboard now? (Y/n)",
    /* Bun links its install script; the receipt links its own source. */
    source: {
      label: "verify.mjs",
      href: `${site.github}/blob/main/templates/default/scripts/verify.mjs`,
    },
  },
  /* The 2026 install path (Convex, Clerk, better-auth all ship one): the
     machine-readable summary really is served at /llms.txt (app/llms.txt). */
  agent: {
    lead: "For coding agents:",
    display: "evestack.vercel.app/llms.txt",
    copy: "https://evestack.vercel.app/llms.txt",
  },
} as const;

export const closing = {
  heading: "Your agents, on your infrastructure.",
  sub: "One command, and it offers to bring the whole thing up.",
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
