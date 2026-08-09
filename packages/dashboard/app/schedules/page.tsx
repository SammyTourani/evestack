import { DatabaseError } from "@/app/db-error";
import { getSchedules, type ScheduleRun } from "@/lib/schedules";
import { projectNextFire, type NextFire } from "./next-fire";
import { ScheduleList } from "./schedules-client";
import styles from "./schedules.module.css";

export const dynamic = "force-dynamic";

/**
 * The part of the agent that acts while nobody is watching.
 *
 * Everything here comes from `evestack.schedule_runs`, written by
 * `@evestack/schedules` inside the agent. The dashboard never fires a schedule;
 * eve's own runner does. This watches and holds the pause switch.
 */
export default async function SchedulesPage() {
  let view: Awaited<ReturnType<typeof getSchedules>>;
  try {
    view = await getSchedules();
  } catch (error) {
    return <DatabaseError error={error} />;
  }

  const failing = view.schedules.filter((s) => s.failingStreak > 0);

  // "Next run" is computed HERE and shipped down as an instant, not computed in
  // the list component. `./schedules-client.tsx` is a client component, and
  // calling a local-time cron walker inside one meant the number was recomputed
  // in the reader's browser and came out in the reader's timezone — see the
  // header of ./next-fire.ts for the measured three-zone spread and for why the
  // agent's zone is derived from its own recorded fires rather than assumed.
  const now = new Date();
  const nextFires: Record<string, NextFire | null> = {};
  for (const schedule of view.schedules) {
    if (!schedule.cron) {
      nextFires[schedule.name] = null;
      continue;
    }
    // Only fires recorded under THIS expression. `schedule_runs.cron` is written
    // per run, so a row from before the cron was edited is evidence about the
    // old expression and would pin the wrong zone from it.
    const observed = [schedule.lastRun, ...view.recent.filter((run) => run.name === schedule.name)]
      .filter((run): run is ScheduleRun => run !== null && run.cron === schedule.cron)
      .map((run) => run.fireAt);
    nextFires[schedule.name] = projectNextFire(schedule.cron, observed, now);
  }

  return (
    <>
      <h1>Schedules</h1>
      <p className="page-sub">
        Every cron fire the agent has recorded, and the switch to stop one. Self-hosted, eve runs
        schedules in-process and keeps no history — so this is the only record that a 3am job ran,
        failed, or never fired at all.
      </p>

      {!view.tableExists ? (
        <div className="empty">
          <h2>No tracked schedules yet</h2>
          <p>
            Wrap a schedule&apos;s handler with <code>tracked()</code> from{" "}
            <code>@evestack/schedules</code> and let it fire once. The template ships{" "}
            <code>agent/schedules/heartbeat.ts</code> as a worked example — set{" "}
            <code>EVESTACK_HEARTBEAT_CHANNEL</code> to turn it on.
          </p>
        </div>
      ) : (
        <>
          {failing.length > 0 && (
            <p className={styles.alarm}>
              {failing.length === 1
                ? `${failing[0]!.name} has failed its last ${failing[0]!.failingStreak} run${failing[0]!.failingStreak === 1 ? "" : "s"}.`
                : `${failing.length} schedules are currently failing.`}{" "}
              A schedule that fails quietly is the whole reason this page exists.
            </p>
          )}
          <ScheduleList schedules={view.schedules} recent={view.recent} nextFires={nextFires} />
        </>
      )}
    </>
  );
}
