/**
 * Who is allowed to start a turn over Telegram, Discord and Slack.
 *
 * ─ The bug this file was written against ─────────────────────────────────────
 *
 * All three channels verify their caller and none of them used to authorize
 * one, and the gap between those two words is the whole finding. Telegram's
 * secret token proves a webhook came from Telegram; Discord's Ed25519 signature
 * proves an interaction came from Discord; Slack's HMAC proves an event came
 * from Slack. Not one of them says anything about the person who typed the
 * message, and a bot exists to be messaged.
 *
 * Measured on the previous files: `agent/channels/telegram.ts` defined no
 * `onMessage` at all, so eve's `defaultOnMessage` ran and every private-chat
 * message from any Telegram account on earth started a turn.
 * `agent/channels/discord.ts` had DISCORD_ALLOWED_GUILD_IDS but gated on
 * `size > 0`, so the shipped default — empty — accepted every guild.
 * `agent/channels/slack.ts` dispatched for any member of the workspace in its
 * DM branch. Each of those turns gets bash in a container that runs as root
 * with no memory, CPU, pid or time limit, and @evestack/budget meters PER
 * PRINCIPAL, so N strangers cost N times the daily cap — zero of it on a local
 * model, whose steps are priced at nothing.
 *
 * ─ Why the assertions are driven through the captured config ─────────────────
 *
 * Same reasoning as test/sandbox-network.test.mjs: a helper tested in isolation
 * cannot catch the edit that matters most, which is the hook being deleted,
 * renamed, or wired to the wrong place. So `eve/channels/*` is replaced by a
 * recording stub, each module under test is the real one, and every assertion
 * below runs the exact function object eve would have been handed. A file that
 * stops passing `onMessage` fails here even if its allow-list logic is perfect.
 *
 * The second thing this file pins is the half that is easy to break while
 * fixing the first: defining `onMessage` REPLACES eve's `defaultOnMessage`
 * rather than wrapping it (`telegramChannel` resolves `onMessage ??
 * defaultOnMessage`), and `defaultOnMessage` is not exported from the package,
 * so the group-chat dispatch rule had to be reproduced by hand in
 * agent/channels/telegram.ts. Without the group tests below, an allow-list
 * landing correctly and a bot that answers every line of chatter in every group
 * it is in look identical.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";

/** Config object each channel factory was handed, keyed by channel. */
const CONFIGS = {};
globalThis.__evestackChannelConfigs = CONFIGS;

/** A module whose source is `source`, resolvable without touching the disk. */
const stub = (source) => `data:text/javascript,${encodeURIComponent(source)}`;

/*
 * The stubs answer with a tagged auth object rather than a real one. That is
 * what lets the dispatch assertions say something stronger than "it returned
 * truthy": they prove the handler minted its auth through eve's own
 * `default*Auth`, which is what produces the `telegram:<userId>` /
 * `discord:<guild>:<user>` / `slack:<team>:<user>` principal ids that
 * @evestack/budget meters and the dashboard groups by. A hand-rolled auth
 * object would pass a truthiness check and quietly break both.
 */
const STUBS = {
  "eve/channels/telegram": stub(
    "export async function verifyTelegramRequest(request) { if (request.headers.get('test-verified') !== 'yes') throw Error('bad signature'); return request.text(); }\n" +
    "export function telegramChannel(config) {\n" +
      "  globalThis.__evestackChannelConfigs.telegram = config;\n" +
      "  return { name: 'telegram' };\n" +
      "}\n" +
      "export function defaultTelegramAuth(message) {\n" +
      "  return { via: 'eve.defaultTelegramAuth', principalId: 'telegram:' + message.from?.id };\n" +
      "}\n",
  ),
  "eve/channels/discord": stub(
    "export async function verifyDiscordRequest(request) { if (request.headers.get('test-verified') !== 'yes') throw Error('bad signature'); return request.text(); }\n" +
    "export function discordChannel(config) {\n" +
      "  globalThis.__evestackChannelConfigs.discord = config;\n" +
      "  return { name: 'discord' };\n" +
      "}\n" +
      "export function defaultDiscordAuth(interaction) {\n" +
      "  return { via: 'eve.defaultDiscordAuth', principalId: 'discord:' + interaction.user.id };\n" +
      "}\n",
  ),
  "eve/channels/slack": stub(
    "export function slackChannel(config) {\n" +
      "  globalThis.__evestackChannelConfigs.slack = config;\n" +
      "  return { name: 'slack' };\n" +
      "}\n" +
      "export function defaultSlackAuth(message) {\n" +
      "  return { via: 'eve.defaultSlackAuth', principalId: 'slack:' + message.author?.userId };\n" +
      "}\n",
  ),
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const replacement = STUBS[specifier];
    if (replacement !== undefined) return { url: replacement, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

/** Every variable these three modules read, so the developer's shell cannot decide a test. */
const CHANNEL_ENV = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_BOT_USERNAME",
  "TELEGRAM_ALLOWED_USER_IDS",
  "DISCORD_PUBLIC_KEY",
  "DISCORD_ALLOWED_GUILD_IDS",
  "DISCORD_ALLOWED_USER_IDS",
  "SLACK_BOT_TOKEN",
  "SLACK_SIGNING_SECRET",
  "SLACK_ALLOWED_USER_IDS",
  "EVESTACK_VERBOSE",
];
for (const name of CHANNEL_ENV) delete process.env[name];

/** Lines written to console.log/console.warn while `body` ran, in order. */
async function capturing(body) {
  const lines = [];
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = (...args) => lines.push(args.join(" "));
  console.warn = (...args) => lines.push(args.join(" "));
  try {
    await body();
  } finally {
    console.log = realLog;
    console.warn = realWarn;
  }
  return lines;
}

/** Run `body` with exactly `values` applied to the environment, then restore it. */
async function withEnv(values, body) {
  const before = {};
  for (const [name, value] of Object.entries(values)) {
    before[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await body();
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/*
 * Imported with every channel credentialled and no allow-list anywhere, because
 * that is the state a fresh `create-evestack` project boots in and the only
 * state in which the three "closed" boot notices can fire. Dynamic, because the
 * resolve hook has to be installed before these modules resolve their own
 * imports; `import type { … }` lines in them are erased by Node's type
 * stripping and never reach the hook at all.
 */
const BOOT_LINES = await capturing(async () => {
  await withEnv(
    {
      TELEGRAM_BOT_TOKEN: "123456789:AAH-test",
      DISCORD_PUBLIC_KEY: "0".repeat(64),
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_SIGNING_SECRET: "signing-secret",
    },
    async () => {
      await import("../agent/channels/telegram.ts");
      await import("../agent/channels/discord.ts");
      await import("../agent/channels/slack.ts");
    },
  );
});

/* -------------------------------------------------------------------------- */
/* the boot notice                                                             */
/* -------------------------------------------------------------------------- */

/*
 * A closed default that says nothing at boot is a bot that looks broken, and
 * "the bot is broken" sends people to the tunnel, to setWebhook, to the signing
 * secret — everywhere except the one variable. The notice has to fire only when
 * somebody is actually trying to use the channel, which is why each is gated on
 * that channel's credentials being present rather than printing on every boot.
 */
test("a credentialled channel with no allow-list says so at boot, in one line, naming the variable", () => {
  const closed = BOOT_LINES.filter((line) => line.includes("closed"));
  assert.equal(closed.length, 3, `expected one closed notice per channel, got: ${BOOT_LINES.join(" | ")}`);
  assert.ok(
    closed.some((line) => line.includes("telegram") && line.includes("TELEGRAM_ALLOWED_USER_IDS")),
  );
  assert.ok(
    closed.some((line) => line.includes("discord") && line.includes("DISCORD_ALLOWED_GUILD_IDS")),
  );
  assert.ok(closed.some((line) => line.includes("slack") && line.includes("SLACK_ALLOWED_USER_IDS")));
  for (const line of closed) {
    assert.ok(!line.includes("\n"), `boot notices are one line each: ${JSON.stringify(line)}`);
  }
});

/* -------------------------------------------------------------------------- */
/* telegram                                                                    */
/* -------------------------------------------------------------------------- */

test("telegram defines onMessage at all", () => {
  // The original file passed only `botUsername` and `uploadPolicy`, which left
  // eve's `defaultOnMessage` in charge — the finding, in one assertion.
  assert.equal(typeof CONFIGS.telegram?.onMessage, "function");
});

/** One inbound Telegram message, shaped the way eve's parser hands it over. */
function telegramMessage(overrides = {}) {
  return {
    attachments: [],
    caption: "",
    chat: { id: "555", type: "private" },
    from: { id: "42", isBot: false, username: "stranger" },
    messageId: "1",
    raw: {},
    text: "hello",
    ...overrides,
  };
}

/** A Telegram context that records whether the typing indicator was sent. */
function telegramContext(botUsername) {
  const typed = [];
  return {
    typed,
    ctx: { telegram: { botUsername, startTyping: async () => void typed.push("typing") } },
  };
}

/** Drive the wired `onMessage` and report what it returned, what it typed, and what it said. */
async function telegramInbound(env, message, botUsername = undefined) {
  let result;
  let typed;
  const lines = await capturing(async () => {
    await withEnv(env, async () => {
      const context = telegramContext(botUsername);
      typed = context.typed;
      result = await CONFIGS.telegram.onMessage(context.ctx, message);
    });
  });
  return { result, typed, lines };
}

test("telegram: with no allow-list, a stranger in a private chat is refused", async () => {
  const { result, typed, lines } = await telegramInbound(
    { TELEGRAM_ALLOWED_USER_IDS: undefined },
    telegramMessage(),
  );
  assert.equal(result, null, "eve's default would have dispatched this");
  assert.deepEqual(typed, [], "a refused sender is not told the bot is alive, and costs no API call");
  assert.equal(lines.length, 1, `exactly one line per refusal, got: ${lines.join(" | ")}`);
  assert.ok(!lines[0].includes("\n"), "and it is one line, not a paragraph");
  assert.match(lines[0], /TELEGRAM_ALLOWED_USER_IDS/, "names the variable to set");
  assert.match(lines[0], /\b42\b/, "and the id that has to go in it");
});

test("telegram: a listed id dispatches, with eve's own auth and a typing indicator", async () => {
  const { result, typed, lines } = await telegramInbound(
    { TELEGRAM_ALLOWED_USER_IDS: "42" },
    telegramMessage(),
  );
  assert.deepEqual(result, {
    auth: { via: "eve.defaultTelegramAuth", principalId: "telegram:42" },
  });
  assert.deepEqual(typed, ["typing"], "the default's typing indicator must not be lost");
  assert.deepEqual(lines, [], "an accepted message is not a log event");
});

test("telegram: the list tolerates the shapes a .env line actually has", async () => {
  for (const value of ["42", " 42 ", "7,42", "7, 42, 9", "\t42\n", "42,", ",42"]) {
    const { result } = await telegramInbound({ TELEGRAM_ALLOWED_USER_IDS: value }, telegramMessage());
    assert.ok(result, `TELEGRAM_ALLOWED_USER_IDS=${JSON.stringify(value)} refused a listed id`);
  }
});

test("telegram: `*` is the documented way back to eve's stock behaviour", async () => {
  // The backward-compatibility escape hatch. If this breaks, an operator who
  // deliberately wants an open bot has no setting left and must edit code.
  const { result } = await telegramInbound(
    { TELEGRAM_ALLOWED_USER_IDS: "*" },
    telegramMessage({ from: { id: "999999", isBot: false } }),
  );
  assert.deepEqual(result, {
    auth: { via: "eve.defaultTelegramAuth", principalId: "telegram:999999" },
  });
});

test("telegram: an id that merely looks similar is not on the list", async () => {
  for (const value of ["4", "420", "142", "42x"]) {
    const { result } = await telegramInbound({ TELEGRAM_ALLOWED_USER_IDS: value }, telegramMessage());
    assert.equal(result, null, `TELEGRAM_ALLOWED_USER_IDS=${value} let user 42 through`);
  }
});

test("telegram: the allow-list is read per message, not frozen at import", async () => {
  // The Discord file used to freeze its Set at module scope. eve loads
  // .env/.env.local when the dev server starts and reloads them on change, so a
  // frozen list is whatever the environment held before the project's own files
  // were read. Frozen empty, this gate would refuse the operator forever.
  const refused = await telegramInbound({ TELEGRAM_ALLOWED_USER_IDS: undefined }, telegramMessage());
  assert.equal(refused.result, null);
  const allowed = await telegramInbound({ TELEGRAM_ALLOWED_USER_IDS: "42" }, telegramMessage());
  assert.ok(allowed.result, "a value set after import never took effect");
});

/*
 * eve's group rule, which this file now owns because defining `onMessage`
 * replaces `defaultOnMessage` outright. Each row is a message from an ALLOWED
 * user, so nothing here can pass or fail because of the allow-list: what is
 * under test is only whether the reproduction of `shouldDispatchTelegramMessage`
 * survived the rewrite.
 */
const GROUP_CASES = [
  ["un-addressed group chatter", { chat: { id: "-100", type: "supergroup" }, text: "lunch?" }, false],
  ["an @mention of this bot", { chat: { id: "-100", type: "supergroup" }, text: "hey @my_bot do it" }, true],
  ["a bare /command", { chat: { id: "-100", type: "supergroup" }, text: "/ask something" }, true],
  ["a /command aimed at this bot", { chat: { id: "-100", type: "supergroup" }, text: "/ask@my_bot x" }, true],
  ["a /command aimed elsewhere", { chat: { id: "-100", type: "supergroup" }, text: "/roll@other_bot" }, false],
  [
    "a reply to a bot message",
    {
      chat: { id: "-100", type: "supergroup" },
      text: "yes",
      replyToMessage: { chat: { id: "-100", type: "supergroup" }, from: { id: "9", isBot: true }, messageId: "0" },
    },
    true,
  ],
  ["a broadcast channel post", { chat: { id: "-200", type: "channel" }, text: "/ask anything" }, false],
  ["an empty message with no attachment", { text: "", caption: "" }, false],
  [
    "a caption on a photo, in a private chat",
    { text: "", caption: "what is this?", attachments: [{ fileId: "f", kind: "photo" }] },
    true,
  ],
  ["a message from another bot", { from: { id: "42", isBot: true } }, false],
];

test("telegram: eve's dispatch rule survived taking over onMessage", async () => {
  for (const [what, overrides, expected] of GROUP_CASES) {
    const { result } = await telegramInbound(
      { TELEGRAM_ALLOWED_USER_IDS: "42", TELEGRAM_BOT_USERNAME: "my_bot" },
      telegramMessage(overrides),
      "my_bot",
    );
    assert.equal(Boolean(result), expected, `${what}: expected dispatch=${expected}`);
  }
});

test("telegram: chatter that would never have woken the bot logs nothing", async () => {
  // Ordering, and it is the difference between a usable log and a useless one.
  // The allow-list is checked AFTER eve's dispatch rule, so a bot sitting in one
  // busy group does not print a refusal for every line anybody types.
  const { result, lines } = await telegramInbound(
    { TELEGRAM_ALLOWED_USER_IDS: undefined, TELEGRAM_BOT_USERNAME: "my_bot" },
    telegramMessage({ chat: { id: "-100", type: "supergroup" }, text: "lunch?" }),
    "my_bot",
  );
  assert.equal(result, null);
  assert.deepEqual(lines, [], "a refusal must mean 'this would have started a turn'");
});

test("telegram: a message with no sender at all is refused rather than run anonymously", async () => {
  // `defaultTelegramAuth` answers null for a message with no `from`, and eve
  // treats `{ auth: null }` as a dispatched anonymous turn. Nothing anonymous
  // gets a container here.
  const { result, lines } = await telegramInbound(
    { TELEGRAM_ALLOWED_USER_IDS: "42" },
    telegramMessage({ from: undefined }),
  );
  assert.equal(result, null);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /TELEGRAM_ALLOWED_USER_IDS/);
});

/* -------------------------------------------------------------------------- */
/* discord                                                                     */
/* -------------------------------------------------------------------------- */

/** One inbound Discord slash command, shaped the way eve's parser hands it over. */
function discordCommand(overrides = {}) {
  return {
    applicationId: "app",
    channelId: "chan",
    commandName: "ask",
    id: "interaction",
    options: [],
    raw: {},
    token: "tok",
    user: { id: "77", isBot: false, username: "stranger" },
    guildId: "1000",
    ...overrides,
  };
}

/** Drive the wired `onCommand` and report what it returned and what it said. */
async function discordInbound(env, interaction) {
  let result;
  const lines = await capturing(async () => {
    await withEnv(env, async () => {
      result = await CONFIGS.discord.onCommand({ discord: {} }, interaction);
    });
  });
  return { result, lines };
}

test("discord: an empty allow-list now refuses instead of accepting every guild", async () => {
  // The exact inversion: the old file gated on `size > 0`, so the shipped
  // default of "" meant every guild on Discord.
  const { result, lines } = await discordInbound(
    { DISCORD_ALLOWED_GUILD_IDS: undefined, DISCORD_ALLOWED_USER_IDS: undefined },
    discordCommand(),
  );
  assert.equal(result, null);
  assert.equal(lines.length, 1, `exactly one line per refusal, got: ${lines.join(" | ")}`);
  assert.ok(!lines[0].includes("\n"));
  assert.match(lines[0], /DISCORD_ALLOWED_GUILD_IDS/);
  assert.match(lines[0], /\b1000\b/, "names the guild that was refused");
  assert.match(lines[0], /\b77\b/, "and the user, since a DM has no guild to name");
});

test("discord: a listed guild dispatches with eve's own auth", async () => {
  const { result, lines } = await discordInbound(
    { DISCORD_ALLOWED_GUILD_IDS: "2000, 1000", DISCORD_ALLOWED_USER_IDS: undefined },
    discordCommand(),
  );
  assert.deepEqual(result, { auth: { via: "eve.defaultDiscordAuth", principalId: "discord:77" } });
  assert.deepEqual(lines, []);
});

test("discord: `*` restores the previous any-guild behaviour", async () => {
  const { result } = await discordInbound(
    { DISCORD_ALLOWED_GUILD_IDS: "*", DISCORD_ALLOWED_USER_IDS: undefined },
    discordCommand({ guildId: "999999999" }),
  );
  assert.ok(result, "the documented escape hatch stopped working");
});

test("discord: guild `*` opens every server but not DMs; only user `*` reopens everything", async () => {
  // Pins the asymmetry the prose has to keep telling the truth about. `allows()`
  // answers false for an absent id BEFORE it looks at whether the list is open,
  // so a DM — which carries no guild id at all — cannot be matched by a guild
  // list however wide. That makes DISCORD_ALLOWED_GUILD_IDS=* only half of the
  // pre-change behaviour, which accepted DMs too, and DISCORD_ALLOWED_USER_IDS=*
  // the single value that restores all of it. The docs, the boot notice and the
  // refusal line all say exactly that; if somebody later decides the guild `*`
  // should swallow DMs as well, this row fails and sends them to those three
  // places rather than letting code and prose drift apart in silence.
  const dm = discordCommand({ guildId: undefined });
  const guildStar = await discordInbound(
    { DISCORD_ALLOWED_GUILD_IDS: "*", DISCORD_ALLOWED_USER_IDS: undefined },
    dm,
  );
  assert.equal(guildStar.result, null, "a guild allow-list cannot match an interaction with no guild");
  assert.match(
    guildStar.lines[0],
    /DISCORD_ALLOWED_USER_IDS/,
    "and the refusal has to name the list that CAN match it",
  );

  const userStar = await discordInbound(
    { DISCORD_ALLOWED_GUILD_IDS: undefined, DISCORD_ALLOWED_USER_IDS: "*" },
    dm,
  );
  assert.ok(userStar.result, "the documented full-reopen value stopped working");
});

test("discord: a DM has no guild id, so only the user list can allow it", async () => {
  // Why DISCORD_ALLOWED_USER_IDS exists at all. Under a closed default, a guild
  // allow-list cannot express "just me, in a DM to my own bot" — the most
  // ordinary case this project has — because the interaction carries no guild.
  const dm = discordCommand({ guildId: undefined });
  const refused = await discordInbound(
    { DISCORD_ALLOWED_GUILD_IDS: "1000", DISCORD_ALLOWED_USER_IDS: undefined },
    dm,
  );
  assert.equal(refused.result, null);
  assert.match(refused.lines[0], /direct message/, "and says so, rather than naming an absent guild");

  const allowed = await discordInbound(
    { DISCORD_ALLOWED_GUILD_IDS: undefined, DISCORD_ALLOWED_USER_IDS: "77" },
    dm,
  );
  assert.deepEqual(allowed.result, { auth: { via: "eve.defaultDiscordAuth", principalId: "discord:77" } });
});

test("discord: the two lists are ORed, so a listed user is allowed in an unlisted guild", async () => {
  const { result } = await discordInbound(
    { DISCORD_ALLOWED_GUILD_IDS: "2000", DISCORD_ALLOWED_USER_IDS: "77" },
    discordCommand({ guildId: "1000" }),
  );
  assert.ok(result);
});

/* -------------------------------------------------------------------------- */
/* slack                                                                       */
/* -------------------------------------------------------------------------- */

/** One inbound Slack message, shaped the way eve's parser hands it over. */
function slackMessage(overrides = {}) {
  return {
    attachments: [],
    author: { userId: "U42", userName: "stranger", fullName: undefined, isBot: false, isMe: false },
    channelId: "C1",
    markdown: "hello",
    raw: { channel_type: "im" },
    teamId: "T1",
    text: "hello",
    threadTs: "1.0",
    ts: "1.0",
    ...overrides,
  };
}

/** A Slack context that records typing and answers `isSubscribed` as told. */
function slackContext(isSubscribed) {
  const typed = [];
  return {
    typed,
    ctx: {
      thread: { startTyping: async (status) => void typed.push(status) },
      isSubscribed: async () => isSubscribed,
      isBotMentioned: () => false,
      isDMOrPrivateChannel: async () => true,
      slack: {},
    },
  };
}

/** Drive one of the two wired Slack hooks. */
async function slackInbound(hook, env, message, { isSubscribed = true } = {}) {
  let result;
  let typed;
  const lines = await capturing(async () => {
    await withEnv(env, async () => {
      const context = slackContext(isSubscribed);
      typed = context.typed;
      result = await CONFIGS.slack[hook](context.ctx, message);
    });
  });
  return { result, typed, lines };
}

test("slack: both inbound hooks are still wired", () => {
  // `onAppMention` is not optional here even though it reproduces eve's
  // default: without it, defining `onMessage` captures app mentions, they hit
  // the isSubscribed() gate with no session yet, and the bot ignores you until
  // it has already answered you once — which it never does.
  assert.equal(typeof CONFIGS.slack?.onAppMention, "function");
  assert.equal(typeof CONFIGS.slack?.onMessage, "function");
});

test("slack: with no allow-list, a DM from a workspace member is refused", async () => {
  const { result, typed, lines } = await slackInbound(
    "onMessage",
    { SLACK_ALLOWED_USER_IDS: undefined },
    slackMessage(),
  );
  assert.equal(result, null);
  assert.deepEqual(typed, [], "a refused person gets no indicator and costs no API call");
  assert.equal(lines.length, 1, `exactly one line per refusal, got: ${lines.join(" | ")}`);
  assert.ok(!lines[0].includes("\n"));
  assert.match(lines[0], /SLACK_ALLOWED_USER_IDS/);
  assert.match(lines[0], /U42/, "and the member id that has to go in it");
});

test("slack: a listed member's DM dispatches, with typing and eve's own auth", async () => {
  const { result, typed } = await slackInbound(
    "onMessage",
    { SLACK_ALLOWED_USER_IDS: "U42" },
    slackMessage(),
  );
  assert.deepEqual(result, { auth: { via: "eve.defaultSlackAuth", principalId: "slack:U42" } });
  assert.deepEqual(typed, ["Thinking…"]);
});

test("slack: the DM branch still bypasses isSubscribed", async () => {
  // The structural half of the file that must not break: eve resolves
  // `onDirectMessage ?? onMessage`, so this hook owns DMs, and a DM has to
  // dispatch on the first message when no session exists yet.
  const { result } = await slackInbound(
    "onMessage",
    { SLACK_ALLOWED_USER_IDS: "U42" },
    slackMessage(),
    { isSubscribed: false },
  );
  assert.ok(result, "the explicit DM branch was lost");
});

test("slack: un-addressed channel chatter still needs an existing session, and logs nothing", async () => {
  // Ordering again: the allow-list runs after isSubscribed(), so the log cannot
  // fill with refusals for messages that were never going to wake the agent.
  const { result, lines } = await slackInbound(
    "onMessage",
    { SLACK_ALLOWED_USER_IDS: undefined },
    slackMessage({ raw: { channel_type: "channel" } }),
    { isSubscribed: false },
  );
  assert.equal(result, null);
  assert.deepEqual(lines, []);
});

test("slack: a bot's own message is dropped before anything else", async () => {
  const { result, lines } = await slackInbound(
    "onMessage",
    { SLACK_ALLOWED_USER_IDS: "*" },
    slackMessage({ author: { userId: "B1", isBot: true, isMe: true } }),
  );
  assert.equal(result, null);
  assert.deepEqual(lines, [], "a bot echo is not an access refusal");
});

test("slack: app mentions are gated too, not just DMs", async () => {
  // The finding named the DM branch. An `@evestack` in a channel starts exactly
  // the same turn on exactly the same key, so gating one and not the other
  // would leave an operator who set the variable believing Slack was closed.
  const refused = await slackInbound(
    "onAppMention",
    { SLACK_ALLOWED_USER_IDS: undefined },
    slackMessage({ raw: { channel_type: "channel" } }),
  );
  assert.equal(refused.result, null);
  assert.deepEqual(refused.typed, []);
  assert.match(refused.lines[0], /SLACK_ALLOWED_USER_IDS/);

  const allowed = await slackInbound(
    "onAppMention",
    { SLACK_ALLOWED_USER_IDS: "U42" },
    slackMessage({ raw: { channel_type: "channel" } }),
  );
  assert.deepEqual(allowed.result, { auth: { via: "eve.defaultSlackAuth", principalId: "slack:U42" } });
  assert.deepEqual(allowed.typed, ["Thinking…"]);
});

test("slack: `*` restores the previous any-member behaviour", async () => {
  const { result } = await slackInbound(
    "onMessage",
    { SLACK_ALLOWED_USER_IDS: "*" },
    slackMessage({ author: { userId: "UZZZ", isBot: false, isMe: false } }),
  );
  assert.ok(result, "the documented escape hatch stopped working");
});

for (const channel of ["telegram", "discord"]) {
  test(`${channel} authorizes callbacks only after upstream verification`, async () => {
    const verify = CONFIGS[channel].credentials.webhookVerifier;
    const variable = channel === "telegram" ? "TELEGRAM_ALLOWED_USER_IDS" : "DISCORD_ALLOWED_USER_IDS";
    await withEnv({ [variable]: "123", DISCORD_ALLOWED_GUILD_IDS: undefined }, async () => {
      const payload = (id) => channel === "telegram"
        ? { callback_query: { from: { id } } }
        : { type: 3, member: { user: { id: String(id) } } };
      const request = (signed) => new Request("https://example.test/webhook", {
        headers: signed ? { "test-verified": "yes" } : {},
      });
      await assert.rejects(verify(request(false), JSON.stringify(payload(123))), /bad signature/);
      assert.equal(await verify(request(true), JSON.stringify(payload(123))), true);
      assert.equal(await verify(request(true), JSON.stringify(payload(999))), false);
      assert.equal(await verify(request(true), "{}"), false);
      if (channel === "discord") {
        assert.equal(await verify(request(true), '{"type":1}'), true);
        assert.equal(await verify(request(true), JSON.stringify({ ...payload(999), type: 5 })), false);
      }
    });
  });
}

test("Slack approvals and modal answers keep unauthorized requests pending", async () => {
  await withEnv({ SLACK_ALLOWED_USER_IDS: "U123" }, async () => {
    for (const type of ["block_actions", "view_submission"]) {
      const ctx = { defaultAuth: { principal: "allowed" } };
      assert.equal(await CONFIGS.slack.onInputResponse(ctx, { type, user: { id: "U999" } }), null);
      assert.deepEqual(await CONFIGS.slack.onInputResponse(ctx, { type, user: { id: "U123" } }), { auth: ctx.defaultAuth });
    }
  });
});

test("the copied Telegram dispatch predicate still matches Eve's shipped rule", () => {
  const source = readFileSync(new URL("../node_modules/eve/dist/src/public/channels/telegram/defaults.js", import.meta.url), "utf8");
  const start = source.indexOf("function shouldDispatchTelegramMessage(");
  assert.notEqual(start, -1);
  const rule = source.slice(start, source.indexOf("function isBotCommand", start));
  for (const fragment of ['.from?.isBot===!0', '.chat.type===`channel`', '.attachments.length>0', '.chat.type===`private`', '.replyToMessage?.from?.isBot===!0', 'isBotCommand(', 'mentionsBotUsername(']) {
    assert.ok(rule.includes(fragment), `Eve dispatch rule changed: ${fragment}`);
  }
});
