#!/usr/bin/env node
/**
 * Generates the evestack registry.
 *
 * eve consumes third-party registries in the shadcn registry-item format:
 *
 *   eve registry add @evestack=https://raw.githubusercontent.com/SammyTourani/evestack/main/registry/r/{name}.json
 *   eve add @evestack/memory
 *
 * That is why evestack ships as a registry and not a fork. Anyone already
 * running eve can take one piece — memory, the dashboard exporter, Postgres
 * durability — without migrating a project or tracking our releases. We stay
 * additive to eve instead of competing with it.
 *
 * The URL is raw.githubusercontent.com, not registry.evestack.dev, because we
 * own no domain: evestack.dev is unregistered, and the branded URL this comment
 * used to show died with getaddrinfo ENOTFOUND on the first command a stranger
 * ran. If someone buys the domain, see docs/registry.mdx — it lists every place
 * the URL appears and the two constraints eve's registry client imposes on any
 * replacement host ({name} is mandatory; Content-Type is not checked).
 *
 * Item content is inlined from the real files under templates/default, so the
 * registry can never drift from the code we actually test.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const template = join(root, "templates", "default");
const outDir = join(root, "registry", "r");

const read = (rel) => readFileSync(join(template, rel), "utf8");

const templateManifest = JSON.parse(read("package.json"));

/**
 * Pin every declared dependency to the range templates/default is tested with.
 *
 * A bare name in a registry item means "whatever npm calls latest today". That
 * is how `eve add @evestack/memory` ended up installing @ai-sdk/openai@4 next to
 * ai@7 in a project whose code has only ever been run against @ai-sdk/openai@2.
 * eve's own items pin (`@vercel/connect@0.4.2`); so do ours, from the one
 * manifest that is actually exercised.
 */
function pin(names, field = "dependencies") {
  return names.map((name) => {
    const range = templateManifest[field]?.[name];
    if (!range) {
      throw new Error(
        `registry: ${name} is listed as a ${field} of a registry item but is not in ` +
          "templates/default/package.json, so there is no tested version to pin to.",
      );
    }
    return `${name}@${range}`;
  });
}

/** @type {Array<{name:string,title:string,description:string,dependencies?:string[],devDependencies?:string[],files:Array<{source:string,target:string}>,docs?:string}>} */
const ITEMS = [
  {
    name: "memory",
    title: "Long-term memory (pgvector)",
    description:
      "Semantic long-term memory for an eve agent, stored in your own Postgres with pgvector. " +
      "No vector service, no extra container, no bill.",
    // `ai` is deliberately NOT listed. Every eve project already depends on it
    // AND carries an `overrides` entry for it, so declaring it here as a direct
    // dependency makes npm fail the whole install with
    // `EOVERRIDE: Override for ai@^7.0.51 conflicts with direct dependency`.
    // Pinning it was meant to prevent a version mismatch and instead made
    // `eve add @evestack/memory` impossible on a stock project.
    // Both embedding providers, because lib/memory.ts imports both at the top
    // and chooses between them at runtime from EVESTACK_PROVIDER. Shipping only
    // `@ai-sdk/openai` is what made this item unusable on a local-model project:
    // the import resolved, the call did not, and `remember` died on
    // `AI_LoadAPIKeyError` on a stack that was supposed to need no key.
    dependencies: pin(["pg", "@ai-sdk/openai", "ai-sdk-ollama"]),
    devDependencies: pin(["@types/pg"], "devDependencies"),
    files: [
      { source: "lib/memory.ts", target: "lib/memory.ts" },
      { source: "agent/tools/remember.ts", target: "agent/tools/remember.ts" },
      { source: "agent/tools/recall.ts", target: "agent/tools/recall.ts" },
      { source: "agent/tools/forget.ts", target: "agent/tools/forget.ts" },
    ],
    docs:
      "Requires a Postgres with the pgvector extension available (the pgvector/pgvector image " +
      "has it) and WORKFLOW_POSTGRES_URL set. The tools import lib/memory.ts by relative path, " +
      "so no `imports` or tsconfig `paths` entry is needed — but if your tsconfig `include` " +
      "lists only agent/, add \"lib/**/*.ts\" so the file is typechecked. Uses HNSW indexing, " +
      "which is correct on an empty table — IVFFlat is not. `forget` is gated with approval: always(), so deleting a memory always parks the turn for a human decision — it is also the worked example of human-in-the-loop.",
  },
  {
    name: "instrumentation",
    title: "evestack dashboard traces",
    description:
      "Export OpenTelemetry traces from an eve agent to a self-hosted evestack dashboard.",
    dependencies: pin(["@vercel/otel"]),
    files: [{ source: "agent/instrumentation.ts", target: "agent/instrumentation.ts" }],
    docs:
      "Set EVESTACK_DASHBOARD_URL to your dashboard's ingest endpoint " +
      "(http://localhost:4000/api/ingest/v1/traces). Leave it unset and no exporter is " +
      "registered. ALSO SET EVESTACK_INGEST_TOKEN to the same value the dashboard has: the " +
      "ingest route takes that shared secret (sent as the x-evestack-ingest-token header) or a " +
      "session cookie, and an exporter cannot hold a session — so with it unset or mismatched " +
      "every span is refused with a 401. Generate one with `openssl rand -hex 32`. The file " +
      "probes the endpoint once at startup and logs loudly if the credential is refused, " +
      "because the OTLP exporter itself treats a 401 as a successful export. NOTE: the " +
      "presence of agent/instrumentation.ts disables eve's zero-config local trace spool, so " +
      "`eve traces` stops working — delete the file to get it back.",
  },
  {
    name: "docker-sandbox",
    title: "Docker sandbox",
    description:
      "Run the agent's sandbox in a local Docker container instead of hosted Vercel Sandbox.",
    files: [{ source: "agent/sandbox/sandbox.ts", target: "agent/sandbox/sandbox.ts" }],
    docs:
      "Needs a reachable Docker daemon. eve keeps one long-lived container per durable session " +
      "and persists /workspace across turns with no idle timeout. The Docker backend honors " +
      "only allow-all and deny-all network policies; use microsandbox for domain allow-lists.",
  },
  {
    name: "basic-auth",
    title: "HTTP Basic route auth",
    description:
      "Replace vercelOidc()/placeholderAuth() with HTTP Basic, for agents that run off Vercel.",
    files: [{ source: "agent/channels/eve.ts", target: "agent/channels/eve.ts" }],
    /* The docs below lead with the file collision, because this item's single file
       targets agent/channels/eve.ts — which EVERY `eve init` project already has,
       since that is where eve puts its own auth chain. So this is the one registry
       item that cannot land on a clean install without replacing an existing file,
       and `eve add` will not silently do that for you. Saying it here matters more
       than usual: `docs` is the only text `eve add` prints, so anything not in this
       string is something the user never sees. */
    docs:
      "REPLACES agent/channels/eve.ts, which your project already has — that is where " +
      "eve puts its own auth chain. Pass `-o` / `--overwrite` to let it, and diff the " +
      "result: anything you had added to that file (extra channels, a custom " +
      "authenticator) is in the file being replaced. " +
      "Then set EVESTACK_AUTH_USER and EVESTACK_AUTH_PASSWORD. Requires eve >= 0.30, where " +
      "localDev() grants on the deployment being a dev process rather than on the request " +
      "Host header — on 0.29.x that header was attacker-controlled and `127.evil.com` could " +
      "obtain an unauthenticated local-dev principal. In production nothing is granted " +
      "implicitly, so every request including loopback needs the Basic credentials; eve " +
      "fails closed and a 401 there is the intended behavior, not a bug.",
  },
  {
    name: "channel-slack",
    title: "Slack channel",
    description:
      "Answer @mentions and DMs in Slack from a self-hosted eve agent. Bot token plus signing " +
      "secret — no Vercel account and no Connect connector.",
    files: [{ source: "agent/channels/slack.ts", target: "agent/channels/slack.ts" }],
    docs:
      "Set SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET, then point both the Event Subscriptions " +
      "request URL and the Interactivity request URL at https://<public-host>/eve/v1/slack — " +
      "eve serves events and HITL button clicks on that one route. Slack signs the " +
      "url_verification challenge too, so the signing secret must be in the environment before " +
      "you save the URL or eve answers 401 and Slack reports the challenge as failed. Minimum " +
      "bot scopes: app_mentions:read, chat:write, im:history, im:write; add channels:history " +
      "plus the message.channels event to let threads continue without re-mentioning the bot. " +
      "Localhost needs a tunnel (cloudflared, ngrok) because Slack only calls public HTTPS.",
  },
  {
    name: "channel-discord",
    title: "Discord channel",
    description:
      "Answer Discord slash commands from a self-hosted eve agent. Application public key plus " +
      "bot token — no Vercel Connect client.",
    files: [{ source: "agent/channels/discord.ts", target: "agent/channels/discord.ts" }],
    docs:
      "Set DISCORD_PUBLIC_KEY (Developer Portal > General Information) and point the " +
      "application's Interactions Endpoint URL at https://<public-host>/eve/v1/discord. eve " +
      "verifies Discord's Ed25519 signature over timestamp + raw body itself, with a five-minute " +
      "skew window — you implement no signature code, but without the public key eve has nothing " +
      "to check against and answers 401 to everything, so set it and have the agent reachable " +
      "BEFORE you save the endpoint URL or Discord's PING challenge fails and the Portal refuses " +
      "the URL. Register a command with a required string option named `message`; that name is " +
      "what eve extracts as the prompt. DISCORD_BOT_TOKEN is optional for slash commands — " +
      "replies ride the interaction token and the application id comes off the inbound payload — " +
      "and buys typing indicators, proactive sessions, and the channel-message fallback after the " +
      "15-minute interaction token expires. Set DISCORD_ALLOWED_GUILD_IDS (comma-separated) to " +
      "stop anyone who can see the command from spending your model budget; unset means any " +
      "guild, matching eve's default. Localhost needs a tunnel (cloudflared, ngrok) because " +
      "Discord only calls public HTTPS, and the tunnel must not sit behind HTTP Basic — the " +
      "signature is this route's auth, and eve's Basic policy only covers /eve/v1/session*.",
  },
  {
    name: "channel-telegram",
    title: "Telegram channel",
    description:
      "Text your self-hosted eve agent from Telegram. One BotFather token, no app review and " +
      "no workspace admin — the fastest channel to actually finish.",
    files: [{ source: "agent/channels/telegram.ts", target: "agent/channels/telegram.ts" }],
    docs:
      "Set TELEGRAM_BOT_TOKEN (BotFather /newbot) and TELEGRAM_WEBHOOK_SECRET_TOKEN (invent it: " +
      "`openssl rand -hex 32`), then register the webhook yourself — eve never calls setWebhook: " +
      "POST https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook with " +
      '{"url":"https://<public-host>/eve/v1/telegram","secret_token":"<same secret>",' +
      '"allowed_updates":["message","callback_query"]}. Include callback_query or ' +
      "human-in-the-loop buttons render but never resolve. IMPORTANT: eve 0.30 has NO polling " +
      "mode — getUpdates appears nowhere in the package and TelegramChannelConfig has no polling " +
      "option — so a laptop needs a tunnel (cloudflared, ngrok) on port 443/80/88/8443, and free " +
      "tunnels change hostname on restart, which means re-running setWebhook. The secret token is " +
      "this route's ONLY auth: eve compares the X-Telegram-Bot-Api-Secret-Token header in " +
      "constant time and answers 401 when it is unset or mismatched, and evestack's HTTP Basic " +
      "policy does not cover this route because Telegram's servers cannot send Basic " +
      "credentials. TELEGRAM_BOT_USERNAME is optional but required for @mention dispatch in " +
      "groups; without it only /commands and replies to the bot wake it there — and note that " +
      "ANY unscoped /command in a group wakes it. With no token at all the agent still boots: " +
      "the channel logs one line and stays idle. Replies are plain text with no parse_mode, so " +
      "model Markdown renders literally; the upload policy allows images and PDFs to 20 MB, the " +
      "Bot API's own getFile ceiling.",
  },
];

mkdirSync(outDir, { recursive: true });

const index = [];
for (const item of ITEMS) {
  const json = {
    $schema: "https://ui.shadcn.com/schema/registry-item.json",
    name: item.name,
    type: "registry:item",
    title: item.title,
    description: item.description,
    ...(item.dependencies ? { dependencies: item.dependencies } : {}),
    ...(item.devDependencies ? { devDependencies: item.devDependencies } : {}),
    files: item.files.map((f) => ({
      path: `registry/${item.name}/${f.target}`,
      target: f.target,
      type: "registry:file",
      content: read(f.source),
    })),
    ...(item.docs ? { docs: item.docs } : {}),
  };
  writeFileSync(join(outDir, `${item.name}.json`), `${JSON.stringify(json, null, 2)}\n`);
  // `type` is required here too: eve validates the catalog against the same
  // discriminated union as items, and entries without it fail parsing with
  // "Invalid discriminator value" — observed, not assumed.
  index.push({ name: item.name, type: "registry:item", title: item.title, description: item.description });
  console.log(`✓ r/${item.name}.json  (${item.files.length} file${item.files.length > 1 ? "s" : ""})`);
}

// The catalog MUST be named registry.json, not index.json. `eve registry list`
// resolves a namespace's catalog by substituting the literal name `registry`
// into the item URL template — so for our mapping it fetches r/registry.json.
// This shipped as index.json first, and `eve registry list --registry @evestack`
// answered "The item at .../registry.json was not found" while every
// `eve add` worked, because only the catalog lookup uses that fixed name.
writeFileSync(
  join(outDir, "registry.json"),
  `${JSON.stringify({ name: "evestack", homepage: "https://github.com/SammyTourani/evestack", items: index }, null, 2)}\n`,
);
console.log(`✓ r/registry.json  (${index.length} items)`);
