import { defineSchedule, type ScheduleHandlerArgs } from "eve/schedules";
import discord from "../channels/discord.js";
import slack from "../channels/slack.js";
import telegram from "../channels/telegram.js";
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
 *     This block used to say "the wrapper drops the message". It does not, and
 *     there is no filter in this file that would. There used to be one — an
 *     exported `isWorthDelivering(reply)` predicate — called from nowhere, with
 *     a comment saying so. It has been deleted rather than left in a template
 *     people read and edit: a function that is exported, named after the thing
 *     it would do, and wired to nothing reads as a working feature whatever the
 *     comment above it says. The rule it encoded is one line, and is recorded
 *     here instead so that whoever wires it does not have to rediscover it: a
 *     reply is worth delivering if it still has 300 or more characters once the
 *     token is stripped out. ("HEARTBEAT_OK, nothing to report" is still nothing
 *     to report.) The threshold is borrowed from OpenClaw, where it is what
 *     stopped the same feature becoming spam.
 *
 *     Why no such filter can simply be called from here: this handler hands the
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
 *         and apply the 300-character rule there. Correct, but it must first
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
 * Off by default, and off now means off — the note on `run` below records what
 * "off" used to cost. It is deliberately unset in .env.example, because a
 * schedule that starts spending money the moment you scaffold a project is not a
 * pleasant surprise. Set EVESTACK_HEARTBEAT_CHANNEL to turn it on.
 */

/** The token the agent is asked to reply with when there is no news. Nothing
 *  strips it — see the note above on why no filter can run here. */
const ACK = "HEARTBEAT_OK";

const CRON = process.env.EVESTACK_HEARTBEAT_CRON?.trim() || "0 * * * *";

/** Which channel to speak into, resolved at MODULE LOAD rather than per fire.
 *  That is the whole of the "off means off" fix; see the note on `run`. */
const CHANNEL = process.env.EVESTACK_HEARTBEAT_CHANNEL?.trim() || null;

/**
 * The channel-specific address to post to, as JSON.
 *
 * Telegram: `{"chatId":123456789}` · Slack: `{"channelId":"C0123ABC"}` ·
 * Discord: `{"channelId":"987654321"}`. Kept as raw JSON rather than three
 * bespoke env vars because eve types the target per channel, and inventing our
 * own flattened spelling would drift the moment a channel adds a field.
 *
 * Throws rather than warns. The channel is set, so a human asked for this: a
 * heartbeat with nowhere to post is broken, not idle. It used to warn to a log
 * nobody reads and return, and the fire was still written down as `completed` —
 * which, until the fix in `fire()` below, was the only outcome this schedule
 * could ever record.
 */
function readTarget(): Record<string, unknown> {
  const raw = process.env.EVESTACK_HEARTBEAT_TARGET;
  if (!raw) {
    throw new Error(
      "EVESTACK_HEARTBEAT_CHANNEL is set but EVESTACK_HEARTBEAT_TARGET is not, so there is " +
        'nowhere to post. Example: {"chatId":123456789}',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`EVESTACK_HEARTBEAT_TARGET is not valid JSON (${String(error)})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error('EVESTACK_HEARTBEAT_TARGET must be a JSON object, e.g. {"chatId":123456789}');
  }
  return parsed as Record<string, unknown>;
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

async function fire(
  channelName: string,
  { receive, waitUntil, appAuth }: ScheduleHandlerArgs,
): Promise<void> {
  // Which conversation to speak into. Every channel's target has a different
  // shape — Telegram wants a chatId, Slack a channelId — so this is JSON rather
  // than a guess, and a bad value fails loudly at the fire.
  const target = readTarget();

  const tasks = await readTasks();
  if (!tasks) {
    // Not a failure. The file belongs to the human, and an empty one means there
    // is genuinely nothing to check this hour.
    console.log(
      "[evestack:heartbeat] no HEARTBEAT.md (or it is empty), so there is nothing to check.",
    );
    return;
  }

  const channel = loadChannel(channelName);

  const dispatch = receive(channel as never, {
    target: target as never,
    message:
      `${tasks}\n\n---\n` +
      `You are running as a scheduled heartbeat, not in a conversation. Work through the ` +
      `checks above. If nothing needs the user's attention, reply with exactly ${ACK} and ` +
      `nothing else. Only write a real message when there is something they would want to ` +
      `be interrupted for.`,
    auth: appAuth,
  });

  // `waitUntil(p)` WITHOUT awaiting `p` is what made every heartbeat record
  // itself `completed` in a handful of milliseconds, whatever happened.
  //
  // In eve 0.30.8 `waitUntil` is literally `waitUntil(e){ i.push(e) }` — it
  // appends the promise to an array and returns (dist/src/channel/schedule.js).
  // The task route then does `await trigger()` and only AFTERWARDS
  // `await Promise.allSettled(waitUntilTasks)`
  // (dist/src/internal/nitro/routes/schedule-task.js). `tracked` wraps this
  // handler, so its try/catch has already closed and written a status by the time
  // anything looks at that promise — and `allSettled` never rethrows, so a
  // rejection reached nobody at all. The recorded result was status='completed'
  // with the duration of a dispatch, and failingStreak was structurally always 0
  // for the one schedule this template ships. "The error when one throws" is the
  // headline feature of @evestack/schedules, and it could not fire.
  //
  // Measured, not reasoned. Driving this file's pre-fix form with a `receive` that
  // rejects, and a `waitUntil` that mimics eve's (push to an array, allSettled it
  // after the handler returns), wrote exactly one row: status='completed',
  // duration_ms=19, error=null — for a dispatch that had failed with "channel said
  // 401 Unauthorized". With a `receive` that took 400ms instead, the same row
  // recorded duration_ms=14. After the await: status='failed' carrying the
  // message, and duration_ms=433 for the 400ms one. (The rejection also arrived
  // late enough to be an unhandled rejection, because `allSettled` cannot attach
  // its handler until `tracked` has finished awaiting its own store write.)
  //
  // So it is awaited here, inside the wrapper, which is the only place left that
  // can still write a status. What that does and does not buy, precisely:
  //
  //   IT RECORDS THE DISPATCH. A target the channel rejects
  //   (`telegramChannel().receive requires target.chatId.`), a channel object
  //   that is not one of this agent's registered channels, a channel with no
  //   `receive` hook or no adapter, and a workflow store that will not start the
  //   run — Postgres down at fire time — now all land as status='failed' with the
  //   message on the row. Every one of them used to read as `completed`.
  //
  //   IT DOES NOT RECORD THE TURN, and nothing in these args can. `receive()`
  //   resolves as soon as the workflow run has started and owns its command hook:
  //   `createSession` returns straight after `startWorkflowPreferLatest`
  //   (dist/src/execution/workflow-runtime.js). The model call, the tool calls
  //   and the outbound post all happen after that, inside the durable run, and a
  //   failure there surfaces through eve's own `turn.failed` handler, which posts
  //   to the channel. Putting it on this row would mean draining the session's
  //   event stream to a terminal event and holding the cron invocation open for
  //   the whole turn — a different feature, not a fix to this one.
  //
  // `waitUntil` is kept as well as awaited: it is eve's documented lifetime
  // extension, and it costs nothing here, because by the time the dispatcher
  // looks at the array this promise has already settled.
  waitUntil(dispatch);
  await dispatch;
}

/**
 * `run`, and why the disabled case is decided HERE rather than in the handler.
 *
 * The check used to be the first two lines of the handler body — and `tracked`'s
 * wrapper runs before the handler. It reads the pause table, then CLAIMS the
 * fire, which is an INSERT into evestack.schedule_runs that creates the
 * `evestack` schema on the way, then calls the handler, which returned
 * immediately, then marks the claim `completed`. So a scaffolded project that
 * never set EVESTACK_HEARTBEAT_CHANNEL still created the schema and wrote one row
 * an hour, forever, for a feature that is off — and nothing prunes it: there is
 * no DELETE, prune or sweep against evestack.schedule_runs anywhere in this
 * repository. The Schedules page duly showed a `heartbeat` with hundreds of
 * completed runs and, worse, a populated lastFireAt — which is exactly what
 * `catchUp` reads to decide how many fires to replay the first time someone does
 * switch the feature on.
 *
 * With the channel resolved at module load, "off" is a handler that returns. eve's
 * cron still ticks: the file exists, so the task is registered, and keeping the
 * task table the same shape whether or not an optional variable is set is
 * deliberate — the same posture as agent/channels/telegram.ts, where a channel
 * that vanishes when a key is missing is harder to debug than one that is present
 * and idle. But nothing is claimed, nothing is recorded, no schema is created, and
 * lastFireAt stays null.
 *
 * One consequence worth naming rather than discovering: `tracked` parses the cron
 * at construction, so an unparseable EVESTACK_HEARTBEAT_CRON no longer throws at
 * module load while the heartbeat is off. That is the right way round — refusing
 * to boot the whole agent over a variable belonging to a switched-off feature was
 * never the better trade — and the parse happens the moment it is switched on.
 */
const run: (args: ScheduleHandlerArgs) => Promise<void> | void =
  CHANNEL === null
    ? () => {}
    : tracked<ScheduleHandlerArgs>("heartbeat", CRON, (args) => fire(CHANNEL, args), {
        // Replaying a missed heartbeat is the right call: the digest you were owed
        // at 09:00 is still worth having at 09:40. The window keeps a laptop that
        // was shut for a week from replaying a week of them.
        catchUp: true,
        catchUpLimit: 3,
        catchUpWindowMs: 6 * 60 * 60 * 1000,
      });

export default defineSchedule({ cron: CRON, run });

/**
 * `receive` needs the channel object, and which channel is configuration rather
 * than code, so it is resolved by name.
 *
 * Statically imported, and the import list is the whole reason. These three were
 * dynamic imports with a comment saying an agent that never enables the
 * heartbeat should not pay to load a channel it has not configured. It never
 * paid less, and `npm run build` said so out loud, three times, on a scaffolded
 * project that has changed nothing:
 *
 *   [INEFFECTIVE_DYNAMIC_IMPORT] agent/channels/discord.ts is dynamically
 *   imported by agent/schedules/heartbeat.ts but also statically imported by
 *   .eve/builds/<id>/host/compiled-artifacts-bootstrap.mjs, dynamic import will
 *   not move module into another chunk.
 *
 * eve registers every file under agent/channels/ whether or not anything imports
 * it, so the saving the dynamic form was written for cannot exist, and the only
 * thing it produced was three warnings in the output of a documented command.
 *
 * Throws, for the same reason readTarget does: the heartbeat has been switched on
 * and cannot run, which is a failure worth recording on the row rather than a
 * warning in a log.
 */
function loadChannel(name: string): unknown {
  const known: Record<string, unknown> = { telegram, slack, discord };

  const channel = known[name.toLowerCase()];
  if (!channel) {
    throw new Error(
      `EVESTACK_HEARTBEAT_CHANNEL="${name}" is not one of ${Object.keys(known).join(", ")}`,
    );
  }
  return channel;
}
