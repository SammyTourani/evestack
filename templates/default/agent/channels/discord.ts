import { defaultDiscordAuth, discordChannel } from "eve/channels/discord";

/**
 * Discord slash commands, served from your own machine.
 *
 * ─ Who authenticates this route ─
 *
 * Not the HTTP Basic policy in channels/eve.ts. That policy guards the three
 * /eve/v1/session routes only, and Discord cannot send an Authorization header
 * anyway. What guards POST /eve/v1/discord is Discord's Ed25519 signature, and
 * eve verifies it itself: `verifyDiscordRequest` checks the
 * `X-Signature-Ed25519` header against `X-Signature-Timestamp` + the exact raw
 * body using DISCORD_PUBLIC_KEY, rejects a timestamp more than five minutes
 * from now, and answers anything that fails with a bare 401 before the body is
 * even parsed. You do not have to implement this and you must not try to —
 * signature checking is not the user's job on eve, it is the adapter's.
 *
 * The one thing that IS the user's job: actually setting DISCORD_PUBLIC_KEY.
 * eve has no key to compare against without it, so every interaction fails
 * verification — including Discord's own PING probe, which is why the
 * Developer Portal refuses to save an Interactions Endpoint URL until the env
 * var is set and the agent is reachable. See docs/channels/discord.mdx.
 *
 * ─ Degrading ─
 *
 * Same contract as agent/tools/composio.ts: missing credentials never stop the
 * agent from booting. With DISCORD_PUBLIC_KEY unset the route still exists and
 * answers 401 to everything — inert, not broken, and fail-closed either way.
 *
 * DISCORD_BOT_TOKEN is narrower than eve's docs suggest. Interaction replies
 * ride the interaction token, and the application id is read off the inbound
 * payload rather than from DISCORD_APPLICATION_ID, so slash commands answer
 * correctly with only the public key set. The bot token buys three things:
 * typing indicators (failures are swallowed), the channel-message fallback for
 * when an interaction token has expired, and proactive sessions started from a
 * schedule. Those degrade quietly; commands keep working.
 */
const publicKey = process.env.DISCORD_PUBLIC_KEY;

/**
 * Optional guild allow-list, off by default so this matches eve's stock
 * behavior until you ask for something narrower.
 *
 * Worth setting if you share the bot's install URL: an interactions endpoint is
 * world-reachable, and every accepted command spends your model budget under
 * your own API key. @evestack/budget caps the dollars; this caps who can start
 * a turn at all. Interactions with no guild id — direct messages to the bot —
 * are rejected once the list is non-empty, since there is nothing to match.
 *
 * Scope note: this gates commands, which is where sessions start. HITL button
 * and modal submissions bypass onCommand entirely by design — they resume a
 * session that already exists, and their custom ids are only ever rendered
 * into a channel the agent was already allowed to answer in.
 */
const allowedGuildIds = new Set(
  (process.env.DISCORD_ALLOWED_GUILD_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);

if (!publicKey) {
  console.warn(
    "[evestack:discord] DISCORD_PUBLIC_KEY is not set, so the Discord channel is registered " +
      "but rejects every interaction, including Discord's endpoint-verification PING. " +
      "See docs/channels/discord.mdx.",
  );
}

export default discordChannel({
  onCommand: (_ctx, interaction) => {
    if (allowedGuildIds.size > 0 && !allowedGuildIds.has(interaction.guildId ?? "")) {
      // null acknowledges the interaction without dispatching, so the caller
      // sees an ephemeral "Command ignored." instead of a silent timeout.
      return null;
    }
    // Guild-scoped principal ids, which is what @evestack/budget meters on.
    return { auth: defaultDiscordAuth(interaction) };
  },
});
