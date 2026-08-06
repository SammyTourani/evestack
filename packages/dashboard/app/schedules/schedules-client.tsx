"use client";

import { useState } from "react";
import type { ScheduleRun, ScheduleSummary } from "@/lib/schedules";
import { ago, stamp } from "@/lib/time";
import { describeCron, nextFire } from "@evestack/schedules/cron";
import styles from "./schedules.module.css";

function statusClass(status: string): string {
  switch (status) {
    case "completed":
      return "status-completed";
    case "failed":
      return "status-failed";
    case "running":
      return "status-running";
    default:
      return "status-waiting";
  }
}

export function ScheduleList({
  schedules,
  recent,
}: {
  schedules: readonly ScheduleSummary[];
  recent: readonly ScheduleRun[];
}) {
  const [pausing, setPausing] = useState<string | null>(null);
  const [state, setState] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  async function toggle(name: string, paused: boolean) {
    setPausing(name);
    setError(null);
    try {
      const response = await fetch(`/api/schedules/${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paused }),
      });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status}).`);
      setState((prev) => ({ ...prev, [name]: paused }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change the schedule.");
    } finally {
      setPausing(null);
    }
  }

  return (
    <>
      {error && <p className={styles.error}>{error}</p>}

      <ul className={styles.list}>
        {schedules.map((schedule) => {
          const paused = state[schedule.name] ?? schedule.paused;
          const next = schedule.cron && !paused ? nextFire(schedule.cron) : null;
          const runs = recent.filter((run) => run.name === schedule.name);

          return (
            <li key={schedule.name} className={styles.item}>
              <div className={styles.head}>
                <span className={styles.name}>{schedule.name}</span>
                {paused ? (
                  <span className="status status-failed">paused</span>
                ) : (
                  <span className={`status ${statusClass(schedule.lastRun?.status ?? "waiting")}`}>
                    {schedule.lastRun?.status ?? "idle"}
                  </span>
                )}
                {schedule.failingStreak > 0 && !paused && (
                  <span className={styles.streak}>
                    {schedule.failingStreak} consecutive failure
                    {schedule.failingStreak === 1 ? "" : "s"}
                  </span>
                )}
                <button
                  type="button"
                  className={styles.toggle}
                  disabled={pausing === schedule.name}
                  onClick={() => toggle(schedule.name, !paused)}
                >
                  {pausing === schedule.name ? "…" : paused ? "resume" : "pause"}
                </button>
              </div>

              <div className={styles.meta}>
                {schedule.cron && (
                  <>
                    <span className="mono" title={schedule.cron}>
                      {describeCron(schedule.cron)}
                    </span>
                    <span className={styles.dot}>•</span>
                  </>
                )}
                <span>
                  {schedule.totalRuns} run{schedule.totalRuns === 1 ? "" : "s"}
                  {schedule.failures > 0 && `, ${schedule.failures} failed`}
                </span>
                {schedule.lastRun && (
                  <>
                    <span className={styles.dot}>•</span>
                    <span title={stamp(schedule.lastRun.fireAt, "second")}>
                      last {ago(schedule.lastRun.fireAt)}
                    </span>
                  </>
                )}
                {next && (
                  <>
                    <span className={styles.dot}>•</span>
                    <span title={next.toISOString()}>
                      next {stamp(next.toISOString(), "second")}
                    </span>
                  </>
                )}
                {paused && schedule.pausedBy && (
                  <>
                    <span className={styles.dot}>•</span>
                    <span>paused by {schedule.pausedBy}</span>
                  </>
                )}
                <button
                  type="button"
                  className={styles.expand}
                  onClick={() =>
                    setExpanded((prev) => (prev === schedule.name ? null : schedule.name))
                  }
                >
                  {expanded === schedule.name ? "hide history" : "history"}
                </button>
              </div>

              {expanded === schedule.name && (
                <table className={styles.history}>
                  <thead>
                    <tr>
                      <th>Fire</th>
                      <th>Status</th>
                      <th>Took</th>
                      <th>Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((run) => (
                      <tr key={run.id}>
                        <td className="mono">
                          {stamp(run.fireAt, "second")}
                          {run.caughtUp && (
                            <span
                              className={styles.caught}
                              title="Replayed on boot — this tick was missed while the process was down."
                            >
                              caught up
                            </span>
                          )}
                        </td>
                        <td>
                          <span className={`status ${statusClass(run.status)}`}>{run.status}</span>
                        </td>
                        <td>{run.durationMs === null ? "—" : `${run.durationMs}ms`}</td>
                        <td className={styles.detail}>{run.error ?? ""}</td>
                      </tr>
                    ))}
                    {runs.length === 0 && (
                      <tr>
                        <td colSpan={4} className="faint">
                          No runs in the last 100 recorded.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
