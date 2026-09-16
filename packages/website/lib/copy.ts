/* Public copy describes shipped behavior. Example data is labeled at its display.
   Keep setup/runtime claims aligned with release-manifest.json and docs/first-task.mdx. */

export const site = {
  name: "evestack",
  mark: "▚",
  title: "evestack: run AI agents on your own machine",
  tagline: "Run AI agents on your own machine.",
  taglineLines: ["Run AI agents", "on your own machine."],
  subhead:
    "An open source workspace for recurring AI work. Run a task, check its evidence, and schedule a repeat on infrastructure you control.",
  command: "npx evestack create",
  github: "https://github.com/SammyTourani/evestack",
  attribution:
    "Eve Stack packages the eve agent framework with a task workspace, durable routines and operator tools. Compatibility checks run against the selected runtime versions.",
  trademark:
    "eve is a trademark of Vercel. evestack is an independent project, not affiliated with or endorsed by Vercel.",
  motto: "Your workspace. Your operating decisions.",
  byline: {
    text: "See how the components are tested together.",
    href: "https://github.com/SammyTourani/evestack/actions/workflows/ci.yml",
  },
} as const;

export const nav = [
  {
    label: "Setup",
    href: "#one-command",
  },
  {
    label: "Features",
    href: "#features",
  },
  {
    label: "Dashboard",
    href: "#observability",
  },
  {
    label: "How it works",
    href: "#architecture",
  },
] as const;

export const terminal = {
  prompt: "npx evestack create",
  lines: [
    {
      text: "… choose a provider and tools, then install the project",
      kind: "dim",
    },
    {
      text: "docker compose up -d postgres",
      kind: "cmd",
    },
    {
      text: "npm run db:bootstrap",
      kind: "cmd",
    },
    {
      text: "docker compose --profile dashboard up -d",
      kind: "cmd",
    },
    {
      text: "npm run dev",
      kind: "cmd",
    },
    {
      text: "Open the dashboard at the printed address.",
      kind: "dim",
    },
  ],
  caption: "Create the workspace. Run one useful task.",
  examples:
    "Start with a repository maintenance brief: recent changes, open questions and links to the evidence.",
} as const;

export const comparison = {
  heading: "Choose who operates the workspace",
  sub: "Self-hosting gives you control over the deployment and database. It also makes backups, upgrades, access control and uptime your responsibility.",
  columns: ["", "A hosted service", "evestack on your hardware"],
  rows: [
    [
      "Runs on",
      "Provider-managed infrastructure",
      "Your machine, server, or cluster",
    ],
    [
      "Conversation storage",
      "Provider-managed storage",
      "Your Postgres database",
    ],
    [
      "History retention",
      "Depends on the service",
      "Your retention and backup policy",
    ],
    ["Operations", "Managed by the service", "Managed by you"],
    [
      "External data access",
      "Depends on provider and integrations",
      "Depends on model, tools and connections",
    ],
    [
      "Cost",
      "Service and usage charges",
      "Hardware, hosting and usage charges",
    ],
  ],
} as const;

export const features = {
  heading: "From a useful result to recurring work",
  sub: "Keep tasks, decisions, routines and recovery in one workspace.",
  cells: [
    {
      title: "Pick up saved work",
      body: "Conversation and workflow state live in Postgres. Inspect what completed after a restart, and resolve uncertain work before repeating it.",
      demo: "events",
    },
    {
      title: "Keep an eye on spend",
      body: "See estimated model costs and unpriced usage. Configure budgets for opted-in agents; your hardware, hosting and provider charges remain yours.",
      demo: "cost",
    },
    {
      title: "Choose what gets recorded",
      body: "Disable trace content capture while keeping timings and token counts. This setting does not prevent prompts reaching your model provider or remove workflow history.",
      demo: "privacy",
    },
    {
      title: "Inspect the evidence",
      body: "Open the task result, recorded turns and tool traces. Missing or incomplete evidence is shown, so a green status is not your only signal.",
      demo: "spans",
    },
    {
      title: "Review gated actions",
      body: "Tools configured to require approval wait for a decision. Inspect the exact request and input before answering; that decision stays in the audit history.",
      demo: "approval",
    },
    {
      title: "Test, then schedule",
      body: "Save a prompt as a routine, preview its timezone and run it once. After reviewing the result, enable repeats. Unknown dispatch pauses for your attention.",
      demo: "restart",
    },
  ],
} as const;

export const architecture = {
  heading: "A workspace you operate",
  sub: "The agent runs tasks, Postgres keeps their history, and the dashboard helps you review and control work. Configured sandbox tools run in containers. Model providers and connected services may run elsewhere.",
  nodes: [
    {
      id: "agent",
      title: "the agent",
      detail: "does the work · :2000",
    },
    {
      id: "postgres",
      title: "Postgres",
      detail: "durable task history · :5433",
    },
    {
      id: "sandbox",
      title: "sandbox",
      detail: "isolates configured tools",
    },
    {
      id: "dashboard",
      title: "dashboard",
      detail: "watch and control · :4000",
    },
  ],
  beams: [
    {
      from: "agent",
      to: "postgres",
      label: "writes workflow state",
    },
    {
      from: "agent",
      to: "sandbox",
      label: "runs code",
    },
    {
      from: "agent",
      to: "dashboard",
      label: "sends traces",
    },
    {
      from: "dashboard",
      to: "postgres",
      label: "reads history",
    },
  ],
  codeLead:
    "Here are the actual files that do it, read straight from the repository.",
  srSummary:
    "Architecture: the eve agent runtime on port 2000 writes workflow events to Postgres on port 5433 running in Docker, executes code in per-session Docker sandbox containers, and exports OTLP traces to the dashboard on port 4000, which also reads run state directly from Postgres over SQL.",
} as const;

export const observability = {
  heading: "See the result. Know what needs you.",
  sub: "Today brings together decisions, recurring work and recent tasks. Open a result, inspect its recorded evidence, and turn a correction into a versioned regression case.",
  capabilities: [
    {
      title: "Start with Today",
      body: "Pending decisions, recent work, routines and setup checks.",
      source: "packages/dashboard/app/page.tsx",
    },
    {
      title: "Inspect a task",
      body: "Result, conversation, estimated cost and links to recorded evidence.",
      source: "packages/dashboard/app/chat/page.tsx",
    },
    {
      title: "Understand estimated cost",
      body: "Models without prices are shown as unpriced.",
      source: "packages/dashboard/lib/pricing.ts",
    },
    {
      title: "Keep decision history",
      body: "Exact tool decisions and installation attribution remain available.",
      source: "packages/dashboard/app/approvals/page.tsx",
    },
  ],
  shots: {
    sessions: {
      name: "tasks",
      width: 2880,
      height: 1800,
      alt: "Eve Stack Tasks page with recent work, outcomes and estimated spend. Example data from a local release test instance.",
      caption:
        "The shipped Tasks interface. Example data from a local release test instance.",
    },
    detail: {
      name: "task-detail",
      width: 2880,
      height: 1688,
      alt: "Eve Stack task workspace showing a repository maintenance brief with source links. Illustrative result displayed in a local test instance; no live repository was inspected.",
      caption:
        "Task workspace with an illustrative repository brief, not a live provider result.",
    },
  },
  spanTree: [
    {
      depth: 0,
      name: "agent.session",
      note: "ROOT",
    },
    {
      depth: 1,
      name: "agent.turn",
      note: "",
    },
    {
      depth: 2,
      name: "agent.step",
      note: "",
    },
    {
      depth: 3,
      name: "ai.streamText",
      note: "",
    },
    {
      depth: 4,
      name: "ai.streamText.doStream",
      note: "streaming",
    },
    {
      depth: 2,
      name: "agent.turn.terminal",
      note: "",
    },
  ],
} as const;

export const control = {
  heading: "Decide before a gated tool runs",
  sub: "Approval applies to tools configured to request it. Inspect the proposed input and answer in the dashboard. Shared credentials identify the installation, not individual teammates.",
  demo: {
    tool: "send_email",
    args: '{ "to": "team@…", "subject": "Deploy done" }',
    states: ["requested", "approved", "executed"],
  },
} as const;

export const integrations = {
  heading: "Connect the tools you already use",
  sub: "Connect accounts such as GitHub, Gmail and Slack through optional Composio integration. Available tools and access depend on the account, consent and agent configuration.",
  caveat: {
    text: "Composio is a hosted service that holds tokens for connected accounts. It stays off until you configure a key. Cloud model providers and external tools also receive the data needed for their calls.",
    href: "/docs/composio-auth",
    linkLabel: "Review connection setup and data access",
  },
  hub: {
    left: [
      {
        name: "Gmail",
        slug: "gmail",
      },
      {
        name: "GitHub",
        slug: "github",
      },
      {
        name: "Notion",
        slug: "notion",
      },
      {
        name: "Linear",
        slug: "linear",
      },
    ],
    right: [
      {
        name: "Google Calendar",
        slug: "googlecalendar",
      },
      {
        name: "Stripe",
        slug: "stripe",
      },
      {
        name: "HubSpot",
        slug: "hubspot",
      },
      {
        name: "Jira",
        slug: "jira",
      },
    ],
    calls: [
      {
        action: "GMAIL_SEND_EMAIL",
        app: "gmail",
        ms: 212,
      },
      {
        action: "GITHUB_CREATE_AN_ISSUE",
        app: "github",
        ms: 415,
      },
      {
        action: "GMAIL_FETCH_EMAILS",
        app: "gmail",
        ms: 189,
      },
      {
        action: "GITHUB_SEARCH_REPOS",
        app: "github",
        ms: 342,
      },
    ],
  },
  marquee: [
    {
      name: "Gmail",
      slug: "gmail",
      pad: true,
    },
    {
      name: "GitHub",
      slug: "github",
    },
    {
      name: "Notion",
      slug: "notion",
    },
    {
      name: "Stripe",
      slug: "stripe",
    },
    {
      name: "Figma",
      slug: "figma",
      pad: true,
    },
    {
      name: "Asana",
      slug: "asana",
    },
    {
      name: "Jira",
      slug: "jira",
      pad: true,
    },
    {
      name: "Linear",
      slug: "linear",
    },
    {
      name: "Dropbox",
      slug: "dropbox",
      pad: true,
    },
    {
      name: "Zendesk",
      slug: "zendesk",
    },
    {
      name: "Trello",
      slug: "trello",
      pad: true,
    },
    {
      name: "HubSpot",
      slug: "hubspot",
    },
    {
      name: "Google Drive",
      slug: "googledrive",
      pad: true,
    },
    {
      name: "Todoist",
      slug: "todoist",
    },
    {
      name: "Airtable",
      slug: "airtable",
      pad: true,
    },
    {
      name: "Mailchimp",
      slug: "mailchimp",
    },
    {
      name: "Shopify",
      slug: "shopify",
      pad: true,
    },
    {
      name: "Zoom",
      slug: "zoom",
    },
    {
      name: "Reddit",
      slug: "reddit",
    },
    {
      name: "Discord",
      slug: "discord",
    },
  ],
} as const;

export const agentPack = {
  label: "Set up your agent",
  copied: "Copied, paste it in",
  failed: "Could not copy. Open /agent.md",
  announce: "The evestack agent pack is on your clipboard.",
  menuLabel: "More ways to give this to an agent",
  href: "/agent.md",
  menu: [
    {
      label: "Open in Claude",
      hint: "Starts a chat with the pack linked",
      href: "https://claude.ai/new?q=Read%20https%3A%2F%2Fevestack.vercel.app%2Fagent.md.%20It%20is%20the%20setup%20pack%20for%20evestack%2C%20a%20self-hosted%20distribution%20of%20Vercel's%20eve%20agent%20framework.%20Then%20help%20me%20get%20it%20running.",
      mark: "claude",
      external: true,
    },
    {
      label: "Open in ChatGPT",
      hint: "Starts a chat with the pack linked",
      href: "https://chatgpt.com/?q=Read%20https%3A%2F%2Fevestack.vercel.app%2Fagent.md.%20It%20is%20the%20setup%20pack%20for%20evestack%2C%20a%20self-hosted%20distribution%20of%20Vercel's%20eve%20agent%20framework.%20Then%20help%20me%20get%20it%20running.",
      mark: "openai",
      external: true,
    },
    {
      label: "Install it as a skill",
      hint: "npx evestack skills",
      href: "/docs/agent-setup",
      mark: "terminal",
      external: false,
    },
  ],
} as const;

export const closing = {
  heading: "Make the first task useful.",
  sub: "Create your workspace, connect a repository and inspect a maintenance brief before scheduling it.",
} as const;

export const footerColumns = [
  {
    title: "The site",
    links: [
      {
        label: "Setup",
        href: "#one-command",
      },
      {
        label: "Features",
        href: "#features",
      },
      {
        label: "Dashboard",
        href: "#observability",
      },
      {
        label: "How it works",
        href: "#architecture",
      },
      {
        label: "Compare",
        href: "#compare",
      },
    ],
  },
  {
    title: "Open source",
    links: [
      {
        label: "Docs",
        href: "/docs",
      },
      {
        label: "GitHub",
        href: "https://github.com/SammyTourani/evestack",
      },
      {
        label: "License: Apache-2.0",
        href: "https://github.com/SammyTourani/evestack/blob/main/LICENSE",
      },
      {
        label: "eve, the framework underneath",
        href: "https://eve.dev",
      },
    ],
  },
  {
    title: "Get started",
    links: [
      {
        label: "Get started",
        href: "#get-started",
      },
      {
        label: "Your first useful task",
        href: "/docs/first-task",
      },
      {
        label: "Set up with your agent",
        href: "/docs/agent-setup",
      },
      {
        label: "Troubleshooting",
        href: "/docs/troubleshooting",
      },
    ],
  },
] as const;
