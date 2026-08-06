import { missedFires, nextFire, parseCron } from "./cron.js";
import { claimRun, finishRun, isPaused, lastFireAt, setPaused } from "./store.js";

export { describeCron, missedFires, nextFire, parseCron, CronParseError } from "./cron.js";
export { closePool, ensureSchema, isPaused, lastFireAt, setPaused } from "./store.js";
export type { CronFields } from "./cron.js";
export type { ScheduleRunRow } from "./store.js";

/**
 * Durable, observable, pausable schedules for a self-hosted eve agent.
 *
 * Wraps eve's own `defineSchedule` handler rather than replacing it. The cron
 * still fires through eve's Nitro runner and the handler is still yours; what
 * this adds is the part that does not survive a process: a row per tick, the
 * error when one throws, a pause switch that does not require a redeploy, and
 * catch-up for ticks missed while the box was off.
 *
 * ```ts
 * // agent/schedules/heartbeat.ts
 * import { defineSchedule } from "eve/schedules";
 * import { tracked } from "@evestack/schedules";
 *
 * export default defineSchedule({
 *   cron: "0 * * * *",
 *   run: tracked("heartbeat", "0 * * * *", async ({ receive, waitUntil, appAuth }) => {
 *     // …your handler, unchanged
 *   }),
 * });
 * ```
 *
 * The name is passed explicitly because eve derives a schedule's identity from
 * its file path at compile time and does not hand that name to the handler at
 * runtime. Repeating it is the price of not guessing.
 */

export interface TrackedOptions {
  /**
   * Replay ticks missed while the process was down, on the first fire after a
   * restart. Off by default, and that default is the honest one: replaying is
   * right for "post the digest I owe you" and wrong for "charge the card", and
   * only the author of the handler knows which they wrote.
   */
  readonly catchUp?: boolean;
  /** How many missed ticks to replay at most. */
  readonly catchUpLimit?: number;
  /**
   * Ignore gaps older than this. A laptop that was closed for a fortnight
   * should not wake up and replay a fortnight of hourly heartbeats.
   */
  readonly catchUpWindowMs?: number;
}

const DEFAULT_CATCH_UP_LIMIT = 10;
const DEFAULT_CATCH_UP_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The tick a fire belongs to: now, floored to the minute. */
function currentTick(): Date {
  const tick = new Date();
  tick.setSeconds(0, 0);
  return tick;
}

/**
 * Wrap a schedule handler so every fire is recorded, pauses are honored, and
 * missed ticks can be replayed.
 *
 * Failures inside the wrapper never take down the handler. A schedule that
 * stops running because its bookkeeping database is unreachable would be a
 * strictly worse outcome than one that runs unrecorded, so a store error is
 * logged and swallowed — with one exception, the pause check, where failing
 * open is the safe direction and is what happens.
 */
export function tracked<TArgs>(
  name: string,
  cron: string,
  handler: (args: TArgs) => unknown | Promise<unknown>,
  options: TrackedOptions = {},
): (args: TArgs) => Promise<void> {
  // Fail fast, at module load, on an expression we cannot interpret. The
  // alternative is discovering it at 3am when the first fire tries to compute a
  // catch-up window.
  parseCron(cron);

  let caughtUp = false;

  return async function trackedRun(args: TArgs): Promise<void> {
    if (await pausedSafely(name)) {
      const tick = currentTick();
      const id = await claimSafely({ name, cron, fireAt: tick });
      if (id) await finishSafely(id, { status: "skipped", error: "schedule is paused" });
      return;
    }

    if (options.catchUp && !caughtUp) {
      caughtUp = true;
      await replayMissed(name, cron, handler, args, options);
    }

    await runOnce(name, cron, currentTick(), false, handler, args);
  };
}

async function runOnce<TArgs>(
  name: string,
  cron: string,
  fireAt: Date,
  isCatchUp: boolean,
  handler: (args: TArgs) => unknown | Promise<unknown>,
  args: TArgs,
): Promise<void> {
  const id = await claimSafely({ name, cron, fireAt, caughtUp: isCatchUp });

  // A null id means this tick is already recorded — two workers raced, or a
  // catch-up is replaying something a live fire already did. Not an error, and
  // running the handler anyway would defeat the point of the unique index.
  if (id === null && isCatchUp) return;

  try {
    await handler(args);
    if (id) await finishSafely(id, { status: "completed" });
  } catch (error) {
    if (id) {
      await finishSafely(id, {
        status: "failed",
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    }
    // Rethrow: eve's runner should see the failure too. We are a recorder, not
    // a swallower of the app's errors.
    throw error;
  }
}

async function replayMissed<TArgs>(
  name: string,
  cron: string,
  handler: (args: TArgs) => unknown | Promise<unknown>,
  args: TArgs,
  options: TrackedOptions,
): Promise<void> {
  try {
    const last = await lastFireAt(name);
    if (!last) return;

    const window = options.catchUpWindowMs ?? DEFAULT_CATCH_UP_WINDOW_MS;
    const floor = new Date(Date.now() - window);
    const from = last.getTime() > floor.getTime() ? last : floor;

    const limit = options.catchUpLimit ?? DEFAULT_CATCH_UP_LIMIT;
    const { fires, truncated } = missedFires(cron, from, currentTick(), limit);
    if (fires.length === 0) return;

    /* "older ticks dropped" was backwards, and the direction matters when you are
       reading a log to work out what the agent actually did.
       `missedFires` walks forward from `from`, so hitting the cap keeps the OLDEST
       fires in the batch and leaves the newest unreplayed. They are not lost:
       `lastFireAt` is MAX(fire_at), so it advances to the last one replayed and the
       next tick resumes from there, draining the backlog in order. They are only
       genuinely lost if they fall out of the catch-up window before it gets to them.
       Measured: a 2-hour gap of `* * * * *` with a limit of 5 replayed 00:01–00:05
       and deferred everything up to 02:00. */
    console.warn(
      `[evestack:schedules] ${name}: replaying ${fires.length} missed fire(s) since ` +
        `${from.toISOString()}` +
        (truncated
          ? ` (capped at ${limit}; the newest missed ticks are deferred to the next tick, oldest first)`
          : ""),
    );

    for (const fire of fires) {
      try {
        await runOnce(name, cron, fire, true, handler, args);
      } catch (error) {
        // One bad replay must not prevent the rest, nor the live fire that
        // follows. It is already recorded as failed.
        console.error(`[evestack:schedules] ${name}: catch-up for ${fire.toISOString()} failed`, error);
      }
    }
  } catch (error) {
    console.error(`[evestack:schedules] ${name}: catch-up could not run`, error);
  }
}

async function pausedSafely(name: string): Promise<boolean> {
  try {
    return await isPaused(name);
  } catch (error) {
    // Fail open. A schedule that stops firing because the pause table could not
    // be read is a silent outage; one that fires when it should have been
    // paused is visible in the history.
    console.error(`[evestack:schedules] ${name}: could not read pause state, running anyway`, error);
    return false;
  }
}

async function claimSafely(input: {
  name: string;
  cron?: string | undefined;
  fireAt: Date;
  caughtUp?: boolean;
}): Promise<string | null> {
  try {
    return await claimRun(input);
  } catch (error) {
    console.error(`[evestack:schedules] ${input.name}: could not record this fire`, error);
    return null;
  }
}

async function finishSafely(
  id: string,
  outcome: { status: "completed" | "failed" | "skipped"; error?: string; sessionId?: string },
): Promise<void> {
  try {
    await finishRun(id, outcome);
  } catch (error) {
    console.error("[evestack:schedules] could not record the outcome of a fire", error);
  }
}

/** Pause a schedule without a redeploy. */
export async function pause(name: string, by?: string): Promise<void> {
  await setPaused(name, true, by);
}

export async function resume(name: string, by?: string): Promise<void> {
  await setPaused(name, false, by);
}

/** When this expression fires next, for a UI that should say more than `0 * * * *`. */
export function nextFireFor(cron: string, after?: Date): Date | null {
  return nextFire(cron, after);
}
