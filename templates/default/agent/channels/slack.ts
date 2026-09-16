import { defaultSlackAuth, slackChannel } from "eve/channels/slack";
// Type-only, and erased by Node's type stripping before the specifier is ever
// resolved — which is what lets test/channel-access.test.mjs stub this module
// with nothing but `slackChannel` and `defaultSlackAuth` on it.
import type { SlackMessage } from "eve/channels/slack";

/**
 * Slack without a Vercel account.
 *
 * eve's bundled Slack doc is written entirely around Vercel Connect and says
 * outright that "there's no SLACK_BOT_TOKEN or SLACK_SIGNING_SECRET for you to
 * manage". That is a description of the Connect path, not a requirement of the
 * adapter. In eve 0.30.6 `credentials` is optional and every field falls back
 * to the environment: `resolveSlackBotToken` defaults to
 * `process.env.SLACK_BOT_TOKEN`, and inbound verification defaults to
 * `process.env.SLACK_SIGNING_SECRET` whenever no `webhookVerifier` was passed.
 * Connect is one implementation of `webhookVerifier` — the escape hatch, not
 * the contract. So this file passes no `credentials` at all and lets the two
 * environment variables Slack already hands you do the work.
 *
 * Missing credentials degrade to a closed door rather than a crash. The route
 * is registered either way; without a signing secret `verifySlackRequest`
 * throws, the channel logs one warning and answers 401, and the rest of the
 * agent is untouched. That is the right failure — an unsigned webhook endpoint
 * is an open inbox for anyone who guesses the URL.
 *
 * Note that this route is NOT covered by the HTTP Basic policy in
 * `agent/channels/eve.ts`. Route auth there guards the three eve session
 * routes; a channel's own routes carry their own verification, which for Slack
 * is the HMAC over `v0:{timestamp}:{body}` plus a 300-second skew window. Do
 * not put Basic auth in front of this path in a reverse proxy: Slack cannot
 * answer a challenge, and you would be trading a signature check for nothing.
 *
 * ─ The signature authenticates SLACK, not the speaker ─
 *
 * Which is the narrower claim, and the reason SLACK_ALLOWED_USER_IDS exists.
 * The HMAC proves the request came from Slack rather than from someone who
 * found the tunnel; it says nothing about who typed the message. Before the
 * allow-list, anybody in the workspace could DM this bot — or reply into a
 * thread it was already in — and get a turn with bash in a container that runs
 * as root with no memory, CPU, pid or time limit (see the comment block in
 * agent/sandbox/sandbox.ts), metered under their own principal, so
 * @evestack/budget's per-principal daily cap multiplied by the number of people
 * in the workspace rather than capping it.
 *
 * "Everybody here is a colleague" is a weaker boundary than it sounds in a
 * workspace with guests, Slack Connect channels, or a shared-channel partner —
 * and it is no boundary at all once a single account is phished.
 *
 * Unset now means NOBODY, matching agent/channels/telegram.ts, which carries
 * the full argument for that default. `SLACK_ALLOWED_USER_IDS=*` restores the
 * previous "anyone in the workspace" behaviour in one value.
 *
 * Setup, scope by scope, is in docs/channels/slack.mdx.
 */
/** The one variable that decides who may start a turn over Slack. Declared
 *  above the boot notice that reads it, because `const` is not hoisted. */
const ALLOWED_USER_IDS = "SLACK_ALLOWED_USER_IDS";

const missing = ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"].filter(
  (name) => !process.env[name],
);
// One line by default, the whole story under EVESTACK_VERBOSE. See the note in
// agent/channels/telegram.ts for why.
if (missing.length > 0) {
  if (verbose()) {
    console.warn(
      `[evestack:slack] ${missing.join(" and ")} not set, so the Slack channel is registered ` +
        "but idle: unsigned inbound requests get a 401 and outbound Web API calls throw. " +
        "Everything else works. See docs/channels/slack.mdx.",
    );
  } else {
    console.log(
      `[evestack] slack idle — no ${missing.join("/")} (docs/channels/slack.mdx)`,
    );
  }
} else if (allowList(ALLOWED_USER_IDS).ids.size === 0) {
  /*
   * Only once both credentials are present, which is the state where somebody
   * is actually trying to use this channel. An empty set is exactly "unset or
   * blank": `*` is itself an entry, so an open list is never empty and this
   * cannot fire for somebody who has deliberately opted out.
   *
   * Advisory only — the value that DECIDES is re-read per message below.
   */
  if (verbose()) {
    console.warn(
      `[evestack:slack] ${ALLOWED_USER_IDS} is not set, so this app will verify Slack's ` +
        "signature and then decline to answer anybody. The signature proves the event came " +
        `from Slack; it does not say who spoke. Set ${ALLOWED_USER_IDS} to your own Slack user ` +
        "id (profile → ⋮ → Copy member ID, shaped like U01ABCDEFGH), comma-separated for " +
        "several, or `*` to accept every member of the workspace. See docs/channels/slack.mdx.",
    );
  } else {
    console.log(`[evestack] slack closed — set ${ALLOWED_USER_IDS} (docs/channels/slack.mdx)`);
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
 * Call time, not module load: eve loads .env / .env.local when the dev server
 * starts and reloads them when they change, so a `Set` frozen at import is a
 * snapshot of the environment as it stood before the project's own files were
 * read — the same reasoning that keeps agent/sandbox/sandbox.ts resolving its
 * docker options inside a factory, and the bug the sibling Discord file used to
 * carry. Splitting a short string per inbound message costs nothing against a
 * model call, and it means editing .env.local takes effect on the next message
 * rather than on the next restart.
 *
 * Duplicated across the three channel files rather than shared, because each of
 * them also ships as a standalone registry item and lands in projects where no
 * sibling exists to import. `*` anywhere in the list is the escape hatch.
 */
function allowList(variable: string): { readonly open: boolean; readonly ids: ReadonlySet<string> } {
  const entries = (process.env[variable] ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return { open: entries.includes("*"), ids: new Set(entries) };
}

/**
 * Whether this Slack user may start a turn, and ONE loud line when they may not.
 *
 * Shared by both hooks below so a refusal reads the same wherever it came from,
 * and so the two paths cannot drift into one being open. A dropped Slack event
 * is invisible from Slack's side — no error, no ephemeral, nothing in the
 * thread — so the log line is the only evidence that exists, and it names the
 * variable and the member id that has to go in it.
 *
 * Deliberately not deduplicated per user: suppressing repeats makes the SECOND
 * attempt silent, and the second attempt is when somebody has just fixed a typo
 * in the list and is checking whether it took.
 */
function permits(message: SlackMessage): boolean {
  const userId = message.author?.userId;
  const list = allowList(ALLOWED_USER_IDS);
  if (userId !== undefined && (list.open || list.ids.has(userId))) return true;
  console.warn(
    `[evestack:slack] refused a message from user ${userId ?? "(unknown)"} in channel ` +
      `${message.channelId}: ${ALLOWED_USER_IDS} does not list it. Set ` +
      `${ALLOWED_USER_IDS}=${userId ?? "<member id>"} in .env.local to allow this person, or ` +
      `${ALLOWED_USER_IDS}=* to accept every member of the workspace. ` +
      "See docs/channels/slack.mdx.",
  );
  return false;
}


export default slackChannel({
  onInputResponse(ctx, submission) {
    const userId = submission.user.id;
    const list = allowList(ALLOWED_USER_IDS);
    if (!userId || (!list.open && !list.ids.has(userId))) return null;
    return { auth: ctx.defaultAuth };
  },
  /**
   * The baseline path: `@evestack do a thing` in a channel.
   *
   * This looks redundant with eve's `defaultOnAppMention` — it is deliberately
   * identical to it — but omitting it silently breaks the channel's single most
   * important interaction. eve resolves an inbound event to a handler with
   * `(kind === "app_mention" ? onAppMention : onDirectMessage) ?? onMessage`,
   * so defining `onMessage` alone captures app mentions too. They then hit the
   * `isSubscribed()` gate below, which is false for a first mention because no
   * session exists yet, and the turn is dropped: the bot ignores you until it
   * has already answered you once, which it never does. Verified by driving a
   * signed `app_mention` through the route handler — zero turns dispatched.
   *
   * So: mentions dispatch unconditionally here, and `onMessage` is left to mean
   * only "un-addressed chatter", which is the case that actually needs a gate.
   *
   * The allow-list applies here too, and that is a choice rather than an
   * oversight. The finding named the DM branch, but an `@evestack` in a channel
   * starts exactly the same turn on exactly the same key, so gating one and not
   * the other would leave an operator who set the variable believing Slack was
   * closed while the loudest path stayed open. It runs BEFORE `startTyping()`
   * so a refused person gets no indicator — and no API call is spent on them.
   */
  async onAppMention(ctx, message) {
    if (!permits(message)) return null;

    await ctx.thread.startTyping("Thinking…");
    return { auth: defaultSlackAuth(message, ctx) };
  },

  /**
   * Lets a thread continue without re-@-mentioning the bot on every reply.
   *
   * Inert until you subscribe to `message.channels` (or `message.groups`) and
   * grant the matching history scope — Slack simply never delivers the event —
   * so the minimal install of app_mention + DMs is unaffected by this hook.
   *
   * Two things about the shape of it are load-bearing:
   *
   * Defining `onMessage` takes DMs away from eve's built-in DM default, since
   * `onDirectMessage ?? onMessage` resolves here. Hence the explicit DM branch:
   * it reproduces the default's auth derivation and typing indicator instead of
   * silently downgrading DMs.
   *
   * And there is deliberately no mention check. eve drops channel messages
   * whose text contains `<@botUserId>` before this hook ever runs, because the
   * same message already arrived as a separately-delivered `app_mention` with
   * its own event id — the dedupe cache is keyed on event id and would not
   * catch it. Everything reaching the channel branch below is therefore
   * un-addressed chatter, and only a thread this agent is already in should
   * wake it. (`ctx.isBotMentioned()` is consequently always false here, which
   * is worth knowing before you copy the snippet from eve's docs.)
   *
   * THE ALLOW-LIST GOES LAST, after the bot check and after `isSubscribed()`,
   * and the order is the whole reason a refusal is readable. Checked first, it
   * would log a line for every message anybody typed in any channel the app can
   * see — thousands of refusals for chatter that was never going to wake the
   * agent, burying the one refusal that is somebody actually trying to use it.
   * Last, a logged refusal always means "this would have started a turn".
   */
  async onMessage(ctx, message) {
    if (message.author?.isBot) return null;

    const isDirectMessage = message.raw.channel_type === "im";
    // Local session lookup, not a Slack API call — cheap enough to gate on.
    if (!isDirectMessage && !(await ctx.isSubscribed())) return null;

    if (!permits(message)) return null;

    // Posts before the workflow runtime cold-starts, so the thread shows life
    // during the slowest part of the turn. Failures are swallowed by eve.
    await ctx.thread.startTyping("Thinking…");
    return { auth: defaultSlackAuth(message, ctx) };
  },
});
