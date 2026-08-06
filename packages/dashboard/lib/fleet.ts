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
 * SO SILENCE IS NOT EVIDENCE, AND THE TABLES CHOOSE WHO GETS ASKED. A session
 * with no open turn row has nothing in flight, whatever its stream does or
 * does not say, so the candidate query refuses it and no round trip is spent
 * on it. That is not only cheaper, it is what makes the fault sweep complete
 * instead of sampled: ordering all 174 seeded candidates by last activity and
 * probing the first 25 reached 1 of the 8 sessions with an open turn and spent
 * the other 24 round trips re-asking about sessions the same query had already
 * settled. Filtering instead of paging costs 8 round trips and finds all 8.
 *
 * WHAT THAT GIVES UP is the parked sessions the tables cannot see. eve's turn
 * workflow RETURNS when it parks on a human — `emitTurnEpilogue` puts
 * `turn.completed` on the stream before `session.waiting`, and the run row
 * completes with it — so a session sitting on an unanswered approval usually
 * carries no open turn and is no longer asked about. `awaiting-human` still
 * reaches the parks that sit under a turn row that never closed, which is the
 * crashed-mid-approval shape, but a complete answer needs a fleet-wide feed of
 * pending requests and eve exposes only per-session routes. That is the
 * overview's reshape, not this file's. The 25-of-174 sample it replaces was
 * never something to rely on either: at the 700 sessions this is meant to
 * describe it would have been 3%, and "0 waiting on a person" from a 3% sample
 * is the same cry-wolf-in-reverse this module was written to avoid.
 *
 * WHAT COUNTS AS FINISHED IS NOT THIS FILE'S TO DEFINE. lib/monitors.ts is the
 * source of truth for the workflow tables' failure vocabulary, and this file
 * uses its tests verbatim: a turn is finished when `completed_at IS NOT NULL`,
 * never when `status` says so. That distinction is the whole audit — of 1,922
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
  readonly trigger: string | null;
  readonly createdAt: string;
  readonly idleMs: number;
  readonly health: SessionHealth;
  readonly pendingCount: number;
  /** Why it was classified this way, in words a human can act on. */
  readonly reason: string;
}

export interface FleetReport {
  /**
   * One per session the tables could not settle on their own. Sessions with no
   * open turn row are absent rather than listed as idle: they are the bulk of
   * any fleet, they are not news, and including them would mean fetching and
   * shipping every quiet session in the database.
   */
  readonly entries: FleetEntry[];
  readonly checked: number;
  /** Sessions with an open turn row that the probe bound left unasked. */
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

/**
 * A ceiling on round trips, not the size of the sweep.
 *
 * Only sessions with an open turn row are asked about, and a healthy fleet has
 * almost none — 8 of 174 candidates in the seeded database, 0 of 57 in a live
 * one. This bound is what stops a fleet that has genuinely fallen over from
 * turning one banner render into hundreds of requests; `report.unchecked` says
 * when it bit.
 */
const MAX_PROBES = 25;

/**
 * A liveness probe gets a liveness timeout, not `agentFetch`'s 30-second
 * default for fetching data.
 *
 * Measured on 2026-08-06, and it is not the failure anyone expects. A different
 * project's eve agent was listening on the default port, so the probes reached
 * a healthy server that had simply never heard of these sessions — and eve
 * answers an unknown session by opening its durable stream, which is designed
 * not to end. Every probe therefore ran to the full timeout, in parallel, and
 * `/sessions` took **15.2 seconds** to render while every other page took under
 * 320ms. The agent being DOWN is the fast case; the agent being up and unaware
 * of the session is the slow one, and that is the ordinary state of any session
 * older than the agent process.
 *
 * Two seconds is generous for "does this local agent recognise this id". A
 * probe that has not answered by then is not going to change the banner, and
 * the fallback is already "unknown", which is the honest answer.
 */
const PROBE_TIMEOUT_MS = 2_000;

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
 * The classification itself, kept pure so the false-positive shapes are unit
 * tests rather than things we hope about.
 *
 * Only sessions the tables could not settle get here — `inspectFleet`'s query
 * hands over nothing but sessions carrying a turn row that never closed, so
 * "the stream says nothing" already means "and a turn really is open".
 *
 * Decision order is deliberate: the stream's own words first, because
 * `terminal`, a pending request and `waiting` are facts SQL cannot see.
 *
 * `inFlightMs` is the age of the OLDEST turn row this session never closed, or
 * null when every open row was created and never picked up.
 */
export function classifySession(
  snapshot: Pick<SessionSnapshot, "terminal" | "waiting" | "pendingRequests">,
  inFlightMs: number | null,
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

  // Nothing on the stream says waiting, parked or over. Silence alone would
  // equally be a pruned stream, which is why it is never asked about a session
  // whose turns all closed — but this session's turns did not, so the run rows
  // and not the silence are what is being read here.
  //
  // A turn row that never reached a terminal state is healthy for a few
  // seconds and deeply suspicious after an hour: it is the shape of a turn
  // whose process died mid-flight, which eve does not detect or retry.
  //
  // Age comes from the open turn's own start where it has one, not from the
  // session's idle time, so "started 4 hours ago" cannot be softened by a later
  // row touching the session. `started_at` can be null on a run that was
  // created and never picked up; idle time is the honest fallback there.
  const openFor = inFlightMs ?? idleMs;
  return openFor > STUCK_TURN_MS
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

  // Candidates: open sessions that have been quiet a while AND still carry a
  // turn row nobody closed. The join is to turns rather than to the session row
  // because the session row's own timestamps do not move as turns run.
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

           -- How long the oldest still-open turn has been open. Same filter as
           -- the HAVING below, so it is null only when every open row was
           -- created and never picked up and therefore has no started_at; the
           -- classifier falls back to idle time there.
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

      -- AND the tables cannot settle it. This line is what makes the sweep
      -- affordable and complete at once, and it may not grow a backtick: this
      -- is a template literal, and one inside the SQL ends the string with a
      -- parse error nowhere near the cause.
      --
      -- Dropping it does not just cost round trips. Nothing downstream
      -- re-checks the question: a session whose turns all closed would be
      -- probed, its pruned stream would fold to silence, and silence is what a
      -- turn in flight looks like. That is the 166-of-174 false positive.
      --
      -- COUNT, not "in_flight_since IS NOT NULL": a run created and never
      -- picked up has completed_at AND started_at null, so MIN() is null on a
      -- turn that is genuinely open.
      --
      -- The type filter is lib/monitors.ts's unit of work. eve writes an
      -- untagged companion run per session that never completes — 700 of them
      -- in the seeded database, one per session — and a single one counted
      -- here would report the whole fleet as wedged. Today the join drops them
      -- because they carry no $eve.root; this filter is what keeps them
      -- harmless if that ever changes, since they carry no $eve.type either.
      --
      -- completed_at IS NULL is lib/monitors.ts's test for unfinished, and
      -- status is deliberately not consulted. A cancelled turn, a failed turn
      -- and a turn that never reached the provider have all FINISHED;
      -- monitors.ts counts the last two as failures and this file must not
      -- re-count them as work in flight.
      AND COUNT(t.id) FILTER (
            WHERE t.attributes->>'$eve.type' IN ('turn', 'subagent')
              AND t.completed_at IS NULL
          ) > 0
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

      // `in_flight_since` is a Date for the same reason (and null when the open
      // rows have no started_at at all, which is a MIN over rows that carry
      // none rather than missing data).
      const inFlightSince = (raw.in_flight_since as Date | null) ?? null;
      const inFlightMs = inFlightSince === null ? null : Date.now() - inFlightSince.getTime();

      const base = {
        sessionId,
        title,
        trigger: (raw.trigger as string) ?? null,
        createdAt: (raw.created_at as Date).toISOString(),
        idleMs,
      };

      try {
        const snapshot = await getSessionSnapshot(sessionId, {
          timeoutMs: PROBE_TIMEOUT_MS,
          ...(options.signal ? { signal: options.signal } : {}),
        });

        return { ...base, ...classifySession(snapshot, inFlightMs, idleMs) };
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
