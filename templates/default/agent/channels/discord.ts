import { defaultDiscordAuth, discordChannel, verifyDiscordRequest } from "eve/channels/discord";

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
 * And note what the signature proves, which is narrower than it sounds: that
 * DISCORD sent this interaction, not that a person you trust invoked it. The
 * same distinction agent/channels/telegram.ts spells out for its webhook
 * secret. Authenticating the platform is not authorizing the human, and the
 * two allow-lists below are the second half.
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
 * The two variables that decide who may start a turn over Discord.
 *
 * Declared above the boot notice because that notice reads them and `const` is
 * not hoisted. The guild list keeps its original name — it shipped, it is in
 * people's .env.local files, and renaming it would silently widen every install
 * that has one.
 */
const ALLOWED_GUILD_IDS = "DISCORD_ALLOWED_GUILD_IDS";
const ALLOWED_USER_IDS = "DISCORD_ALLOWED_USER_IDS";

/*
 * ─ The allow-list used to be off by default, and off by default it did nothing ─
 *
 * The previous version of this file read: "Optional guild allow-list, off by
 * default so this matches eve's stock behavior until you ask for something
 * narrower." Both halves of that sentence were true and the combination was the
 * finding. An interactions endpoint is world-reachable, a bot's install URL is
 * a link anyone can forward, and every accepted command starts a turn that
 * spends your API key and gets bash in a container running as root with no
 * memory, CPU, pid or time limit (see the comment block in
 * agent/sandbox/sandbox.ts). An allow-list that is empty unless somebody reads
 * the comment is an allow-list that is empty.
 *
 * So the default flipped: unset now refuses, the same rule Telegram and Slack
 * use, and for the reason set out at length in agent/channels/telegram.ts —
 * this template is copied into a project once at scaffold time and never
 * updated underneath a running install, so the choice here is what NEW projects
 * begin as, not a behaviour change pushed at anybody.
 *
 * Getting the old behaviour back is one value, not an edit:
 *
 *     DISCORD_ALLOWED_USER_IDS=*
 *
 * The USER list, and it has to be that one rather than the guild list, which is
 * the obvious guess and is subtly short. `allows()` below answers false for an
 * absent id before it ever looks at whether the list is open, so a DM — which
 * carries no guild id at all — cannot be matched by a guild list however wide
 * that list is. `DISCORD_ALLOWED_GUILD_IDS=*` therefore means "every server",
 * not "everyone": it reopens exactly the guild half of what shipped before, and
 * a DM to the bot stays refused. Every interaction carries a user id, DM or
 * not, so `DISCORD_ALLOWED_USER_IDS=*` is the one value that restores all of
 * eve's stock behaviour. An operator who reaches for the guild `*` and then
 * wonders why their DM is ignored gets told: the refusal line below names the
 * user list explicitly for a DM.
 *
 * ─ Why there is now a user list as well ─
 *
 * Because "unset = closed" made a guild-only allow-list unable to express the
 * most ordinary case this project has: one person, talking to their own bot, in
 * a DM. A direct message to the bot carries NO guild id, so it can never match
 * a guild list — under the old open default it slipped through by accident, and
 * under a closed default it would have become permanently unreachable unless
 * the operator typed `*` and reopened every server at the same time. That is a
 * trade nobody should be asked to make, so DISCORD_ALLOWED_USER_IDS matches on
 * `interaction.user.id` and is ORed with the guild list: a command is accepted
 * if its guild is listed or its invoker is.
 *
 * Components and modal submissions bypass onCommand, so the credential
 * verifier gates their signed actor before routing. Authenticated PINGs remain
 * allowed so Discord's endpoint registration still works with an empty list.
 */

// One line by default, the whole story under EVESTACK_VERBOSE. See the note in
// agent/channels/telegram.ts for why.
if (!publicKey) {
  if (verbose()) {
    console.warn(
      "[evestack:discord] DISCORD_PUBLIC_KEY is not set, so the Discord channel is registered " +
        "but rejects every interaction, including Discord's endpoint-verification PING. " +
        "See docs/channels/discord.mdx.",
    );
  } else {
    console.log("[evestack] discord idle — no DISCORD_PUBLIC_KEY (docs/channels/discord.mdx)");
  }
} else if (allowList(ALLOWED_GUILD_IDS).ids.size === 0 && allowList(ALLOWED_USER_IDS).ids.size === 0) {
  /*
   * Only with a public key set, which is the state where somebody is actually
   * trying to use this channel. An empty set is exactly "unset or blank" —
   * `*` is itself an entry, so an open list is never empty and this cannot fire
   * for somebody who has deliberately opted out.
   *
   * Advisory only: the values that DECIDE are re-read per interaction below.
   */
  if (verbose()) {
    console.warn(
      `[evestack:discord] neither ${ALLOWED_GUILD_IDS} nor ${ALLOWED_USER_IDS} is set, so every ` +
        "verified command will be acknowledged with \"Command ignored.\" and no turn will run. " +
        "Discord's signature proves the interaction came from Discord, not that you know who " +
        `invoked it. Set ${ALLOWED_GUILD_IDS} to your server id (right-click the server with ` +
        `Developer Mode on → Copy Server ID), or ${ALLOWED_USER_IDS} to your own user id for ` +
        `DMs. ${ALLOWED_USER_IDS}=* accepts anyone anywhere; ${ALLOWED_GUILD_IDS}=* opens every ` +
        "server but still refuses DMs, which carry no guild id to match. " +
        "See docs/channels/discord.mdx.",
    );
  } else {
    console.log(
      `[evestack] discord closed — set ${ALLOWED_GUILD_IDS} or ${ALLOWED_USER_IDS} ` +
        "(docs/channels/discord.mdx)",
    );
  }
}
/** `EVESTACK_VERBOSE=1` turns the one-line boot notice below into the full
 *  explanation. Defined per file on purpose: this module also ships as a
 *  standalone registry item and cannot import a sibling. */
function verbose(): boolean {
  const value = process.env.EVESTACK_VERBOSE?.trim();
  return Boolean(value) && value !== "0" && value !== "false";
}

/**
 * Read a comma-separated id allow-list out of the environment, AT CALL TIME.
 *
 * This file used to build a `Set` once, at module scope. That is the bug the
 * rewrite fixes quietly alongside the default: eve loads .env / .env.local when
 * the dev server starts and reloads them when they change, so a set frozen at
 * import is a snapshot of the environment as it stood before the project's own
 * files were read — the same reasoning that keeps agent/sandbox/sandbox.ts
 * resolving its docker options inside a factory. Frozen empty, the OLD code
 * meant "no allow-list, accept everything"; frozen empty, the new code would
 * mean "refuse the operator's own server". Both are wrong and only one of them
 * is loud, which is precisely why it survived.
 *
 * Splitting a short string per interaction costs nothing against a model call,
 * and it means editing .env.local takes effect on the next command rather than
 * on the next restart.
 *
 * Duplicated in agent/channels/telegram.ts and slack.ts rather than shared:
 * each of these files also ships as a standalone registry item and lands in
 * projects where no sibling exists to import.
 */
function allowList(variable: string): { readonly open: boolean; readonly ids: ReadonlySet<string> } {
  const entries = (process.env[variable] ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return { open: entries.includes("*"), ids: new Set(entries) };
}

/** Whether `candidate` is on `variable`'s allow-list. Empty list = nobody. */
function allows(variable: string, candidate: string | undefined): boolean {
  if (candidate === undefined || candidate === "") return false;
  const list = allowList(variable);
  return list.open || list.ids.has(candidate);
}


export default discordChannel({
  // Components and modal answers bypass onCommand. Verify the original signed
  // bytes before inspecting identity; the custom verifier replaces Eve's default.
  credentials: {
    async webhookVerifier(request, body) {
      await verifyDiscordRequest(new Request(request.url, {
        method: "POST", headers: request.headers, body,
      }), { publicKey: undefined });
      const interaction = JSON.parse(body);
      if (interaction.type === 1) return true; // Discord's authenticated PING.
      return allows(ALLOWED_GUILD_IDS, interaction.guild_id)
        || allows(ALLOWED_USER_IDS, interaction.member?.user?.id ?? interaction.user?.id);
    },
  },
  onCommand: (_ctx, interaction) => {
    const guildId = interaction.guildId;
    const userId = interaction.user.id;
    if (!allows(ALLOWED_GUILD_IDS, guildId) && !allows(ALLOWED_USER_IDS, userId)) {
      // ONE line, naming both variables and both ids, because those ids are the
      // values that have to be pasted and a refusal is otherwise indistinguishable
      // from a command that was never registered.
      console.warn(
        `[evestack:discord] refused /${interaction.commandName} from user ${userId} in ` +
          `${guildId === undefined ? "a direct message (no guild id)" : `guild ${guildId}`}: ` +
          `neither ${ALLOWED_GUILD_IDS} nor ${ALLOWED_USER_IDS} lists it. Set ` +
          `${guildId === undefined ? `${ALLOWED_USER_IDS}=${userId}` : `${ALLOWED_GUILD_IDS}=${guildId}`}` +
          ` in .env.local to allow this, or ${ALLOWED_USER_IDS}=* to accept anyone anywhere ` +
          `(${ALLOWED_GUILD_IDS}=* opens every server but not DMs, which have no guild id). ` +
          "See docs/channels/discord.mdx.",
      );
      // null acknowledges the interaction without dispatching, so the caller
      // sees an ephemeral "Command ignored." instead of a silent timeout.
      return null;
    }
    // Guild-scoped principal ids, which is what @evestack/budget meters on.
    return { auth: defaultDiscordAuth(interaction) };
  },
});
