/**
 * What eve's registry offers, and which of it the wizard puts in front of you.
 *
 * The catalogue is eve's, not ours. An evestack project IS an eve project — the
 * scaffold declares `eve` as a dependency and `npm run dev` runs `eve dev` — so
 * `eve add channel/slack` in a scaffold installs from the same public registry
 * (`https://eve.dev/r`) that a bare eve project uses, with no Vercel account
 * needed to browse or install. Rebuilding a parallel catalogue here would be
 * inventing a second source of truth for something upstream already publishes
 * and keeps current.
 *
 * So this file is a CACHE with a live read in front of it, not a fork:
 *
 *   - `SNAPSHOT` below is the registry as of the date in `SNAPSHOT_TAKEN`,
 *     embedded so the wizard is instant and works with no network at all. A
 *     scaffolder that cannot ask its questions on a plane is a scaffolder people
 *     stop trusting.
 *   - `loadCatalog()` tries the live registry with a short timeout and uses it
 *     when it answers. New channels appear in the wizard the day they are
 *     published, without a release here.
 *
 * The one thing added on top is `needs`: whether picking this costs you a
 * credential. eve's own list does not say, so the first time anyone learns that
 * Slack needs a token is after they have chosen it. Knowing before is the whole
 * difference between a list and a decision.
 */

/** Where the live catalogue comes from. Same URL eve's own CLI reads. */
export const REGISTRY_URL = "https://eve.dev/r/registry.json";

/** When SNAPSHOT below was taken, so a stale cache is visible rather than silent. */
export const SNAPSHOT_TAKEN = "2026-09-13";

/**
 * Shown first, in this order, before everything else alphabetically.
 *
 * Not a quality ranking — it is "what someone setting up their first agent
 * almost always wants". Web Chat leads because it is the only one that needs no
 * third-party account at all, so it is the one that gets a newcomer to a
 * working conversation fastest.
 */
export const FEATURED_CHANNELS = [
  "channel/web",
  "channel/slack",
  "channel/github",
  "channel/linear-agent",
  "channel/discord",
  "channel/telegram"
];

export const FEATURED_INTEGRATIONS = [
  "extension/github-tools",
  "connection/linear",
  "connection/notion",
  "connection/vercel",
  "extension/agent-browser",
  "memory/supermemory"
];

/** The embedded registry. Superseded by the live read when it answers. */
export const SNAPSHOT = [
  { id: "channel/blooio", title: "Blooio", note: "Send and receive iMessage, RCS, and SMS through Blooio, with reactions, typing indicators, read receipts, polls, groups, capability checks, and history.", kind: "channel" },
  { id: "channel/chat-sdk-agentphone", title: "AgentPhone", note: "SMS, MMS, iMessage, and voice conversations through AgentPhone.", kind: "channel" },
  { id: "channel/chat-sdk-beeper", title: "Beeper", note: "Matrix rooms and bridged messaging networks through Beeper.", kind: "channel" },
  { id: "channel/chat-sdk-dial", title: "Dial", note: "Give your agent a phone number for SMS, MMS, iMessage, and voice transcripts.", kind: "channel" },
  { id: "channel/chat-sdk-gchat", title: "Google Chat", note: "Google Chat spaces and DMs via the Chat SDK.", kind: "channel" },
  { id: "channel/chat-sdk-kapso", title: "Kapso", note: "Managed WhatsApp conversations, media, buttons, and history through Kapso.", kind: "channel" },
  { id: "channel/chat-sdk-lark", title: "Lark / Feishu", note: "Lark and Feishu chats with native card streaming via the Chat SDK.", kind: "channel" },
  { id: "channel/chat-sdk-liveblocks", title: "Liveblocks", note: "Liveblocks comment threads, mentions, and reactions.", kind: "channel" },
  { id: "channel/chat-sdk-messenger", title: "Messenger", note: "Facebook Messenger bots with templates, buttons, and reactions via the Chat SDK.", kind: "channel" },
  { id: "channel/chat-sdk-novu", title: "Novu", note: "Reach Slack, Teams, WhatsApp, Telegram, and email through Novu.", kind: "channel" },
  { id: "channel/chat-sdk-resend", title: "Resend", note: "Send and receive threaded email through Resend via the Chat SDK.", kind: "channel" },
  { id: "channel/chat-sdk-sendblue", title: "Sendblue", note: "Send and receive iMessage, SMS, and RCS through Sendblue.", kind: "channel" },
  { id: "channel/chat-sdk-velt", title: "Velt", note: "Add agents to anchored comments across documents, canvases, PDFs, and video.", kind: "channel" },
  { id: "channel/chat-sdk-whatsapp", title: "WhatsApp", note: "Customer messaging through WhatsApp Business Cloud via the Chat SDK.", kind: "channel" },
  { id: "channel/chat-sdk-x", title: "X", note: "Public mentions and DMs on X via the Chat SDK.", kind: "channel" },
  { id: "channel/chat-sdk-zernio", title: "Zernio", note: "Reach seven social and messaging platforms through one Zernio integration.", kind: "channel" },
  { id: "channel/discord", title: "Discord", note: "Discord with guided connector and slash-command setup.", kind: "channel", needs: "connect" },
  { id: "channel/github", title: "GitHub", note: "Drive your agent from issues, pull requests, and comments, with guided Connect setup.", kind: "channel", needs: "connect" },
  { id: "channel/linear-agent", title: "Linear Agent", note: "Delegate Linear issues and comments through Agent Sessions, with guided Vercel Connect setup.", kind: "channel", needs: "connect" },
  { id: "channel/linq", title: "Linq", note: "IMessage and SMS through Linq with guided Connect or portable setup.", kind: "channel", needs: "connect" },
  { id: "channel/photon-imessage", title: "Photon iMessage", note: "IMessage through Photon with guided project and phone setup.", kind: "channel" },
  { id: "channel/slack", title: "Slack", note: "Slack with Vercel Connect or portable credentials.", kind: "channel", needs: "connect" },
  { id: "channel/teams", title: "Microsoft Teams", note: "Teams chats and channels.", kind: "channel" },
  { id: "channel/telegram", title: "Telegram", note: "A Telegram bot for 1:1 and group chats.", kind: "channel", needs: "token" },
  { id: "channel/twilio", title: "Twilio", note: "Put your agent on a phone number: SMS and speech-transcribed calls.", kind: "channel" },
  { id: "channel/web", title: "Web Chat", note: "Add the built-in Next.js Web Chat channel.", kind: "channel" },
  { id: "connection/agentcard", title: "Agentcard", note: "Let agents buy online", kind: "integration", needs: "token" },
  { id: "connection/airtable", title: "Airtable", note: "Bases, tables, and records through Airtable's MCP server.", kind: "integration", needs: "token" },
  { id: "connection/bitly", title: "Bitly", note: "Shorten links, generate QR Codes, and track performance.", kind: "integration", needs: "token" },
  { id: "connection/brex", title: "Brex", note: "Expenses, cards, and cash through Brex's finance automation.", kind: "integration", needs: "token" },
  { id: "connection/browser-use", title: "Browser Use", note: "Run managed browser automation tasks through Browser Use's MCP server.", kind: "integration", needs: "token" },
  { id: "connection/candid", title: "Candid", note: "Research nonprofits and funders using Candid's data.", kind: "integration", needs: "token" },
  { id: "connection/clickhouse", title: "ClickHouse", note: "Query and explore your ClickHouse Cloud data.", kind: "integration", needs: "token" },
  { id: "connection/cloudinary", title: "Cloudinary", note: "Manage, transform, and deliver your images and videos.", kind: "integration", needs: "token" },
  { id: "connection/coda", title: "Coda", note: "Create, search, and update docs and tables.", kind: "integration", needs: "token" },
  { id: "connection/context", title: "context.dev", note: "Search, scrape, extract, and monitor live web data.", kind: "integration", needs: "token" },
  { id: "connection/datadog", title: "Datadog", note: "Query metrics, monitors, and logs through Datadog's MCP server.", kind: "integration", needs: "token" },
  { id: "connection/egnyte", title: "Egnyte", note: "Securely access and analyze Egnyte content.", kind: "integration", needs: "token" },
  { id: "connection/embat", title: "Embat", note: "Ask Embat about cash, debt, payments, and accounting.", kind: "integration", needs: "token" },
  { id: "connection/honeycomb", title: "Honeycomb", note: "Explore traces and run queries through Honeycomb's MCP server.", kind: "integration", needs: "token" },
  { id: "connection/hugging-face", title: "Hugging Face", note: "Access the Hugging Face Hub and thousands of Gradio apps.", kind: "integration", needs: "token" },
  { id: "connection/linear", title: "Linear", note: "Issues, projects, cycles, and comments via Linear's MCP server.", kind: "integration", needs: "token" },
  { id: "connection/local-falcon", title: "Local Falcon", note: "AI visibility and local search intelligence.", kind: "integration", needs: "token" },
  { id: "connection/make", title: "Make", note: "Run Make scenarios and manage your Make account.", kind: "integration", needs: "token" },
  { id: "connection/manufact", title: "Manufact", note: "Deploy and monitor MCP servers with Manufact.", kind: "integration", needs: "token" },
  { id: "connection/mem0", title: "Mem0", note: "Persistent memory for AI agents and assistants.", kind: "integration", needs: "token" },
  { id: "connection/miro", title: "Miro", note: "Access and create content on Miro boards.", kind: "integration", needs: "token" },
  { id: "connection/mixpanel", title: "Mixpanel", note: "Analyze, query, and manage your Mixpanel data.", kind: "integration", needs: "token" },
  { id: "connection/natural", title: "Natural", note: "Send, request, and manage payments with Natural.", kind: "integration", needs: "token" },
  { id: "connection/neon", title: "Neon", note: "Manage Neon projects, run queries, and make schema changes.", kind: "integration", needs: "token" },
  { id: "connection/netlify", title: "Netlify", note: "Create, deploy, manage, and secure websites on Netlify.", kind: "integration", needs: "token" },
  { id: "connection/notion", title: "Notion", note: "Search and edit Notion pages and databases over MCP or OpenAPI.", kind: "integration", needs: "token" },
  { id: "connection/oreilly", title: "O'Reilly", note: "Discover O'Reilly's expert learning content.", kind: "integration", needs: "token" },
  { id: "connection/planetscale", title: "PlanetScale", note: "Authenticated access to your PlanetScale Postgres and MySQL databases.", kind: "integration", needs: "token" },
  { id: "connection/posthog", title: "PostHog", note: "Query, analyze, and manage your PostHog insights.", kind: "integration", needs: "token" },
  { id: "connection/postman", title: "Postman", note: "Give API context to your coding agents with Postman.", kind: "integration", needs: "token" },
  { id: "connection/razorpay", title: "Razorpay", note: "Razorpay payments, settlements, and dashboard data.", kind: "integration", needs: "token" },
  { id: "connection/sentry", title: "Sentry", note: "Search, query, and debug errors intelligently.", kind: "integration", needs: "token" },
  { id: "connection/shopify", title: "Shopify", note: "Search products and manage carts and checkouts on a Shopify storefront.", kind: "integration", needs: "token" },
  { id: "connection/similarweb", title: "Similarweb", note: "Real-time web, mobile app, and market data.", kind: "integration", needs: "token" },
  { id: "connection/stripe", title: "Stripe", note: "Payment processing and financial infrastructure tools.", kind: "integration", needs: "token" },
  { id: "connection/supabase", title: "Supabase", note: "Manage databases, authentication, and storage.", kind: "integration", needs: "token" },
  { id: "connection/ticket-tailor", title: "Ticket Tailor", note: "Manage tickets, orders, and events with Ticket Tailor.", kind: "integration", needs: "token" },
  { id: "connection/ticktick", title: "TickTick", note: "Search, create, and manage your tasks and habits in TickTick.", kind: "integration", needs: "token" },
  { id: "connection/tinybird", title: "Tinybird", note: "Query pipes and data sources in your Tinybird Workspace.", kind: "integration", needs: "token" },
  { id: "connection/todoist", title: "Todoist", note: "Search, complete, and manage your tasks in Todoist.", kind: "integration", needs: "token" },
  { id: "connection/vercel", title: "Vercel", note: "Manage Vercel projects, deployments, and logs through Vercel's MCP server.", kind: "integration", needs: "token" },
  { id: "connection/webflow", title: "Webflow", note: "Manage Webflow CMS, pages, assets, and sites.", kind: "integration", needs: "token" },
  { id: "connection/wix", title: "Wix", note: "Manage and build sites and apps on Wix.", kind: "integration", needs: "token" },
  { id: "connection/zapier", title: "Zapier", note: "Automate workflows across thousands of apps.", kind: "integration", needs: "token" },
  { id: "connection/zomato", title: "Zomato", note: "Online food ordering and delivery through Zomato.", kind: "integration", needs: "token" },
  { id: "experimental/self-modification", title: "Self-modification (Experimental)", note: "Add an experimental source editing subagent with local edits and official registry installation.", kind: "integration" },
  { id: "extension/agent-browser", title: "agent-browser", note: "Add browser automation tools backed by agent-browser.", kind: "integration" },
  { id: "extension/blitzreels", title: "BlitzReels", note: "Turn long videos into short clips, generate media, repair edits, and export.", kind: "integration" },
  { id: "extension/browserbase", title: "Browserbase", note: "Search, fetch, and automate the web with Browserbase and Stagehand.", kind: "integration" },
  { id: "extension/github-tools", title: "GitHub Tools", note: "Add scoped GitHub tools with Vercel Connect authentication and approval rules.", kind: "integration", needs: "connect" },
  { id: "extension/hindsight", title: "Hindsight", note: "Recall relevant context before every turn and retain each exchange automatically.", kind: "integration" },
  { id: "extension/jetty", title: "Jetty", note: "Grade agent turns, compare experiments, and store durable evaluation trajectories.", kind: "integration" },
  { id: "extension/kernel", title: "KERNEL", note: "Let your eve agent use the Internet with KERNEL browser infrastructure, observability, and stealth.", kind: "integration" },
  { id: "instrumentation/braintrust", title: "Braintrust", note: "Trace eve agent sessions in Braintrust, including turns, steps, tool calls, and subagent interactions.", kind: "integration" },
  { id: "instrumentation/posthog", title: "PostHog", note: "Send agent traces and generations to PostHog AI Observability.", kind: "integration" },
  { id: "linear", title: "Linear", note: "Receive delegated Linear work and give your agent tools for issues, projects, and comments.", kind: "integration" },
  { id: "memory/arcana", title: "Kybernesis Arcana", note: "Give your agents workspace-scoped long-term memory with automatic recall and deliberate storage.", kind: "integration" },
  { id: "memory/file", title: "File memory", note: "Store durable per-principal memory in a private Vercel Blob store. Setup connects production, preview, and development in the project's primary function region; Blob usage may incur charges.", kind: "integration" },
  { id: "memory/supermemory", title: "Supermemory", note: "Give your agents long-term memory, user profiles, and SuperRAG across conversations and context.", kind: "integration" },
  { id: "memory/upstash-agentkit", title: "Upstash AgentKit", note: "Give your agents ranked recall and automatic capture on Upstash Redis, or a Redis backend for file memory.", kind: "integration" },
  { id: "tool/agent", title: "Agent", note: "Add root-agent background delegation.", kind: "integration" },
  { id: "tool/ask_question", title: "Ask Question", note: "Let the agent ask the user a question during a turn.", kind: "integration" },
  { id: "tool/bash", title: "Bash", note: "Run shell commands in the agent sandbox.", kind: "integration" },
  { id: "tool/glob", title: "Glob", note: "Find sandbox files by glob pattern.", kind: "integration" },
  { id: "tool/grep", title: "Grep", note: "Search sandbox file contents with a regular expression.", kind: "integration" },
  { id: "tool/load_skill", title: "Load Skill", note: "Load instructions from an agent skill.", kind: "integration" },
  { id: "tool/read_file", title: "Read File", note: "Read text files from the agent sandbox.", kind: "integration" },
  { id: "tool/sleep", title: "Sleep", note: "Pause and durably resume the current turn.", kind: "integration" },
  { id: "tool/task_cancel", title: "Task Cancel", note: "Cancel background tasks from the root session.", kind: "integration" },
  { id: "tool/todo", title: "Todo", note: "Maintain a durable per-session todo list.", kind: "integration" },
  { id: "tool/web_fetch", title: "Web Fetch", note: "Fetch a URL from the app runtime.", kind: "integration" },
  { id: "tool/web_search", title: "Web Search", note: "Search the web through the model provider.", kind: "integration" },
  { id: "tool/write_file", title: "Write File", note: "Write complete files in the agent sandbox.", kind: "integration" },
];
