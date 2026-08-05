import { DatabaseUnavailableError, describeDbError } from "@/lib/db";
import { getSchedules } from "@/lib/schedules";
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
    const unavailable = error instanceof DatabaseUnavailableError;
    return (
      <div className="empty">
        <h2>{unavailable ? "Database unreachable" : "Could not read schedules"}</h2>
        <p>{describeDbError(error)}</p>
      </div>
    );
  }

  const failing = view.schedules.filter((s) => s.failingStreak > 0);

  return (
    <>
      <h1>Schedules</h1>
      <p className={styles.sub}>
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
          <ScheduleList schedules={view.schedules} recent={view.recent} />
        </>
      )}
    </>
  );
}
