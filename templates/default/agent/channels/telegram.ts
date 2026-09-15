import { defaultTelegramAuth, telegramChannel, verifyTelegramRequest } from "eve/channels/telegram";
// Type-only, and erased by Node's type stripping before the specifier is ever
// resolved — which is what lets test/channel-access.test.mjs stub this module
// with nothing but `telegramChannel` and `defaultTelegramAuth` on it.
import type { TelegramMessage } from "eve/channels/telegram";

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
 *
 * ─ THE SECRET TOKEN AUTHENTICATES TELEGRAM, NOT THE PERSON ─
 *
 * That distinction is the reason TELEGRAM_ALLOWED_USER_IDS exists, and it took
 * a security pass to notice it, because "this route has auth on it" reads as
 * "this route is protected" and here it is not the same sentence.
 * `verifyTelegramRequest` proves one thing: the POST came from Telegram's
 * servers rather than from someone who guessed the tunnel hostname. It says
 * nothing whatsoever about who typed the message on the other side, and a bot
 * exists to be messaged — its username is public, and anyone on Telegram can
 * open a private chat with it and press send.
 *
 * Until this file grew an `onMessage`, that was the end of the story. eve's
 * `defaultOnMessage` dispatches every private-chat message that carries text or
 * an attachment, from any account on earth, and each sender arrives as its own
 * principal. The damage is not "a stranger reads a chatty reply":
 *
 *   - Every accepted turn hands the model bash in a container that runs as root
 *     with no memory, CPU, pid or wall-clock limit. The comment block in
 *     agent/sandbox/sandbox.ts documents that and does not mitigate it.
 *   - @evestack/budget caps spend PER PRINCIPAL, so N strangers cost N times the
 *     daily cap, not one. On a local model every step is priced at zero, the cap
 *     can never trip, and the only thing rationing the machine is how fast
 *     people can type.
 *
 * So the gate belongs here, in front of dispatch, where a refusal costs one
 * comparison and no model call.
 *
 * ─ Why unset means "nobody", and how to get the old behaviour back ─
 *
 * Unset = open was the status quo and is the whole of the finding. Unset =
 * closed is what ships, and the reason it is safe to choose is a property of
 * how this file travels: the template is COPIED INTO A PROJECT ONCE, at
 * `create-evestack` time, and is never updated underneath anybody. Nothing
 * already running changes behaviour because of this edit; what changes is what
 * a project scaffolded from today onward starts life as. Given that, shipping
 * the open default would be choosing the vulnerability for people who have not
 * been born yet, to spare an upgrade that does not happen.
 *
 * Restoring eve's stock behaviour is one value, not a code edit:
 *
 *     TELEGRAM_ALLOWED_USER_IDS=*
 *
 * A single variable with three states (unset = nobody, `*` = anyone, a list =
 * those people) beats a second EVESTACK_TELEGRAM_OPEN-style switch, which can
 * disagree with the list it overrides and leaves the reader working out which
 * one wins.
 *
 * ─ A refusal has to be LOUD ─
 *
 * A dropped Telegram update looks identical from the outside to a dead tunnel,
 * a stale `setWebhook`, a wrong secret token, or an agent that is not running.
 * Those are the four things a new operator already suspects, and every one of
 * them sends them somewhere other than this variable. So the refusal path
 * prints one line that names TELEGRAM_ALLOWED_USER_IDS and the exact id that
 * was refused — which is also the value they need to paste, since Telegram
 * user ids are not discoverable from the app's UI.
 *
 * It is deliberately NOT deduplicated per user id. Suppressing repeats would
 * make the second attempt silent, and the second attempt is precisely when
 * somebody has just fixed a typo in the list and is checking whether it took.
 * One line per refused message is the cost; a bot that appears broken to the
 * person who owns it is the thing being bought.
 */
/**
 * The one variable that decides who may start a turn over Telegram.
 *
 * Declared here rather than beside the helpers below because the boot notice
 * reads it: `const` is not hoisted, and a reference from above this line is a
 * ReferenceError that takes the whole agent down at import.
 */
const ALLOWED_USER_IDS = "TELEGRAM_ALLOWED_USER_IDS";

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
} else if (allowList(ALLOWED_USER_IDS).ids.size === 0) {
  /*
   * Only reachable with a token set, which is the state where somebody is
   * actually trying to use this channel. Printed at boot rather than left for
   * the first refusal, because the first refusal happens in a chat window and
   * the person staring at that window is not necessarily watching the log.
   *
   * An empty set is exactly "unset or blank": `*` is itself an entry, so an
   * open list is never empty and this cannot fire for somebody who has
   * deliberately opted out.
   *
   * Advisory only — the value that DECIDES is re-read per message below. This
   * line can be wrong in one direction (it can say "closed" for a project whose
   * .env.local eve has not finished reading yet); the gate cannot.
   */
  if (verbose()) {
    console.warn(
      `[evestack:telegram] ${ALLOWED_USER_IDS} is not set, so this bot will accept a webhook ` +
        "from Telegram and then refuse to answer anybody. The webhook secret proves the update " +
        `came from Telegram; it does not say who sent it. Set ${ALLOWED_USER_IDS} to your own ` +
        "numeric user id (message @userinfobot to learn it), comma-separated for several, or " +
        "`*` to accept anyone as eve does by default. See docs/channels/telegram.mdx.",
    );
  } else {
    console.log(
      `[evestack] telegram closed — set ${ALLOWED_USER_IDS} (docs/channels/telegram.mdx)`,
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
 * Call time, not module load, and that is not a style preference. eve loads
 * .env / .env.local from the app root when the dev server starts
 * (`loadDevelopmentEnvironmentFiles`) and RELOADS them when the files change,
 * so anything this module froze into a `const` at import is a snapshot of
 * whatever the environment looked like before the project's own files were
 * read — the same reason agent/sandbox/sandbox.ts resolves its docker options
 * inside a factory instead of at module scope.
 *
 * The sibling Discord file used to freeze exactly this, and its failure mode
 * was the bad direction: an empty set meant "no allow-list configured", which
 * meant accept everything. Here the same mistake would refuse the operator's
 * own id forever, with a correct-looking .env.local on screen. Splitting a
 * short string per inbound message costs nothing measurable against a model
 * call, and it means editing .env.local takes effect on the next message
 * instead of on the next restart.
 *
 * `*` anywhere in the list is the documented escape hatch back to eve's stock
 * "anyone may talk to this bot" behaviour.
 */
function allowList(variable: string): { readonly open: boolean; readonly ids: ReadonlySet<string> } {
  const entries = (process.env[variable] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return { open: entries.includes("*"), ids: new Set(entries) };
}

/** Whether `candidate` is on `variable`'s allow-list. Empty list = nobody. */
function allows(variable: string, candidate: string | undefined): boolean {
  if (candidate === undefined || candidate === "") return false;
  const list = allowList(variable);
  return list.open || list.ids.has(candidate);
}

/**
 * eve's own group-chat dispatch rule, reproduced because it has to be.
 *
 * `telegramChannel` resolves the hook as `onMessage ?? defaultOnMessage`, so
 * supplying an `onMessage` does not wrap the default — it REPLACES it, and
 * `defaultOnMessage` is not exported from `eve/channels/telegram` (the package
 * exports `defaultTelegramAuth` from that module and nothing else, and there is
 * no wildcard subpath to deep-import through). This is the same trap
 * agent/channels/slack.ts documents for DMs, arriving from the other side.
 *
 * What would break without the copy below: a private chat and a group chat
 * would become the same thing. eve deliberately makes groups stricter — an
 * un-addressed message among twenty people is not a request — so the bot would
 * start a turn on every line of group chatter, each one metered, each one with
 * a container behind it.
 *
 * Transcribed from `shouldDispatchTelegramMessage` in
 * node_modules/eve/dist/src/public/channels/telegram/defaults.js at eve 0.54.3.
 * It is a copy and copies drift: if eve changes that rule, this file keeps the
 * old one until somebody re-reads it. That is the price of the hook's shape,
 * and it is cheaper than the alternative, which is having no gate at all.
 */
function shouldDispatch(message: TelegramMessage, botUsername: string | undefined): boolean {
  if (message.from?.isBot === true) return false;
  // Broadcast channel posts are parsed by eve and never dispatched.
  if (message.chat.type === "channel") return false;
  const text = message.text || message.caption;
  if (text.trim().length === 0 && message.attachments.length === 0) return false;
  return (
    message.chat.type === "private" ||
    // Replying to ANY bot's message counts, which is eve's rule, not a typo:
    // it gates on `isBot`, not on "is this bot". docs/channels/telegram.mdx
    // lists that as a sharp edge.
    message.replyToMessage?.from?.isBot === true ||
    isBotCommand(text, botUsername) ||
    (botUsername !== undefined && text.toLowerCase().includes(`@${botUsername.toLowerCase()}`))
  );
}

/** `/anything` wakes it; `/anything@someotherbot` does not. eve's rule, verbatim. */
function isBotCommand(text: string, botUsername: string | undefined): boolean {
  const match = /^\/(?<command>[A-Za-z0-9_]+)(?:@(?<target>[A-Za-z0-9_]+))?(?:\s|$)/u.exec(text);
  if (!match) return false;
  const target = match.groups?.target;
  if (target === undefined) return true;
  return botUsername !== undefined && target.toLowerCase() === botUsername.toLowerCase();
}


export default telegramChannel({
  // Eve's HITL replies bypass onMessage. Authenticate with Eve's standard
  // secret-token verifier, then authorize the actor before any routing occurs.
  credentials: {
    async webhookVerifier(request, body) {
      await verifyTelegramRequest(new Request(request.url, {
        method: "POST", headers: request.headers, body,
      }), { secretToken: undefined });
      const update = JSON.parse(body);
      const actor = update.callback_query?.from?.id ?? update.message?.from?.id
        ?? update.edited_message?.from?.id;
      return allows(ALLOWED_USER_IDS, actor == null ? undefined : String(actor));
    },
  },
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

  /**
   * Who is allowed to spend your API key and drive your container.
   *
   * THE ORDER OF THE TWO CHECKS IS LOAD-BEARING. eve's dispatch rule runs
   * first, the allow-list second, so a refusal is only ever logged for a
   * message that would otherwise have started a turn. Inverted, a bot sitting
   * in one busy group would print a refusal for every line anybody typed —
   * thousands of warnings about messages that were never addressed to it,
   * which is how the one line that matters gets lost.
   *
   * Everything after the gate reproduces `defaultOnMessage` exactly:
   * `startTyping()` before the slow part (it is fire-and-forget inside eve and
   * never throws), then eve's own auth projection. `defaultTelegramAuth` is
   * used rather than a hand-rolled object because it is what mints
   * `telegram:<userId>` and `telegram:<chatId>:<userId>` — the principal ids
   * @evestack/budget meters against, and the ones the dashboard groups by.
   *
   * HITL callbacks bypass this hook; credentials.webhookVerifier above gates
   * their signed actor before Eve dispatches either callbacks or messages.
   */
  async onMessage(ctx, message) {
    if (!shouldDispatch(message, ctx.telegram.botUsername)) return null;

    const userId = message.from?.id;
    if (!allows(ALLOWED_USER_IDS, userId)) {
      // ONE line, naming the variable and the id, because the id is the value
      // that has to be pasted and Telegram's UI will not show it to you.
      console.warn(
        `[evestack:telegram] refused a message from user id ${userId ?? "(unknown)"}` +
          `${message.from?.username ? ` (@${message.from.username})` : ""} in ` +
          `${message.chat.type} chat ${message.chat.id}: ${ALLOWED_USER_IDS} does not list it. ` +
          `Set ${ALLOWED_USER_IDS}=${userId ?? "<id>"} in .env.local to allow this person, ` +
          `or ${ALLOWED_USER_IDS}=* to accept anyone. See docs/channels/telegram.mdx.`,
      );
      // null drops the update. Deliberately no reply to the sender: answering
      // would confirm the bot is live to whoever is probing it, and would let
      // an unknown account make this agent send Telegram messages, which is the
      // amplification half of the same problem.
      return null;
    }

    // Posts before the workflow runtime cold-starts, so the chat shows life
    // during the slowest part of the turn. Failures are swallowed by eve.
    await ctx.telegram.startTyping();
    return { auth: defaultTelegramAuth(message) };
  },
});
