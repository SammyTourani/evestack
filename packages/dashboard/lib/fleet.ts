import { type SessionSnapshot, getSessionSnapshot } from "./agent-client";
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
 *
 * BUT THE SNAPSHOT CAN BE SILENT, and that is the second way to report 22
 * healthy sessions as wedged. `getSessionSnapshot` folds boundary events off
 * the durable stream, and a stream with no events folds to `waiting: false,
 * terminal: false` — which reads exactly like a turn in flight. That is not a
 * corner case: an agent asked about a session it has no stream for answers 200
 * with `x-eve-stream-tail-index: -1` rather than 404 (measured against the
 * agent on :2000), so every session whose stream was pruned, or which belongs
 * to an agent restarted onto fresh storage, folds silent. Against the seeded
 * 30-day database that was 166 of 174 candidates called wedged, every one of
 * which the run rows prove finished.
 *
 * So silence is not evidence, and the tables get the last word on the one
 * question they can actually answer: is any turn of this session still open.
 * `wedged` now requires BOTH — a stream that does not say waiting, AND a turn
 * row that never reached a terminal state. The stream still wins where it
 * speaks, because `waiting` is the fact SQL cannot see.
 *
 * WHAT COUNTS AS FINISHED IS NOT THIS FILE'S TO DEFINE. lib/monitors.ts is the
 * source of truth for the workflow tables' failure vocabulary, and this file
 * uses its tests verbatim: a turn is finished when `completed_at IS NOT NULL`,
 * never when `status` says so. That distinction is the whole audit — of 1,923
 * seeded turns, 111 failed outright, 62 finished without ever reaching a
 * provider, and 37 were cancelled by a human; all 210 are FINISHED, and exactly
 * 8 turns in the database are not. A wedge test written on `status <>
 * 'completed'` would report 210 turns as still in flight, and one written on
 * `error_code IS NOT NULL` would call a failure a wedge.
 */

export type SessionHealth =
  /**
   * Nothing is in flight and nobody is being waited on: its last turn finished,
   * or the session has ended, or it never started a turn at all. THE NORMAL
   * STATE of every conversation anyone has ever had with the agent, and the
   * reason this file needs care: eve leaves a session's run row `running` and
   * its stream `waiting` for as long as the session lives, so "idle for a day"
   * describes a healthy session far more often than a broken one. The `reason`
   * on the entry says which of the three it is.
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
  /**
   * The session's name as it reads INSIDE A SENTENCE. See `sessionLabel`: the
   * raw title is a whole instruction, and a banner that drops three of them
   * into prose produces the line RESEARCH.md §6 recorded.
   */
  readonly label: string;
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

/**
 * How long a label may be before it stops being a name and starts being prose.
 *
 * A `$eve.title` is whatever the first message said, so it is routinely a whole
 * instruction: "Use your bash tool to run exactly this and report back". Three
 * of those, comma-joined into a sentence, is the banner line RESEARCH.md §6
 * measured: "8 sessions wedged. … Use your bash tool to run exactly this a,
 * ping-no-origin, ping and 5 more". Short enough to read as a name, long enough
 * to tell two sessions apart.
 */
const LABEL_MAX = 32;

/**
 * A session's name, safe to drop into a sentence.
 *
 * Three things, all of which the old inline `title.slice(0, 40)` got wrong:
 * only the first line survives (a pasted stack trace is not a name), runs of
 * whitespace collapse, and the cut lands on a word boundary with an ellipsis
 * that says a cut happened. With no usable title it falls back to the tail of
 * the id, which is what the operator will paste into a URL anyway.
 *
 * Pure and exported so the truncation is unit-tested rather than eyeballed in
 * a banner nobody re-renders with a 400-character title.
 */
export function sessionLabel(title: string | null | undefined, sessionId: string): string {
  const firstLine = (title ?? "").split("\n", 1)[0] ?? "";
  const clean = firstLine.replace(/\s+/g, " ").trim();
  if (clean.length === 0) return `session ${sessionId.slice(-8)}`;
  if (clean.length <= LABEL_MAX) return clean;

  // Cut inside the budget, then back up to the last space so the label ends on
  // a whole word. A single long word has no space to back up to, so it is cut
  // where it is rather than thrown away.
  const cut = clean.slice(0, LABEL_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  const kept = lastSpace > LABEL_MAX / 2 ? cut.slice(0, lastSpace) : cut;
  return `${kept.replace(/[\s,.;:—-]+$/, "")}…`;
}

/**
 * What the workflow tables know about one session's turns.
 *
 * This is the half of the classification that does not need the agent, and the
 * half that stops a silent stream from reading as a wedge. Its definition of
 * finished is lib/monitors.ts's — `completed_at IS NOT NULL` — so an errored,
 * a no-model-call and a cancelled turn are all finished here, exactly as they
 * are there.
 */
export interface TurnEvidence {
  /** Turns and subagents this session has ever had. */
  readonly turns: number;
  /** How many of them have no `completed_at`. */
  readonly unfinished: number;
  /** Age of the OLDEST unfinished turn, or null when every turn finished. */
  readonly inFlightMs: number | null;
}

/**
 * The classification itself, kept pure so both false-positive shapes are unit
 * tests rather than things we hope about.
 *
 * Decision order is deliberate: the stream's own words first, because
 * `terminal`, a pending request and `waiting` are facts SQL cannot see; then
 * the tables, which are the only witness left once the stream says nothing.
 */
export function classifySession(
  snapshot: Pick<SessionSnapshot, "terminal" | "waiting" | "pendingRequests">,
  evidence: TurnEvidence,
  idleMs: number,
): Pick<FleetEntry, "health" | "pendingCount" | "reason"> {
  if (snapshot.terminal) {
    // The stream says the session is over while the run row still says running.
    // Stale bookkeeping, which is normal for eve — and NOT `active`: nothing is
    // in flight in a session that has ended, so calling it active would put a
    // finished conversation in the same bucket as a turn burning tokens.
    return {
      health: "idle",
      pendingCount: 0,
      reason: "the session has ended; its run row is stale bookkeeping",
    };
  }

  if (snapshot.pendingRequests.length > 0) {
    const pendingCount = snapshot.pendingRequests.length;
    return {
      health: "awaiting-human",
      pendingCount,
      reason:
        pendingCount === 1
          ? "parked on a decision nobody has made"
          : `parked on ${pendingCount} decisions nobody has made`,
    };
  }

  // Waiting with nothing outstanding is a FINISHED conversation, not a broken
  // one. An earlier version of this called it wedged and reported 22 healthy
  // sessions as faults on the first machine it ran against — which is precisely
  // the cry-wolf failure this module was written to avoid, so the wrong answer
  // is recorded here rather than just fixed.
  if (snapshot.waiting) {
    return {
      health: "idle",
      pendingCount: 0,
      reason: "finished its last turn, waiting for the next message",
    };
  }

  // Nothing on the stream says waiting, parked or over. That is what a turn in
  // flight looks like — and equally what a pruned stream looks like, so ask the
  // tables before crying wolf. No open turn row means nothing can be in flight,
  // whatever the stream's silence suggests.
  if (evidence.unfinished === 0) {
    return {
      health: "idle",
      pendingCount: 0,
      reason:
        evidence.turns === 0
          ? "no turn has ever started in this session"
          : "every turn it started has finished — the agent's stream is silent, the run rows are not",
    };
  }

  // A turn row that never reached a terminal state. Healthy for a few seconds,
  // deeply suspicious after an hour: it is the shape of a turn whose process
  // died mid-flight, which eve does not detect or retry.
  //
  // Age comes from the unfinished turn's own start where it has one, not from
  // the session's idle time, so "started 4 hours ago" cannot be softened by a
  // later row touching the session. `started_at` can be null on a run that was
  // created and never picked up; idle time is the honest fallback there.
  const inFlightMs = evidence.inFlightMs ?? idleMs;
  return inFlightMs > STUCK_TURN_MS
    ? {
        health: "wedged",
        pendingCount: 0,
        reason: "a turn started and never finished — nothing in eve will resume it",
      }
    : { health: "active", pendingCount: 0, reason: "a turn is running" };
}

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
           GREATEST(s.updated_at, COALESCE(MAX(t.updated_at), s.updated_at)) AS last_activity,

           -- The wedge evidence. Two filters carry the whole audit, and neither
           -- may grow a backtick: this is a template literal, and one inside
           -- the SQL ends the string with a parse error nowhere near the cause.
           --
           -- The type filter is lib/monitors.ts's unit of work. eve writes an
           -- untagged companion run per session that never completes — 701 of
           -- them in the seeded database, one per session — and a single one
           -- counted as an open turn would report the whole fleet as wedged.
           -- Today they are excluded by the join, which needs $eve.root, and
           -- they carry none; this filter is what keeps them harmless if that
           -- ever changes, since they carry no $eve.type either.
           --
           -- completed_at IS NULL is lib/monitors.ts's test for unfinished, and
           -- status is deliberately not consulted. A cancelled turn, a failed
           -- turn and a turn that never reached the provider have all FINISHED;
           -- monitors.ts counts the last two as failures and this file must not
           -- re-count them as work in flight.
           COUNT(t.id) FILTER (
             WHERE t.attributes->>'$eve.type' IN ('turn', 'subagent')
           ) AS turns,
           COUNT(t.id) FILTER (
             WHERE t.attributes->>'$eve.type' IN ('turn', 'subagent')
               AND t.completed_at IS NULL
           ) AS unfinished_turns,
           MIN(t.started_at) FILTER (
             WHERE t.attributes->>'$eve.type' IN ('turn', 'subagent')
               AND t.completed_at IS NULL
           ) AS in_flight_since,

           -- Window functions run after HAVING and before LIMIT, so this is the
           -- true candidate count rather than what fits in one page. Fetching
           -- limit + 1 rows to detect the overflow, which is what this replaced,
           -- can only ever report "1 more" — the banner said one further session
           -- was unchecked while 149 were.
           COUNT(*) OVER () AS candidate_count
    FROM workflow.workflow_runs s
    LEFT JOIN workflow.workflow_runs t
      ON t.attributes->>'$eve.root' = s.id
    WHERE s.attributes->>'$eve.type' = 'session'
      AND s.status = 'running'
    GROUP BY s.id, s.attributes, s.created_at, s.updated_at
    -- Both sides of the cut are naive UTC. These columns are timestamp WITHOUT
    -- time zone; comparing one to a bare now() makes Postgres read it in the
    -- server's zone, which shifts the idle window by the offset. The CLI port
    -- of this file hit it for real: a session quiet for three hours looked five
    -- hours in the future and the sweep returned nothing.
    HAVING GREATEST(s.updated_at, COALESCE(MAX(t.updated_at), s.updated_at))
             < (now() AT TIME ZONE 'utc') - ($1 || ' milliseconds')::interval
    ORDER BY last_activity ASC
    LIMIT $2
    `,
    [String(idleThreshold), limit],
  );

  // Every row read is probed; the ones over the bound were never fetched.
  const candidateCount = Number(rows[0]?.candidate_count ?? 0);
  const unchecked = Math.max(0, candidateCount - rows.length);

  const entries = await Promise.all(
    rows.map(async (raw): Promise<FleetEntry> => {
      const sessionId = String(raw.session_id);
      // Already Date objects: lib/db.ts installs a type parser that reads
      // eve's zone-less `timestamp` columns as the UTC they actually are.
      // Re-parsing them from a string here would undo that fix and put every
      // idle time out by the host's offset.
      const lastActivity = raw.last_activity as Date;
      const idleMs = Date.now() - lastActivity.getTime();
      const title = (raw.title as string) ?? null;

      // `in_flight_since` is a Date for the same reason (and null when every
      // turn finished, which is a MIN over an empty filter rather than missing
      // data).
      const inFlightSince = (raw.in_flight_since as Date | null) ?? null;
      const evidence: TurnEvidence = {
        turns: Number(raw.turns ?? 0),
        unfinished: Number(raw.unfinished_turns ?? 0),
        inFlightMs: inFlightSince === null ? null : Date.now() - inFlightSince.getTime(),
      };

      const base = {
        sessionId,
        title,
        label: sessionLabel(title, sessionId),
        trigger: (raw.trigger as string) ?? null,
        createdAt: (raw.created_at as Date).toISOString(),
        idleMs,
      };

      try {
        const snapshot = await getSessionSnapshot(sessionId, {
          ...(options.signal ? { signal: options.signal } : {}),
        });

        return { ...base, ...classifySession(snapshot, evidence, idleMs) };
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
