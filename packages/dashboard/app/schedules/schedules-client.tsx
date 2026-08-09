"use client";

import { useState } from "react";
import type { ScheduleRun, ScheduleSummary } from "@/lib/schedules";
import { ago, stamp } from "@/lib/time";
import { describeCron } from "@evestack/schedules/cron";
import { agentClock, describeNextFire, formatOffset, type NextFire } from "./next-fire";
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
  nextFires,
}: {
  schedules: readonly ScheduleSummary[];
  recent: readonly ScheduleRun[];
  /**
   * Next-fire instants by schedule name, computed on the server. This used to
   * be `nextFire(schedule.cron)` called right here, which walked the calendar
   * in whichever timezone was rendering — the container during SSR, the
   * reader's browser during hydration — and printed a different UTC instant in
   * each. ./next-fire.ts has the measurement and the replacement.
   */
  nextFires: Readonly<Record<string, NextFire | null>>;
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
          const next = paused ? null : (nextFires[schedule.name] ?? null);
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
                    {/* The summary states a wall-clock time ("daily at 09:00")
                        and cron has no zone of its own, so the tooltip has to
                        say whose clock that is — the agent's, which is not
                        necessarily the reader's and not necessarily UTC. */}
                    <span
                      className="mono"
                      title={`${schedule.cron} — wall-clock fields, read in the agent's timezone`}
                    >
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
                    <span title={describeNextFire(next)}>
                      next {stamp(next.at, "second")}
                      {/* Three states, not two. The version this replaces drew
                          the confident chip whenever `pinned` was true and
                          "assumed UTC" otherwise, which left no way to say the
                          third thing — that the agent's zone is narrowed but
                          the candidates left disagree about THIS fire, which is
                          what happens either side of a daylight-saving change.
                          Under the old fixed-offset projection that case came
                          back `pinned: true` and an hour wrong; see the header
                          of ./next-fire.ts. */}
                      {next.pinned ? (
                        // Both halves, when they differ: the instant answers
                        // "when", the reading answers "is that the 09:00 I
                        // wrote?", and printing only one leaves the reader
                        // doing the subtraction and guessing the offset.
                        next.offsetMinutes !== 0 && (
                          <span className={styles.zone}>
                            {agentClock(next)} {formatOffset(next.offsetMinutes)}
                          </span>
                        )
                      ) : next.source === "assumed" ? (
                        <span className={styles.zone}>assumed UTC</span>
                      ) : (
                        <span className={`${styles.zone} ${styles.unconfirmed}`}>
                          unconfirmed · {formatOffset(next.offsetMinutes)}
                        </span>
                      )}
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
                          {/* History, not a rolling view: the last 100 runs of a nightly
                              schedule reach back months, and a yearly one further. The year
                              is what keeps two fires twelve months apart distinguishable. */}
                          {stamp(run.fireAt, "second", { year: true })}
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
