import { getSessionSnapshot } from "./agent-client";
import { query } from "./db";

/**
 * Which sessions are stuck, and which are merely waiting for a person.
 *
 * eve has no recovery path for a session that stops making progress, and it is
 * a real failure mode rather than a theoretical one — upstream has open reports
 * of a self-hosted turn never resuming after a process crash, and of a parked
 * session that never resumes after a restart, both unanswered. The symptom is
 * the same either way: a session sits in `running` forever, the channel it came
 * from goes mute, and nothing in the framework will ever notice.
 *
 * THE DISTINCTION THAT MATTERS, and it is not the obvious one. Three different
 * states look identical in the workflow tables — all are a session that has not
 * moved in hours:
 *
 *   idle            its last turn finished; it waits for the next message
 *   awaiting-human  parked on an approval nobody has answered
 *   wedged          a turn started and never reached a terminal state
 *
 * Only the third is a fault. The first is what a healthy finished conversation
 * looks like forever, because eve leaves the run row `running` and the stream
 * `waiting` for the life of the session — so a detector that treats "waiting"
 * as broken reports every conversation you have ever had as an incident. That
 * is not hypothetical: the first version of this file did exactly that, and
 * called 22 healthy sessions wedged the first time it ran.
 *
 * Telling them apart is only possible from the agent, not from SQL: pending
 * input requests separate `awaiting-human`, and `waiting` itself separates a
 * finished turn from one still in flight. So classification probes the agent's
 * own snapshot.
 *
 * That probe costs an HTTP round trip per session, which is why the SQL query
 * narrows to plausible candidates first and the probe is bounded.
 */

export type SessionHealth =
  /**
   * Finished its last turn and waiting for the next message. THE NORMAL STATE
   * of every conversation anyone has ever had with the agent, and the reason
   * this file needs care: eve leaves a session's run row `running` and its
   * stream `waiting` for as long as the session lives, so "idle for a day"
   * describes a healthy session far more often than a broken one.
   */
  | "idle"
  /** A turn is in flight right now. */
  | "active"
  /** Parked on an approval or a question. Working as designed — it needs a person. */
  | "awaiting-human"
  /**
   * A turn started and never reached a terminal state. This is the shape of
   * the open upstream reports: a self-hosted turn that never resumes after the
   * process died mid-flight. Nothing in eve will ever notice or retry it.
   */
  | "wedged"
  /** The agent could not be reached, so nothing can be said about this session. */
  | "unknown";

export interface FleetEntry {
  readonly sessionId: string;
  readonly title: string | null;
  readonly trigger: string | null;
  readonly createdAt: string;
  readonly idleMs: number;
  readonly health: SessionHealth;
  readonly pendingCount: number;
  /** Why it was classified this way, in words a human can act on. */
  readonly reason: string;
}

export interface FleetReport {
  readonly entries: FleetEntry[];
  readonly checked: number;
  /** Candidates that existed but were not probed, because the probe is bounded. */
  readonly unchecked: number;
}

/**
 * How long a session may sit still before it is worth probing.
 *
 * Deliberately generous. eve keeps a session's run open until it times out, so
 * an idle conversation is the normal steady state, not a fault — a dashboard
 * that flags every quiet session teaches its reader to ignore it.
 */
const IDLE_BEFORE_SUSPECT_MS = 30 * 60 * 1000;

/** Probing costs a round trip each, so the sweep is bounded rather than complete. */
const MAX_PROBES = 25;

/**
 * How long a turn may be in flight before it is presumed dead.
 *
 * Generous on purpose: a turn doing real work through a sandbox can legitimately
 * run for many minutes, and eve's own cancellation is cooperative — a cancelled
 * turn's model call keeps streaming for up to ~90s. An hour is far past anything
 * legitimate and far short of a working day.
 */
const STUCK_TURN_MS = 60 * 60 * 1000;

export async function inspectFleet(
  options: { idleMs?: number; limit?: number; signal?: AbortSignal } = {},
): Promise<FleetReport> {
  const idleThreshold = options.idleMs ?? IDLE_BEFORE_SUSPECT_MS;
  const limit = Math.min(options.limit ?? MAX_PROBES, 100);

  // Candidates: open sessions whose most recent child run finished a while ago
  // (or which never had one). The join is to turns rather than to the session
  // row because the session row's own timestamps do not move as turns run.
  const rows = await query<Record<string, unknown>>(
    `
    SELECT s.id AS session_id,
           s.attributes->>'$eve.title'   AS title,
           s.attributes->>'$eve.trigger' AS trigger,
           s.created_at,
           -- updated_at on the child turns is the truest activity signal we
           -- have: the session row's own timestamps do not move as turns run,
           -- so joining to children is what distinguishes "quiet for an hour"
           -- from "created an hour ago and busy ever since".
           -- (No backticks in here: this is a template literal, and one inside
           -- the SQL ends the string with a parse error nowhere near the cause.)
           GREATEST(s.updated_at, COALESCE(MAX(t.updated_at), s.updated_at)) AS last_activity
    FROM workflow.workflow_runs s
    LEFT JOIN workflow.workflow_runs t
      ON t.attributes->>'$eve.root' = s.id
    WHERE s.attributes->>'$eve.type' = 'session'
      AND s.status = 'running'
    GROUP BY s.id, s.attributes, s.created_at, s.updated_at
    HAVING GREATEST(s.updated_at, COALESCE(MAX(t.updated_at), s.updated_at)) < now() - ($1 || ' milliseconds')::interval
    ORDER BY last_activity ASC
    LIMIT $2
    `,
    [String(idleThreshold), limit + 1],
  );

  const candidates = rows.slice(0, limit);
  const unchecked = Math.max(0, rows.length - limit);

  const entries = await Promise.all(
    candidates.map(async (raw): Promise<FleetEntry> => {
      const sessionId = String(raw.session_id);
      // Already Date objects: lib/db.ts installs a type parser that reads
      // eve's zone-less `timestamp` columns as the UTC they actually are.
      // Re-parsing them from a string here would undo that fix and put every
      // idle time out by the host's offset.
      const lastActivity = raw.last_activity as Date;
      const idleMs = Date.now() - lastActivity.getTime();

      const base = {
        sessionId,
        title: (raw.title as string) ?? null,
        trigger: (raw.trigger as string) ?? null,
        createdAt: (raw.created_at as Date).toISOString(),
        idleMs,
      };

      try {
        const snapshot = await getSessionSnapshot(sessionId, {
          ...(options.signal ? { signal: options.signal } : {}),
        });

        if (snapshot.terminal) {
          // The run row says running, the stream says finished. Not wedged —
          // the row is just stale bookkeeping, which is normal for eve.
          return { ...base, health: "active", pendingCount: 0, reason: "already finished" };
        }

        if (snapshot.pendingRequests.length > 0) {
          return {
            ...base,
            health: "awaiting-human",
            pendingCount: snapshot.pendingRequests.length,
            reason:
              snapshot.pendingRequests.length === 1
                ? "parked on a decision nobody has made"
                : `parked on ${snapshot.pendingRequests.length} decisions nobody has made`,
          };
        }

        // Waiting with nothing outstanding is a FINISHED conversation, not a
        // broken one. An earlier version of this called it wedged and reported
        // 22 healthy sessions as faults on the first machine it ran against —
        // which is precisely the cry-wolf failure this module was written to
        // avoid, so the wrong answer is recorded here rather than just fixed.
        if (snapshot.waiting) {
          return {
            ...base,
            health: "idle",
            pendingCount: 0,
            reason: "finished its last turn, waiting for the next message",
          };
        }

        // Not waiting and not terminal means a turn is in flight. That is
        // healthy for a few seconds and deeply suspicious after an hour: it is
        // the shape of a turn whose process died mid-flight, which eve does not
        // detect or retry.
        return {
          ...base,
          health: idleMs > STUCK_TURN_MS ? "wedged" : "active",
          pendingCount: 0,
          reason:
            idleMs > STUCK_TURN_MS
              ? "a turn started and never finished — nothing in eve will resume it"
              : "a turn is running",
        };
      } catch (error) {
        return {
          ...base,
          health: "unknown",
          pendingCount: 0,
          reason: `the agent could not be reached (${error instanceof Error ? error.message : String(error)})`,
        };
      }
    }),
  );

  return { entries, checked: entries.length, unchecked };
}

/** The counts a banner needs, without rendering the whole report. */
export function summarize(report: FleetReport): {
  wedged: number;
  idle: number;
  awaitingHuman: number;
  unknown: number;
} {
  return {
    wedged: report.entries.filter((e) => e.health === "wedged").length,
    idle: report.entries.filter((e) => e.health === "idle").length,
    awaitingHuman: report.entries.filter((e) => e.health === "awaiting-human").length,
    unknown: report.entries.filter((e) => e.health === "unknown").length,
  };
}
