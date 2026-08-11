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
  title: "evestack: run AI agents on your own machine",
  /* One sentence, used verbatim on the site, the README, the GitHub description
     and npm. It was four different sentences across those four surfaces, so
     anyone arriving via npm → GitHub → here got re-pitched three times and
     never landed on one idea. Change it in all four or in none.

     REWRITTEN 2026-08-09 for launch. Was "The whole eve stack. On your own
     machine." — which required the reader to already know what eve is before
     they could evaluate this, and invited "so it's a stale copy of eve?" as
     the first question. Only 18 distinct GitHub accounts have ever filed a
     self-hosted eve issue, so leading with eve addresses ~18 people. The
     cadence is deliberately unchanged; only the word that gated comprehension
     moved. eve is now named where an engine belongs — under the hood, in
     `attribution` below and in §Compare. See ~/Desktop/evestack-launchkit/
     positioning.md. */
  /* PLAIN-ENGLISH PASS 2026-08-09, at Sammy's direction, and it is the launch
     kit's locked one-liner rather than a new invention:

       "Run AI agents on your own machine. One command gives you the whole stack."

     The page renders that one string across two elements — this is sentence
     one, `subhead` opens with sentence two — so the five surfaces that must
     carry the same one-liner still do. "The whole agent stack." led with a
     noun a reader has to decode; this leads with the verb, which is the thing
     they came to find out. */
  tagline: "Run AI agents on your own machine.",
  /* Was a list of eight nouns, six of them jargon: "Durable sessions,
     sandboxing, memory, approvals, schedules, 1,070 tool integrations, and a
     dashboard that drives the agent. One command scaffolds it and offers to
     bring it up."

     Nobody outside this repo says "scaffolds" or "bring it up", and a reader
     who does not already run this kind of infrastructure cannot tell what any
     of it buys them. Same four promises, said as a person would say them, and
     each one is a thing you can picture. */
  subhead:
    "One command gives you the whole stack. Your conversations are saved in a database you own, code runs in a safe sandbox, and a dashboard lets you watch every agent and approve anything risky before it happens.",
  /* THE WHY, which the page did not have (added 2026-08-11).
     A visitor read "Run AI agents on your own machine" and the next thought is
     "why would I want that instead of a hosted one?". The answer was on the
     page, but scattered across a features cell, another features cell, and a
     comparison table five sections down, so the reader had to assemble it. One
     line, at the moment the question forms.

     It names the reader rather than the feature. "Your prompts stay private"
     is a capability; "you do not want your prompts going through someone
     else's servers" is a person. */
  why: "For anyone who does not want their prompts, their data, or their agents running on someone else's servers.",
  eyebrow: "Free and open source · Apache-2.0",
  command: "npx evestack create",
  github: "https://github.com/SammyTourani/evestack",
  /* Was "… tested against every eve release since 0.29.5". Every package here
     declares `eve: ">=0.30.0 <1.0.0"`, which EXCLUDES 0.29.5 — they will not
     install against it, so the sentence claimed testing on a version the code
     refuses to run on. The contract suite is the real, checkable claim. */
  attribution:
    "evestack is built on eve, Vercel's open source agent framework. A test suite checks every commit against it, so evestack tracks new eve releases instead of drifting away from them.",
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
    text: "Found vercel/eve#1658: denying a tool approval permanently breaks the session (p1, open).",
    href: "https://github.com/vercel/eve/issues/1658",
  },
} as const;

/* Four items, all words a visitor already knows. "One command" named the
   section by its headline rather than by what is in it, "Observability" is a
   term you only reach for once you already own the problem, and "Compare"
   pointed at a table that now sits far enough down the page that advertising
   it up here was sending people the wrong way first. */
export const nav = [
  { label: "Setup", href: "#one-command" },
  { label: "Features", href: "#features" },
  { label: "Dashboard", href: "#observability" },
  { label: "How it works", href: "#architecture" },
] as const;


/* THE STATS STRIP IS GONE (2026-08-09). It read: 38 events persisted from one
   message · 3 runs per user message · $0.00 infrastructure · 5 span levels per
   model call.

   Every number was true and traceable to FINDINGS.md, and three of the four
   told a visitor nothing they could act on. "38 events persisted" is a fact
   about our implementation, not a benefit; a reader cannot tell whether 38 is
   good. Only the $0 landed, and that already has its own cell in the features
   grid, stated as "no hosting bill" where it means something. A row of
   impressive-looking numbers that do not survive the question "so what?" costs
   a full section of scroll and buys nothing.

   `scrambleStat` went with it; the one sanctioned text-scramble now lives
   inline in observability.tsx, which is where it was actually rendered. */

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
    { text: "… asks a few questions, saves your settings, installs everything", kind: "dim" as const },
    { text: "docker compose up -d postgres", kind: "cmd" as const },
    { text: "evestack-postgres-1 | database system is ready to accept connections", kind: "ok" as const },
    { text: "npm run db:bootstrap", kind: "cmd" as const },
    { text: "Schema created.", kind: "ok" as const },
    { text: "npm run dev", kind: "cmd" as const },
    { text: "eve dev ready on http://localhost:2000", kind: "ok" as const },
    { text: "[world-postgres] Re-enqueued 2 active run(s) on startup", kind: "ok" as const },
  ],
  caption: "One command sets it all up, then offers to start it for you.",
  /* WHAT AN AGENT ACTUALLY DOES, added 2026-08-11. The page described the
     machinery in detail and never once said what you would build with it. The
     only concrete tasks anywhere were rows inside the dashboard demo, which
     reads as UI furniture rather than as examples.

     These three are the demo's own rows, verbatim from lib/demo-data.ts, so
     the line and the table beside it are the same three jobs and a reader
     can see the claim land in the panel to its right. */
  examples: "People run things like: draft the release notes, send the deploy summary, summarize yesterday's error logs.",
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
/* REFRAMED AND MOVED DOWN 2026-08-09. It used to be §02, titled "Same
   framework. Your infrastructure.", and its opening sentence was "eve is
   Apache-2.0 and Vercel documents self-hosting it."

   That is a comparison against a product most visitors have never heard of,
   placed second on the page, written in words that only parse if you already
   know what eve is. For the reader this site is actually for, it was the
   earliest point at which the page stopped making sense.

   It is now §07, where a reader who has seen what the thing does is ready to
   ask "so why not just pay someone?", and it is retitled to that question. The
   sub is also where eve finally gets named and explained in one sentence,
   which is the right place for it: an engine, introduced once the car has been
   driven. */
export const comparison = {
  heading: "Run it yourself, or pay someone to run it",
  sub: "Both options use the same open source framework underneath. It is called eve, and Vercel builds it. The difference is whose computer your agents run on, and who can see what they are doing.",
  columns: ["", "A hosted service", "evestack on your hardware"],
  rows: [
    ["Runs on", "Someone else's servers", "Your machine, server, or cluster"],
    ["Where conversations are stored", "Their platform", "A Postgres database you own"],
    ["How long history is kept", "Set by the provider", "As long as you keep the rows"],
    ["Dashboard", "Included, and it watches", "Included, and it can also act"],
    ["Who can reach your data", "You and the provider", "You"],
    ["Setup", "Deploy to their platform", "One command, then four more"],
  ],
} as const;

/* §6 bento features. */
/* PLAIN-ENGLISH PASS 2026-08-09. Every title here used to be the name of the
   mechanism rather than the name of the benefit: "Durable sessions", "Private
   by construction", "Full-depth trace ingest", "Human-in-the-loop",
   "Restart-proof runs". Four of those six are terms you only know if you have
   already built this yourself, which means the grid was legible only to people
   who did not need it.

   Titles are now what the reader gets. The mechanism did not disappear, it
   moved into the body where it belongs, and each body still names the real
   thing (Postgres, the setting, the log line) so nothing became vaguer in the
   process. The demos underneath are unchanged. */
export const features = {
  heading: "Everything you need, already wired together",
  sub: "Agents that survive a restart, run code safely, work to a schedule, and ask before they do anything you would not want.",
  cells: [
    {
      /* MERGED 2026-08-11. This cell and "Survives a reboot" were the same
         promise twice: one said state is saved, the other said restarts are
         survivable, which is the same sentence read from either end. Six cells
         where two say one thing is five cells of information in a six cell
         grid. The freed slot went to schedules, which the page had lost
         entirely in the plain-English pass. */
      title: "Nothing gets lost",
      body: "Every step is saved to your database the moment it happens. Shut it down mid conversation, or reboot the machine with agents halfway through a job, and they pick themselves back up where they stopped.",
      demo: "events" as const,
    },
    {
      title: "No hosting bill",
      body: "The database, the sandbox and the dashboard all run on your machine, so there is nothing to bill. The only thing you pay for is the AI model, and you can run that locally too.",
      demo: "cost" as const,
    },
    {
      title: "Your prompts stay private",
      body: "Flip one setting and the words in your conversations never leave the agent. You still get timings and token counts, just not the content.",
      demo: "privacy" as const,
    },
    {
      /* Was "Full-depth trace ingest", body opening "agent.session down to
         every model stream, exported to your own OTLP endpoint". Accurate, and
         unreadable unless you already run tracing infrastructure. The claim is
         the same; it is now stated as what you can see rather than as the
         protocol that carries it. */
      title: "See every step it took",
      body: "Open any conversation and follow exactly what happened: each turn, every tool the agent reached for, and every call it made to the model, with what went in and what came back.",
      demo: "spans" as const,
    },
    {
      title: "It asks before it acts",
      body: "Mark any tool as needing permission. The agent stops and waits while you approve or deny it in the dashboard, and every decision is recorded.",
      demo: "approval" as const,
    },
    {
      /* RECOVERED 2026-08-11. Scheduled runs were listed in the old hero
         subhead's string of eight nouns; the plain-English pass cut that list
         and nothing took the capability with it, so the page stopped
         mentioning it at all. It matters more than its old billing did: it is
         the thing that separates "a chatbot I talk to" from "software that
         does work while I am asleep", which is most of what an agent is for. */
      title: "Runs while you sleep",
      body: "Give an agent a schedule and it works on its own. Every run is kept, so you can see what happened at 3am, and you can pause one without taking anything else down.",
      demo: "restart" as const,
    },
  ],
} as const;

/* §7 architecture nodes + beams. */
/* PLAIN-ENGLISH PASS 2026-08-09. The heading was "One compose file. Everything
   on localhost." and the sub explained the system in terms of the protocols
   between its parts (workflow tables, OTLP, spans). That is the right level of
   detail for someone deciding how to operate it and the wrong level for
   someone deciding whether they want it.

   Four parts, said as four jobs. The port numbers stay on the diagram, because
   a reader who does care needs them and they cost one line each. */
export const architecture = {
  heading: "Four pieces, all on your machine",
  sub: "The agent does the work. Postgres remembers every conversation. Docker keeps any code the agent runs inside a box where it cannot touch the rest of your computer. The dashboard shows you all of it, and none of it talks to the outside world.",
  nodes: [
    { id: "agent", title: "the agent", detail: "does the work · :2000" },
    { id: "postgres", title: "Postgres", detail: "remembers everything · :5433" },
    { id: "sandbox", title: "sandbox", detail: "runs code safely" },
    { id: "dashboard", title: "dashboard", detail: "watch and control · :4000" },
  ],
  beams: [
    { from: "agent", to: "postgres", label: "saves every step" },
    { from: "agent", to: "sandbox", label: "runs code" },
    { from: "agent", to: "dashboard", label: "sends traces" },
    { from: "dashboard", to: "postgres", label: "reads history" },
  ],
  /* Intro for the code cards that now close this section. Replaced the deleted
     §08 heading "The code is the pitch", which assumed a reader who already
     wanted to see source. This asks them to check rather than telling them
     the code is the argument. */
  codeLead: "Here are the actual files that do it, read straight from the repository.",
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
/* PLAIN-ENGLISH PASS 2026-08-10. The heading named the storage engine
   ("read straight from your own Postgres") and the sub opened with four terms
   of art in a row: session list, run trees, token rollups, $eve.* data, ingest
   pipeline. The section's actual promise is much easier to say, and much more
   interesting: you can see everything your agents did, and you can stop them.

   THE CONTROL SECTION IS NOW PART OF THIS ONE. It used to be §07, "Observability
   you can act on", 62 words and its own full section of scroll for one idea
   that belongs in the same breath as watching: seeing and intervening are the
   same feature described from two ends. `control` below still holds the demo's
   own strings. */
export const observability = {
  heading: "Watch your agents. Step in when it matters.",
  /* The evals clause was added 2026-08-11. Turning a real run, especially a
     failed one, into a test is on the launch kit's capability list and was
     nowhere on this page. It is the most advanced idea here, so it gets a
     plain sentence at the end rather than a cell of its own: a beginner can
     skip it, and the person who has been burned by a flaky agent will stop
     dead on it. */
  sub: "Every conversation your agents have is right there, read out of your own database. See what they did, what it cost, and how long it took. When one wants to do something you have flagged as risky, it waits for you to say yes. And when a run goes wrong, you can turn that exact run into a test so it does not go wrong the same way twice.",
  /* THE `capabilities` LIST WAS DELETED 2026-08-11 because nothing rendered it.

     Four entries, ~120 words, each naming the dashboard file that backed its
     claim so a reader could check it. Careful work, and dead: no component,
     script or test referenced `observability.capabilities`. This file opens by
     calling itself the single source of every user-facing string, which makes
     an unrendered entry worse than clutter. Someone eventually corrects a
     claim here, believes they have fixed the site, and has changed nothing.

     The claims themselves are not lost. The session list, the run tree and the
     cost calculation are all visible in the MonitorsPanel this section
     actually renders, and the approvals claim is the block beside it.

     (`shots` below is NOT dead: scripts/capture-screenshots.mjs and
     optimize-images.mjs both read it. Checked before deleting anything.) */

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
      alt: "The evestack dashboard's Sessions page: a red banner reading '8 sessions wedged, a turn started and never finished, nothing in eve will notice or retry it' with links to each, above a searchable table of 250 real runs showing outcome, trigger, model, provider, environment, run type and turn count. Rows span openai/gpt-5-mini, anthropic/claude-sonnet-5, ollama/qwen3 and acme/experimental-v1, with two 'failed' rows in red among the 'ok' ones.",
      caption: "Sessions, the dashboard in this repo, captured running against a live agent.",
    },
    detail: {
      name: "session-detail",
      width: 2880,
      height: 1800,
      alt: "A session detail page in the evestack dashboard: a scheduled run titled 'Write a detailed essay about database indexing', completed, open 1m 45s end to end, with tiles reading 4 turns, 28.5s turn time, 73,077 tokens in, 6,192 out and $0.02 spend. Below, a timeline of all four turns with their durations and costs, and turn 1 of 4 on openai/gpt-5-mini expanded to show 6.08s duration, 2.47s to first chunk, an output rate of 343.1 tokens per second, 15,223 tokens in, 2,088 out, 7,744 cache writes, 5 steps, 0 retries and 18 tools offered against 0 called.",
      caption: "One session's run tree, from the same capture.",
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

/* The approve/deny demo. It no longer has a section of its own — it now sits
   inside §Dashboard, because "you can see it" and "you can stop it" are one
   idea and it was costing a whole screen of scroll to say the second half.

   The heading here is kept for the sub-block's own label. It was "Observability
   you can act on", which is a phrase that only means something to a reader who
   already uses the word observability. */
export const control = {
  heading: "It waits for you",
  sub: "Mark a tool as risky and the agent will not use it until you say so. Approve or deny it in the browser, and the decision is written down.",
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
  heading: "Connect the tools you already use",
  sub: "Sign in once from the dashboard and your agent can use Gmail, GitHub, Slack, Notion, Linear and about a thousand more.",
  /* The one place on this site where "Everything runs on your network" stops
     being true, said here rather than left for someone to discover. Composio is
     a hosted third party: it performs the OAuth dance and holds the resulting
     tokens. It is also genuinely off unless you opt in — with COMPOSIO_API_KEY
     unset, `composioTools()` resolves to no tools and logs one line
     (packages/evestack-composio; see /docs/composio-auth). */
  caveat: {
    text: "This is the one part that does not run on your machine. Connecting accounts is handled by a company called Composio, and they hold the sign in tokens for the accounts you connect. It is switched off until you add a Composio key, and without one the agent still runs perfectly well, just with no outside accounts attached.",
    href: "/docs/composio-auth",
    linkLabel: "Read the full tradeoff",
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

/* §12 quickstart — the fork in the road.

   This section used to be a self-completing pipeline beside a verbatim
   `npm run verify` receipt: four stations, a spine drawing downward, ten check
   lines flipping from ghost to ink. It was accurate, it was well made, and it
   was too much. A visitor who has reached the bottom of this page does not need
   more PROOF — they have had eleven sections of it. They need to be told what
   to do next, and as of the agent pack there are two honest answers to that
   rather than one.

   So it is a fork, not a pipeline: run five commands yourself, or hand the
   whole thing to the agent you already have open. Each column is one glance.
   The receipt panel, the four stations and the spine are gone, along with the
   .qs/.qsp choreography in globals.css that drove them.

   The commands themselves are unchanged, still split pre/payload so dim
   boilerplate carries a bright payload — five rows, the same "five commands"
   the closing section claims. `npm run db:bootstrap`, never the upstream
   bootstrap bin; the note on the terminal artwork above says why. */
export const quickstart = {
  heading: "Two ways in.",
  /* The chip on the fork divider. One word, and it has to be the word that
     says these are alternatives rather than steps — which is the entire
     argument the section is making. */
  divider: "or",
  commands: {
    title: "Run it yourself",
    hint: "Node 24+, Docker, and a model key.",
    rows: [
      { pre: "npx ", cmd: "evestack create" },
      { pre: "docker ", cmd: "compose up -d postgres" },
      { pre: "npm run ", cmd: "db:bootstrap" },
      { pre: "npm run ", cmd: "dev" },
      { pre: "npm run ", cmd: "verify" },
    ],
    /* verify.mjs's real closing line, and the only receipt kept from the
       deleted panel — it is the payoff that panel existed to deliver. */
    receipt: "Everything works.",
  },
  agent: {
    title: "Hand it to your agent",
    hint: "Claude Code, Cursor, or a local model.",
    /* What is actually in the pack, so the button is not a mystery box. Each
       line is a file in /skills/evestack, not a promise made here. */
    gets: [
      "The five commands, and what each one is for",
      "The CLI, the dashboard API, tools, skills and memory",
      "The failure modes that present as something else",
    ],
    foot: "Nothing to install, and nothing to fetch once it is pasted.",
    read: "Read it first ↗",
    /* Composed from the REAL pack at build time (quickstart.tsx reads
       lib/agent-pack.ts), never typed in. A hardcoded size is wrong the first
       time anyone edits a reference file, and this is a number on a page whose
       whole contract is that its numbers are reproducible. */
    packFormat: (references: number, kb: number) =>
      `SKILL.md + ${references} references · ${kb} KB`,
  },
} as const;

/* The agent pack. ONE artifact — written once in /skills/evestack, served three
   ways (copy, `npx evestack skills`, fetch) — so nothing below restates its
   content. The button fetches /agent.md at click time rather than inlining
   ~30 KB of markdown into this page's payload.

   The two deeplinks hardcode the production origin deliberately. They hand a
   URL to a third party that then has to fetch it, and claude.ai can reach
   neither a protected preview deployment nor a localhost dev server — a
   relative link would be right for this page and useless at its destination.
   Same reasoning that already hardcodes the llms.txt URL below. */
const PACK_URL = "https://evestack.vercel.app/agent.md";
const DEEPLINK = encodeURIComponent(
  `Read ${PACK_URL}. It is the setup pack for evestack, a self-hosted ` +
    `distribution of Vercel's eve agent framework. Then help me get it running.`,
);

export const agentPack = {
  label: "Set up your agent",
  copied: "Copied, paste it in",
  failed: "Could not copy. Open /agent.md",
  announce: "The evestack agent pack is on your clipboard.",
  menuLabel: "More ways to give this to an agent",
  /* Relative: this one IS fetched by the page, from whatever origin serves it. */
  href: "/agent.md",
  menu: [
    {
      label: "Open in Claude",
      hint: "Starts a chat with the pack linked",
      href: `https://claude.ai/new?q=${DEEPLINK}`,
      external: true,
    },
    {
      label: "Open in ChatGPT",
      hint: "Starts a chat with the pack linked",
      href: `https://chatgpt.com/?q=${DEEPLINK}`,
      external: true,
    },
    {
      label: "Install it as a skill",
      hint: "npx evestack skills",
      href: "/docs/agent-setup",
      external: false,
    },
    {
      label: "View the raw pack",
      hint: "/agent.md",
      href: "/agent.md",
      external: true,
    },
    {
      label: "Every doc, one file",
      hint: "/llms-full.txt",
      href: "/llms-full.txt",
      external: true,
    },
  ],
} as const;

export const closing = {
  heading: "Your agents, on your hardware.",
  sub: "Five commands and it is running on your machine.",
} as const;

export const footerColumns = [
  {
    title: "The site",
    links: [
      { label: "Setup", href: "#one-command" },
      { label: "Features", href: "#features" },
      { label: "Dashboard", href: "#observability" },
      { label: "How it works", href: "#architecture" },
      { label: "Compare", href: "#compare" },
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
      { label: "License: Apache-2.0", href: `${site.github}/blob/main/LICENSE` },
      { label: "eve, the framework underneath", href: "https://eve.dev" },
    ],
  },
  {
    title: "Get started",
    links: [
      { label: "Two ways in", href: "#quickstart" },
      { label: "Set up with your agent", href: "/docs/agent-setup" },
      { label: "Troubleshooting", href: "/docs/troubleshooting" },
    ],
  },
] as const;
