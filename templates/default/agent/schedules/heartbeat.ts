import { defineSchedule, type ScheduleHandlerArgs } from "eve/schedules";
import discord from "../channels/discord.js";
import slack from "../channels/slack.js";
import telegram from "../channels/telegram.js";
import { tracked } from "@evestack/schedules";
import { heartbeatPrompt, heartbeatQuietState, heartbeatTarget, readHeartbeatTasks } from "../../lib/heartbeat.js";

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
 *  2. An acknowledgement token — and eve, not evestack, is what drops it. The
 *     agent is told to reply with exactly `<eve-empty-delivery/>` when there is
 *     nothing worth reporting. That string is not something this file invented:
 *     it is eve's own EMPTY_DELIVERY_SENTINEL.
 *
 *     WHAT THIS BLOCK USED TO SAY, AND WHY IT IS GONE. It said the token (then
 *     the literal `HEARTBEAT_OK`) reached your channel because nothing could
 *     filter it: this handler hands the turn to eve, eve posts the reply itself,
 *     and evestack never sees the text. Every one of those mechanics is still
 *     true. The conclusion is not, because eve now drops the reply on its own.
 *     Read out of the copy this template pins — node_modules/eve, 0.54.3 — not
 *     inferred from a release note:
 *
 *       dist/src/shared/empty-delivery.js declares the sentinel and
 *       `hasEmptyDeliverySentinel(text)`, which trims and accepts exactly
 *       `<eve-empty-delivery/>` or its HTML-escaped twin
 *       `&lt;eve-empty-delivery/&gt;`. Nothing else, and nothing merely
 *       CONTAINING one.
 *
 *       dist/src/harness/emission.js runs that predicate on the completed
 *       message of every turn, unconditionally — no flag, no policy, no opt-in
 *       above it. When it matches, and the step is neither a tool-call step nor
 *       a content filter, the event emitted is `message.completed` with
 *       `message: null`.
 *
 *       dist/src/harness/tool-loop.js (handleStepResult) applies the same test to
 *       what gets written down: the assistant message is recorded as null and its
 *       step messages are dropped, so a quiet hour does not accumulate in the
 *       conversation's history either.
 *
 *       and every channel's default `message.completed` handler declines to post
 *       a null message. Telegram and Discord: `e.finishReason !== "tool-calls" &&
 *       e.message && post(e.message)`. Slack: `if (!e.message) { startTyping();
 *       return }`. (dist/src/public/channels/{telegram,discord,slack}/defaults.js
 *       — the same three channels loadChannel() below accepts, which is not a
 *       coincidence: a fourth would need this checked again.)
 *
 *     So a quiet hour now sends nothing at all, and the 300-character rule this
 *     block used to record for whoever wired the missing filter is moot. There is
 *     no filter left to wire, and the deleted `isWorthDelivering` predicate is
 *     not coming back.
 *
 *     TWO EDGES WORTH KNOWING BEFORE YOU TRUST IT.
 *
 *     The sentinel must be the WHOLE reply. eve narrowed the check to "the entire
 *     response, apart from surrounding whitespace" on purpose (CHANGELOG b3ce510,
 *     0.52.4) so that a reply which quotes or explains the marker is still
 *     delivered. `<eve-empty-delivery/>, nothing to report` is therefore a
 *     message, exactly as `HEARTBEAT_OK, nothing to report` was. A model that
 *     decorates its acknowledgement still interrupts you; the prompt below asks
 *     for the marker alone in as many words.
 *
 *     And eve's own nudge toward the marker does not always reach this turn.
 *     `resolveDeliveryPolicy` (dist/src/tasks/delivery-policy.js) attaches
 *     CONDITIONAL_DELIVERY_INSTRUCTION only for the FIRST turn of a session
 *     carrying schedule provenance — provenance this dispatch does have, since
 *     dist/src/channel/schedule.js runs the handler inside a context holding
 *     ScheduleIdKey and dist/src/execution/runtime-context.js copies it onto the
 *     session. But a heartbeat aimed at a chat you already talk in CONTINUES that
 *     conversation instead of opening a session (eve's own docs/schedules.mdx,
 *     "Session continuity": handler schedules start a new session on every fire
 *     "unless they send to an existing conversation"), and turn 200 of a Telegram
 *     DM is not turn 0. That is why the instruction is spelled out in the prompt
 *     below rather than left to the policy: the policy is a bonus on the fires
 *     that do open a session, and the unconditional drop in emission.js is what
 *     this feature actually rests on.
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

const CRON = process.env.EVESTACK_HEARTBEAT_CRON?.trim() || "0 * * * *";

/** Which channel to speak into, resolved at MODULE LOAD rather than per fire.
 *  That is the whole of the "off means off" fix; see the note on `run`. */
const CHANNEL = process.env.EVESTACK_HEARTBEAT_CHANNEL?.trim() || null;

async function fire(
  channelName: string,
  { to, waitUntil, appAuth }: ScheduleHandlerArgs,
): Promise<void> {
  // Which conversation to speak into. Every channel's target has a different
  // shape — Telegram wants a chatId, Slack a channelId — so this is JSON rather
  // than a guess, and a bad value fails loudly at the fire.
  const quiet = heartbeatQuietState();
  if (quiet.quiet) {
    console.log(`[evestack:heartbeat] skipped dispatch during quiet hours ${quiet.hours} (${quiet.timeZone}). No model request was sent by this fire.`);
    return;
  }
  const target = heartbeatTarget();

  const tasks = await readHeartbeatTasks();
  if (!tasks) {
    // Not a failure. The file belongs to the human, and an empty one means there
    // is genuinely nothing to check this hour.
    console.log(
      "[evestack:heartbeat] no HEARTBEAT.md (or it is empty), so there is nothing to check.",
    );
    return;
  }

  const channel = loadChannel(channelName);

  // eve 0.54 split the old single-call `receive(channel, {target, message, auth})`
  // into addressing and sending: `to(channel, target)` returns a handle whose
  // `send(message, {auth})` does the dispatch. Same two arguments, one more hop.
  const dispatch = to(channel as never, target as never).send(
    heartbeatPrompt(tasks),
    { auth: appAuth },
  );

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
