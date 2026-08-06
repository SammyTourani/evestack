import { telegramChannel } from "eve/channels/telegram";

/**
 * Telegram is the shortest path from "I have an agent" to "I can text my agent".
 *
 * BotFather hands you a token in about a minute: no app review, no OAuth
 * consent screen, no workspace admin to beg. That makes this the first channel
 * most self-hosters will actually finish, so it ships in the default template.
 *
 * ─ Webhook only. There is no polling mode. ─
 *
 * We checked, because polling would remove the one hard prerequisite here — a
 * public HTTPS URL. It does not exist as of eve 0.30.6. The whole Telegram
 * adapter calls exactly five Bot API methods (sendMessage, sendChatAction,
 * answerCallbackQuery, editMessageReplyMarkup, getFile) plus the raw file
 * download, and every one of them is outbound;
 * `getUpdates` appears nowhere in the package, and `TelegramChannelConfig` has
 * no polling option. The channel is a route: eve mounts POST /eve/v1/telegram
 * and waits for Telegram to call it. Nothing in eve ever calls out to fetch
 * updates, and nothing calls `setWebhook` for you either — registering the URL
 * is a curl you run once, by hand.
 *
 * So a laptop needs a tunnel (cloudflared or ngrok — see docs/channels/telegram.mdx).
 * That is a real cost and we are not going to pretend otherwise. Long-polling
 * would have to be built as a custom `defineChannel` sidecar that drives
 * `getUpdates` itself; that is a genuine piece of work, not a config flag.
 *
 * ─ Missing token is not a boot failure ─
 *
 * Same posture as agent/tools/composio.ts: an optional integration that lacks
 * its key makes the agent smaller, never broken. We still export the channel,
 * so the route table does not silently change shape depending on which env vars
 * happen to be set — a channel that vanishes is far harder to debug than one
 * that is present and says why it is idle. Inbound requests fail closed on
 * their own: eve throws unless TELEGRAM_WEBHOOK_SECRET_TOKEN is configured and
 * the X-Telegram-Bot-Api-Secret-Token header matches it in constant time.
 */
/*
 * ONE LINE, not a paragraph. This warning fires on every boot of a correctly
 * configured project that simply does not use Telegram, and it used to be three
 * sentences — one of three such blocks, so a fresh `npm run dev` opened with
 * three paragraphs about credentials the reader had not set before anything said
 * the agent had started. Warnings that always fire are how people learn to
 * scroll past output. The full explanation moved behind EVESTACK_VERBOSE, which
 * is where you want it the moment you actually try to configure this.
 */
if (!process.env.TELEGRAM_BOT_TOKEN) {
  if (verbose()) {
    console.warn(
      "[evestack:telegram] TELEGRAM_BOT_TOKEN is not set, so the Telegram channel is idle. " +
        "Everything else works. See docs/channels/telegram.mdx to get a token from BotFather.",
    );
  } else {
    console.log("[evestack] telegram idle — no TELEGRAM_BOT_TOKEN (docs/channels/telegram.mdx)");
  }
}
/** `EVESTACK_VERBOSE=1` turns the one-line boot notice below into the full
 *  explanation. Defined per file on purpose: this module also ships as a
 *  standalone registry item and cannot import a sibling. */
function verbose(): boolean {
  const value = process.env.EVESTACK_VERBOSE?.trim();
  return Boolean(value) && value !== "0" && value !== "false";
}


export default telegramChannel({
  // Without this, an `@yourbot` mention in a group is indistinguishable from any
  // other message and eve ignores it — group dispatch then only fires on
  // /commands and replies to the bot. Private chats work either way, which is
  // why this stays optional rather than being a second required variable.
  botUsername: process.env.TELEGRAM_BOT_USERNAME,

  // eve's default policy is 25 MB and every media type. Both halves are wrong
  // here: the Bot API refuses to serve a file over 20 MB through getFile, so the
  // higher cap only converts a clean rejection into a failed download, and
  // "every media type" hands the model whatever a stranger in a group chat
  // decides to attach. Images and PDFs are what a chat agent can actually read.
  uploadPolicy: {
    allowedMediaTypes: ["image/*", "application/pdf"],
    maxBytes: 20 * 1024 * 1024,
  },
});
