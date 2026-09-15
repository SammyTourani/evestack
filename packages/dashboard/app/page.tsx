import { listTasks } from "@/lib/tasks";
import { TaskCards } from "@/components/task-cards";
import { DecisionQueue } from "@/components/decision-queue";
import { routineOverview } from "@/lib/routines";
import { routineClockStatus } from "@/lib/routine-dispatcher";
import { readReadiness } from "@/lib/readiness";
import { DatabaseError } from "./db-error";

export const dynamic = "force-dynamic";
export default async function TodayPage() {
  const [tasks, routines, readiness] = await Promise.allSettled([
    listTasks(6),
    routineOverview(),
    readReadiness(),
  ]);
  if (tasks.status === "rejected")
    return <DatabaseError error={tasks.reason} />;
  const result = tasks.value;
  const clock = routineClockStatus();
  const setup = (
    <>
      <ol className="setup-steps">
        <li>
          <a href="/settings">Check your agent and model</a>
        </li>
        <li>
          <a href="/connections">Connect a source</a>
        </li>
        <li>
          <a href="/chat?example=repository-brief">Run a repository brief</a>
        </li>
        <li>
          <a href="/routines">Test and schedule a repeat</a>
        </li>
      </ol>
      <p className="page-sub">
        Start with a read-only brief. Check its sources and limits before
        leaving it unattended.
      </p>
    </>
  );
  return (
    <>
      <div className="workspace-heading">
        <div>
          <h1>Today</h1>
          <p className="page-sub">
            See what needs you, pick up a result, and plan the next run.
          </p>
        </div>
        <a className="primary-action" href="/chat">
          New task
        </a>
      </div>
      {readiness.status === "fulfilled" &&
        !readiness.value.checks.find((check) => check.name === "Agent")
          ?.ready && (
          <p className="routine-error" role="status">
            The agent is unreachable. Saved work is still available; new work
            and live decisions need the agent to reconnect.{" "}
            <a href="/settings">Check setup</a>.
          </p>
        )}
      {readiness.status === "rejected" && (
        <p role="status">
          Setup health could not be checked.{" "}
          <a href="/settings">Recheck setup</a>.
        </p>
      )}
      {result.tasks.length ? (
        <details className="workspace-section">
          <summary>Setup checklist &amp; example task</summary>
          {setup}
        </details>
      ) : (
        <section className="workspace-section">
          <h2>Your first useful result</h2>
          {setup}
        </section>
      )}
      <DecisionQueue />
      <section className="workspace-section">
        <div className="workspace-heading">
          <h2>Recurring work</h2>
          <a href="/routines">Open Routines</a>
        </div>
        {routines.status === "rejected" ? (
          <p role="status">
            Routine state could not be read. Open Routines to retry and inspect
            the error.
          </p>
        ) : routines.value.length === 0 ? (
          <p>
            No scheduled or active routines yet.{" "}
            <a href="/routines">Test a repeatable task</a> to add one.
          </p>
        ) : (
          <>
            {(!clock.running || clock.error) && (
              <p role="status" className="routine-error">
                The routine clock needs attention.{" "}
                {clock.error ??
                  "Keep the configured dashboard running to dispatch scheduled work."}
              </p>
            )}
            <div className="task-cards">
              {routines.value.map((routine) => (
                <article className="task-card" key={routine.id}>
                  <div className="workspace-heading">
                    <h3>
                      <a href={`/routines?routine=${routine.id}`}>
                        {routine.name}
                      </a>
                    </h3>
                    <span>
                      {routine.state?.replaceAll("_", " ") ?? "Scheduled"}
                    </span>
                  </div>
                  <p className="page-sub">
                    {routine.enabled
                      ? `Next: ${new Date(routine.next_due).toLocaleString("en", { timeZone: routine.time_zone, timeZoneName: "short" })} (${routine.time_zone})`
                      : "Paused"}
                  </p>
                  {routine.error && <p>{routine.error}</p>}
                  {routine.session_id && (
                    <a
                      href={`/chat?session=${encodeURIComponent(routine.session_id)}`}
                    >
                      Open latest task
                    </a>
                  )}
                </article>
              ))}
            </div>
          </>
        )}
      </section>
      <div className="workspace-heading">
        <h2>Recent work</h2>
        <a href="/tasks">All tasks</a>
      </div>
      {result.tasks.length ? (
        <TaskCards tasks={result.tasks} />
      ) : (
        <p>No tasks yet. Your first result will appear here.</p>
      )}
      <p className="page-sub">
        <a href="/diagnostics">Open diagnostics</a> for fleet health, spend,
        traces and detailed run history.
      </p>
    </>
  );
}
