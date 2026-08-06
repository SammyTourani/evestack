import { defineSchedule } from "eve/schedules";
import { tracked } from "@evestack/schedules";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The agent wakes up on its own and only bothers you when there is something to
 * say.
 *
 * This is the shape OpenClaw made famous — "it texts you first" — reduced to
 * the parts that make it work rather than the parts that make it a demo. Three
 * of them, and all three are load-bearing:
 *
 *  1. A plain-text task file the human edits (HEARTBEAT.md). The instructions
 *     for a recurring check belong in a file you can open, not in a prompt
 *     buried in TypeScript that needs a redeploy to change.
 *
 *  2. An acknowledgement token. The agent is told to reply with HEARTBEAT_OK
 *     when there is nothing worth reporting.
 *
 *     ── AND NOTHING DROPS IT. READ THIS BEFORE ENABLING THE HEARTBEAT. ──
 *
 *     This block used to say "the wrapper drops the message". It does not.
 *     `isWorthDelivering` below is the filter that would, and it is called from
 *     nowhere — because it has nowhere to be called from. This handler hands the
 *     turn to eve with `receive()`, and eve posts the reply itself:
 *
 *         "message.completed"(e, t) {
 *           e.finishReason === `tool-calls` || !e.message || await t.telegram.post(e.message)
 *         }
 *
 *     (eve/dist/src/public/channels/telegram/defaults.js). evestack never sees
 *     the reply text, so it cannot filter it. Enable the heartbeat as it stands
 *     and a quiet hour delivers the literal string "HEARTBEAT_OK" to your
 *     channel — which is the hourly notification this design exists to prevent.
 *
 *     Two ways out, neither of them a one-liner, which is why this is written
 *     down rather than quietly patched:
 *       - Ask for an EMPTY reply instead of a token. eve's own `!e.message`
 *         check then drops it, with no override anywhere. Cheap, but it rests on
 *         the model returning nothing rather than a space.
 *       - Override `message.completed` on the channel via TelegramChannelEvents
 *         and apply `isWorthDelivering` there. Correct, but it must first
 *         distinguish a heartbeat turn from a chat turn: applied to both, it
 *         would swallow a user's real one-word answer, which is worse than the
 *         spam it fixes.
 *
 *  3. A cheap turn — INTENDED, NOT IMPLEMENTED. This block used to credit
 *     `isolatedSession` for keeping each wake-up out of the main conversation's
 *     history. That identifier appears nowhere in this repo except the sentence
 *     that claimed it, and nowhere in eve's dist either: it is not an API, it is
 *     a name for something nobody built. So a wake-up costs whatever the
 *     session it lands in costs, and the "few thousand tokens instead of the
 *     whole context window" figure describes a design, not this code.
 *
 * Off by default. It is deliberately unset in .env.example, because a schedule
 * that starts spending money the moment you scaffold a project is not a
 * pleasant surprise. Set EVESTACK_HEARTBEAT_CHANNEL to turn it on.
 */

/** The token the agent is asked to reply with when there is no news. Nothing
 *  strips it — see the note above on why `isWorthDelivering` cannot run here. */
const ACK = "HEARTBEAT_OK";

/**
 * Anything shorter than this after the token is stripped is treated as noise
 * rather than news — "HEARTBEAT_OK, nothing to report" is still nothing to
 * report. Borrowed from OpenClaw, where the same threshold is what stopped the
 * feature becoming spam.
 */
const MIN_INTERESTING_CHARS = 300;

const CRON = process.env.EVESTACK_HEARTBEAT_CRON?.trim() || "0 * * * *";

/**
 * The channel-specific address to post to, as JSON.
 *
 * Telegram: `{"chatId":123456789}` · Slack: `{"channelId":"C0123ABC"}` ·
 * Discord: `{"channelId":"987654321"}`. Kept as raw JSON rather than three
 * bespoke env vars because eve types the target per channel, and inventing our
 * own flattened spelling would drift the moment a channel adds a field.
 */
function readTarget(): Record<string, unknown> | null {
  const raw = process.env.EVESTACK_HEARTBEAT_TARGET;
  if (!raw) {
    console.warn(
      "[evestack:heartbeat] EVESTACK_HEARTBEAT_CHANNEL is set but EVESTACK_HEARTBEAT_TARGET is " +
        'not, so there is nowhere to post. Example: {"chatId":123456789}',
    );
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    console.warn(
      `[evestack:heartbeat] EVESTACK_HEARTBEAT_TARGET is not a JSON object (${String(error)}), ` +
        "so the heartbeat will not run.",
    );
    return null;
  }
}

async function readTasks(): Promise<string | null> {
  // Read at fire time, not at boot: the point of a file is that you can edit it
  // and have the next wake-up honour the change.
  try {
    const path = process.env.EVESTACK_HEARTBEAT_FILE?.trim() || join(process.cwd(), "HEARTBEAT.md");
    const text = await readFile(path, "utf8");
    return text.trim() || null;
  } catch {
    return null;
  }
}

export default defineSchedule({
  cron: CRON,
  run: tracked(
    "heartbeat",
    CRON,
    async ({ receive, waitUntil, appAuth }) => {
      const channelName = process.env.EVESTACK_HEARTBEAT_CHANNEL;
      if (!channelName) return;

      // Which conversation to speak into. Every channel's target has a
      // different shape — Telegram wants a chatId, Slack a channelId — so this
      // is JSON rather than a guess, and a bad value fails loudly at the fire
      // rather than silently posting nowhere.
      const target = readTarget();
      if (!target) return;

      const tasks = await readTasks();
      if (!tasks) {
        console.log(
          "[evestack:heartbeat] no HEARTBEAT.md (or it is empty), so there is nothing to check.",
        );
        return;
      }

      // Dynamic import so an agent that never enables the heartbeat does not pay
      // to load a channel it has not configured.
      const channel = await loadChannel(channelName);
      if (!channel) return;

      waitUntil(
        receive(channel as never, {
          target: target as never,
          message:
            `${tasks}\n\n---\n` +
            `You are running as a scheduled heartbeat, not in a conversation. Work through the ` +
            `checks above. If nothing needs the user's attention, reply with exactly ${ACK} and ` +
            `nothing else. Only write a real message when there is something they would want to ` +
            `be interrupted for.`,
          auth: appAuth,
        }),
      );
    },
    {
      // Replaying a missed heartbeat is the right call: the digest you were owed
      // at 09:00 is still worth having at 09:40. The window keeps a laptop that
      // was shut for a week from replaying a week of them.
      catchUp: true,
      catchUpLimit: 3,
      catchUpWindowMs: 6 * 60 * 60 * 1000,
    },
  ),
});

/**
 * `receive` needs the channel object, and which channel is configuration rather
 * than code, so it is resolved by name.
 */
async function loadChannel(name: string): Promise<unknown | null> {
  const known: Record<string, () => Promise<{ default: unknown }>> = {
    telegram: () => import("../channels/telegram.js"),
    slack: () => import("../channels/slack.js"),
    discord: () => import("../channels/discord.js"),
  };

  const load = known[name.toLowerCase()];
  if (!load) {
    console.warn(
      `[evestack:heartbeat] EVESTACK_HEARTBEAT_CHANNEL="${name}" is not one of ` +
        `${Object.keys(known).join(", ")}; the heartbeat will not run.`,
    );
    return null;
  }

  try {
    return (await load()).default;
  } catch (error) {
    console.warn(`[evestack:heartbeat] could not load the ${name} channel`, error);
    return null;
  }
}

/**
 * Whether a heartbeat reply is worth delivering.
 *
 * NOT WIRED. Nothing in this repository calls this — grep it and the only hit is
 * this definition. The comment here used to say "exported for the eval", and no
 * eval imports it either.
 *
 * It is kept rather than deleted because it is the correct rule and the contract
 * is worth preserving for whoever wires it. What wiring it requires, and why that
 * is a design decision rather than a patch, is in the note at the top of this
 * file: eve owns the posting, and applying this filter at the channel level would
 * also swallow a user's genuinely short chat reply.
 */
export function isWorthDelivering(reply: string): boolean {
  const stripped = reply.replaceAll(ACK, "").trim();
  return stripped.length >= MIN_INTERESTING_CHARS;
}
