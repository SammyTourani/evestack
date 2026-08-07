import { missedFires, parseCron } from "./cron.js";

/**
 * The wrapper's ordering rules, with the store as a parameter.
 *
 * Split out of index.ts for one reason: the rules below — which tick a catch-up
 * may replay, and what a refused claim is allowed to mean — are the part of this
 * package whose bugs are only visible in the sequence of calls a single fire
 * makes, and index.ts imports the Postgres store directly, so a test had nowhere
 * to stand. The package's `exports` map publishes `.` and `./cron` and nothing
 * else, so this module is a seam for test/tracked.test.mjs rather than API: a
 * consumer cannot reach it, and index.ts stays the one place the real store is
 * named.
 */

export interface ScheduleStore {
  claimRun(input: {
    name: string;
    cron?: string | undefined;
    fireAt: Date;
    caughtUp?: boolean;
  }): Promise<string | null>;
  finishRun(
    id: string,
    outcome: { status: "completed" | "failed" | "skipped"; error?: string; sessionId?: string },
  ): Promise<void>;
  isPaused(name: string): Promise<boolean>;
  lastFireAt(name: string): Promise<Date | null>;
  setPaused(name: string, paused: boolean, by?: string): Promise<void>;
}

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
 * What we learned by trying to claim a tick.
 *
 * "taken" and "unrecorded" were both `null`, and conflating them is exactly what
 * made a restart run the handler twice: the live fire could not tell "the
 * catch-up recorded this tick a second ago" from "the database is unreachable",
 * so it had to assume the second and run. The two pull in opposite directions —
 * one must stop the handler, the other must never stop it — so they are now
 * different answers.
 */
type Claim =
  | { readonly kind: "claimed"; readonly id: string }
  | { readonly kind: "taken" }
  | { readonly kind: "unrecorded" };

/**
 * `tracked()` with the store handed in. The public wrapper is in index.ts; the
 * order of operations is here — pause check, then catch-up once, then the live
 * fire, each of which has to decide what a refused claim means.
 *
 * A store error is logged and swallowed rather than allowed to stop a schedule,
 * with one exception: the pause check, where failing open is the safe direction
 * and is what happens.
 */
export function trackedWith<TArgs>(
  store: ScheduleStore,
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
    if (await pausedSafely(store, name)) {
      const tick = currentTick();
      const claim = await claimSafely(store, { name, cron, fireAt: tick });
      if (claim.kind === "claimed") {
        await finishSafely(store, claim.id, { status: "skipped", error: "schedule is paused" });
      }
      return;
    }

    if (options.catchUp && !caughtUp) {
      caughtUp = true;
      await replayMissed(store, name, cron, handler, args, options);
    }

    await runOnce(store, name, cron, currentTick(), false, handler, args);
  };
}

async function runOnce<TArgs>(
  store: ScheduleStore,
  name: string,
  cron: string,
  fireAt: Date,
  isCatchUp: boolean,
  handler: (args: TArgs) => unknown | Promise<unknown>,
  args: TArgs,
): Promise<void> {
  const claim = await claimSafely(store, { name, cron, fireAt, caughtUp: isCatchUp });

  // A tick already in the table belongs to whoever wrote it — a racing worker,
  // or the catch-up that ran a moment ago in this same process — and running the
  // handler a second time for one scheduled fire means a second model turn and a
  // second message posted, while the dashboard shows one run. So stop, and stop
  // for the LIVE fire too: the old guard was `if (id === null && isCatchUp)`,
  // which only ever protected replays, so the fire the catch-up had just claimed
  // fell straight through to the handler.
  //
  // The cost is deliberate and worth naming: a process that dies mid-handler
  // leaves its tick claimed, so a re-fire of that same minute is skipped rather
  // than retried. At-most-once per tick is the promise the unique index already
  // made, and the row is there to be seen.
  if (claim.kind === "taken") return;

  // "unrecorded" is the opposite case: the store itself failed, we learned
  // nothing about this tick, and bookkeeping never stops a schedule. Run it, and
  // run it unrecorded.
  const id = claim.kind === "claimed" ? claim.id : null;

  try {
    await handler(args);
    if (id) await finishSafely(store, id, { status: "completed" });
  } catch (error) {
    if (id) {
      await finishSafely(store, id, {
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
  store: ScheduleStore,
  name: string,
  cron: string,
  handler: (args: TArgs) => unknown | Promise<unknown>,
  args: TArgs,
  options: TrackedOptions,
): Promise<void> {
  try {
    const last = await store.lastFireAt(name);
    if (!last) return;

    const window = options.catchUpWindowMs ?? DEFAULT_CATCH_UP_WINDOW_MS;
    const floor = new Date(Date.now() - window);
    const from = last.getTime() > floor.getTime() ? last : floor;

    const limit = options.catchUpLimit ?? DEFAULT_CATCH_UP_LIMIT;
    // The tick we are inside is not a missed tick, it is the one about to run —
    // and `missedFires` is inclusive of its end on purpose, so that a gap ending
    // on a fire replays that fire. Both are right; together they handed the live
    // fire's own tick to the replay list, and the handler ran twice for it. So
    // the window stops one minute short of now.
    const until = new Date(currentTick().getTime() - 60_000);
    const { fires, truncated } = missedFires(cron, from, until, limit);
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
        await runOnce(store, name, cron, fire, true, handler, args);
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

async function pausedSafely(store: ScheduleStore, name: string): Promise<boolean> {
  try {
    return await store.isPaused(name);
  } catch (error) {
    // Fail open. A schedule that stops firing because the pause table could not
    // be read is a silent outage; one that fires when it should have been
    // paused is visible in the history.
    console.error(`[evestack:schedules] ${name}: could not read pause state, running anyway`, error);
    return false;
  }
}

async function claimSafely(
  store: ScheduleStore,
  input: { name: string; cron?: string | undefined; fireAt: Date; caughtUp?: boolean },
): Promise<Claim> {
  try {
    const id = await store.claimRun(input);
    return id === null ? { kind: "taken" } : { kind: "claimed", id };
  } catch (error) {
    console.error(`[evestack:schedules] ${input.name}: could not record this fire`, error);
    return { kind: "unrecorded" };
  }
}

async function finishSafely(
  store: ScheduleStore,
  id: string,
  outcome: { status: "completed" | "failed" | "skipped"; error?: string; sessionId?: string },
): Promise<void> {
  try {
    await store.finishRun(id, outcome);
  } catch (error) {
    console.error("[evestack:schedules] could not record the outcome of a fire", error);
  }
}

/**
 * The pause switch, which is a write and so does not get the fail-open treatment
 * the read does: if it cannot be recorded the caller has to hear about it, or a
 * human clicks "pause" and the schedule keeps running.
 */
export async function pauseWith(
  store: ScheduleStore,
  name: string,
  paused: boolean,
  by?: string,
): Promise<void> {
  await store.setPaused(name, paused, by);
}
