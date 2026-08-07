import * as store from "./store.js";
import { pauseWith, trackedWith, type TrackedOptions } from "./runner.js";

export { describeCron, missedFires, nextFire, parseCron, CronParseError } from "./cron.js";
export { closePool, ensureSchema, isPaused, lastFireAt, setPaused } from "./store.js";
export type { CronFields } from "./cron.js";
export type { ScheduleRunRow } from "./store.js";
export type { TrackedOptions };

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
 *
 * This module is the wiring and the public surface: it names the Postgres store
 * once and hands it to the runner, which holds the ordering rules and takes the
 * store as an argument so they can be tested without one.
 */

/**
 * Wrap a schedule handler so every fire is recorded, pauses are honored, and
 * missed ticks can be replayed.
 *
 * `cron` is parsed here, at wrap time, so an expression we cannot interpret fails
 * at module load rather than at 3am on the first fire.
 *
 * Failures inside the wrapper never take down the handler. A schedule that stops
 * running because its bookkeeping database is unreachable would be a strictly
 * worse outcome than one that runs unrecorded, so a store error is logged and
 * swallowed. The one thing that does stop the handler is a tick already recorded
 * — one scheduled fire runs once, whichever worker or catch-up got there first.
 */
export function tracked<TArgs>(
  name: string,
  cron: string,
  handler: (args: TArgs) => unknown | Promise<unknown>,
  options: TrackedOptions = {},
): (args: TArgs) => Promise<void> {
  return trackedWith(store, name, cron, handler, options);
}

/** Pause a schedule without a redeploy. */
export async function pause(name: string, by?: string): Promise<void> {
  await pauseWith(store, name, true, by);
}

export async function resume(name: string, by?: string): Promise<void> {
  await pauseWith(store, name, false, by);
}
