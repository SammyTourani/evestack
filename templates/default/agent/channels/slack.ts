import { defaultSlackAuth, slackChannel } from "eve/channels/slack";

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
 * Setup, scope by scope, is in docs/channels/slack.mdx.
 */
const missing = ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"].filter(
  (name) => !process.env[name],
);
if (missing.length > 0) {
  console.warn(
    `[evestack:slack] ${missing.join(" and ")} not set, so the Slack channel is registered ` +
      "but idle: unsigned inbound requests get a 401 and outbound Web API calls throw. " +
      "Everything else works. See docs/channels/slack.mdx.",
  );
}

export default slackChannel({
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
   */
  async onAppMention(ctx, message) {
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
   */
  async onMessage(ctx, message) {
    if (message.author?.isBot) return null;

    const isDirectMessage = message.raw.channel_type === "im";
    // Local session lookup, not a Slack API call — cheap enough to gate on.
    if (!isDirectMessage && !(await ctx.isSubscribed())) return null;

    // Posts before the workflow runtime cold-starts, so the thread shows life
    // during the slowest part of the turn. Failures are swallowed by eve.
    await ctx.thread.startTyping("Thinking…");
    return { auth: defaultSlackAuth(message, ctx) };
  },
});
