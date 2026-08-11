import { StreamTruncatedError, type SessionSnapshot, getSessionSnapshot } from "./agent-client";
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
  /**
   * Nothing can be said about this session. Two causes, and the `reason` on the
   * entry separates them because they send a reader to different places: the
   * agent could not be reached at all, or it answered and its event stream
   * stopped before the session's state could be read. Reporting the second as
   * the first sent operators to check a healthy network — see the catch in
   * inspectFleet.
   */
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

  /**
   * Sessions carrying an open turn that the idle gate skipped, because they
   * moved too recently to be worth a round trip.
   *
   * THIS FIELD EXISTS BECAUSE `checked: 0` HAD TWO MEANINGS AND NO WAY TO TELL
   * THEM APART. "No session has a turn open, so nothing here could be wedged"
   * and "a turn is open and this sweep has not looked at it yet" both came back
   * as `{"wedged":0,...,"checked":0,"unchecked":0}`, and they are opposite
   * answers. Someone who had just killed an agent mid-turn read the first from
   * a sweep that meant the second; the report they filed says `checked: 0` with
   * `unknown: 0` "reads as 'I checked and found nothing', not 'I have not
   * checked'".
   *
   * `unknown` could never have carried this. It means the agent WAS asked and
   * could not answer. A session that was never asked is a different fact, and
   * folding the two turns "we have not looked yet" into an agent fault.
   */
  readonly tooRecent: number;

  /**
   * The quiet gate this sweep actually applied, in milliseconds, as Postgres
   * read it — rounded and clamped by `intervalMilliseconds`, not as asked for.
   *
   * A zero is only interpretable next to the threshold that produced it, and
   * `?idleMinutes=` moves it, so a caller reading a bare `checked: 0` otherwise
   * cannot tell whether the sweep looked back thirty minutes or thirty days.
   */
  readonly idleThresholdMs: number;

  /**
   * How long an open turn must have been running before it is called wedged.
   *
   * The second gate, and the one that surprises people: a session can be past
   * the quiet gate, probed, and still reported as no news at all, because its
   * turn has not been open long enough to be a fault. Reporting the number is
   * what makes "looked, said nothing" readable as "not yet, and here is when".
   */
  readonly wedgeAfterMs: number;

  /**
   * Every session in the database, candidate or not. The denominator.
   *
   * `checked`, `unchecked` and `tooRecent` all count sessions the sweep
   * CONSIDERED — ones carrying an open turn. Sessions whose turns have all
   * closed are never candidates at any threshold, so they appear in none of
   * those three, and until this field existed they appeared nowhere at all.
   *
   * That is the last place the endpoint could still say nothing and sound like
   * it had said something. `{"checked":0,"unchecked":0,"tooRecent":0}` is the
   * honest answer both for a database with no sessions in it and for one with
   * four thousand, all finished — and a monitor cannot tell those apart from
   * findings alone, because findings are what a sweep produces, never what it
   * was given. `sessions - (checked + unchecked + tooRecent)` is the count that
   * needed no round trip, which is the whole reason it is cheap to report.
   *
   * /api/health/detail already publishes this number, so it is one the product
   * has rather than one it had to invent.
   */
  readonly sessions: number;
}

/**
 * How long a session may sit still before it is worth probing.
 *
 * Deliberately generous. eve keeps a session's run open until it times out, so
 * an idle conversation is the normal steady state, not a fault — a dashboard
 * that flags every quiet session teaches its reader to ignore it.
 */
const IDLE_BEFORE_SUSPECT_MS = 30 * 60 * 1000;

/** The largest threshold worth asking about, and the bound /api/fleet enforces. */
const MAX_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The idle threshold as Postgres will actually read it.
 *
 * `($1 || ' milliseconds')::interval` in the sweep is a TEXT cast, so whatever
 * String() makes of this number has to be valid interval input — and it is not
 * always. JavaScript switches to exponent notation under 1e-6, so
 * `?idleMinutes=1e-11`, which passes the route's `Number.isFinite && 0 <= x <=
 * 43200` check untouched, arrived as "6e-7 milliseconds" and came back to the
 * caller as a 500 carrying the failing SQL: a syntax error shown to an operator
 * for a well-formed request. 1e21 and above does the same at the other end.
 *
 * A whole number of milliseconds inside the range the route allows has no
 * exponent form, so rounding and clamping is the entire fix. A threshold under
 * half a millisecond rounds to 0, which is what "idle for ~0 minutes" asked for;
 * a value that is not a number at all falls back to the module's own default
 * rather than inventing one.
 */
export function intervalMilliseconds(value: number): string {
  if (!Number.isFinite(value)) return String(IDLE_BEFORE_SUSPECT_MS);
  return String(Math.min(Math.max(Math.round(value), 0), MAX_IDLE_MS));
}

/**
 * How many candidates existed that the sweep did not probe.
 *
 * `COUNT(*) OVER ()` is evaluated before ORDER BY and LIMIT, so it is the total
 * number of candidates rather than the number returned, at no extra pass. This
 * replaced fetching `limit + 1` rows and reporting `rows.length - limit`, which
 * was 0 or 1 and could not arithmetically be anything else — while FleetReport
 * documents the field as "candidates that existed but were not probed", which
 * for 174 candidates at a limit of 25 is 149. A cap that reports 1 reads as
 * "one more, no rush".
 *
 * Postgres hands a bigint count to pg as a STRING, hence the coercion rather
 * than a cast, and a fallback rather than a NaN in a field a banner prints. A
 * caller asking for zero probes gets zero of both, since the count rides on rows
 * that a LIMIT 0 does not return.
 */
export function uncheckedCandidates(rows: ReadonlyArray<Record<string, unknown>>): number {
  const probed = rows.length;
  if (probed === 0) return 0;
  const total = Number(rows[0]?.candidate_count);
  if (!Number.isFinite(total)) return 0;
  return Math.max(0, total - probed);
}

/**
 * How many open-turn sessions the idle gate skipped.
 *
 * Reads off ANY row the sweep returned, probed or not: `count(*) FILTER (WHERE
 * NOT quiet) OVER ()` is evaluated before ORDER BY and LIMIT, so a row that
 * made the probe budget carries the same total as one that did not. That is
 * the point — the number has to survive a sweep whose entire result was
 * skipped rows, which is the shape of the case it was added for.
 *
 * No rows at all means no session in the database has a turn open, and zero is
 * then the true answer rather than a fallback. Same bigint-arrives-as-a-string
 * coercion as `uncheckedCandidates`, and the same refusal to let a NaN reach a
 * field the banner prints.
 */
export function tooRecentCandidates(rows: ReadonlyArray<Record<string, unknown>>): number {
  if (rows.length === 0) return 0;
  const total = Number(rows[0]?.too_recent_count);
  if (!Number.isFinite(total)) return 0;
  return Math.max(0, total);
}

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

  // Candidates: open sessions that still carry a turn row nobody closed. The
  // join is to turns rather than to the session row because the session row's
  // own timestamps do not move as turns run.
  //
  // THE IDLE GATE IS NOW A COLUMN RATHER THAN A SECOND TERM IN `HAVING`, and
  // that is the whole of this rewrite. Filtering on it did not merely leave a
  // recently-active session unprobed, it ERASED it: the sweep could not count
  // what it had discarded, so a fleet with a turn open five minutes ago
  // returned `checked: 0` — byte for byte the answer it returns when no
  // session has a turn open at all and there is nothing that could be wedged.
  // Scoring the gate instead of filtering on it costs nothing (the rows are
  // grouped either way) and is the only reason `tooRecent` can be reported.
  //
  // THE PROBE BUDGET IS UNCHANGED. `ORDER BY quiet DESC` spends `LIMIT` on the
  // sessions that are actually going to be asked about, so the skipped rows
  // ride back only in whatever budget the quiet ones did not use, and their
  // count comes from a window function that does not care about LIMIT at all.
  // Nothing here probes a session the old query would not have probed.
  const rows = await query<Record<string, unknown>>(
    `
    WITH open_sessions AS (
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
             ) AS in_flight_since
      FROM workflow.workflow_runs s
      LEFT JOIN workflow.workflow_runs t
        ON t.attributes->>'$eve.root' = s.id
      WHERE s.attributes->>'$eve.type' = 'session'
        AND s.status = 'running'
      GROUP BY s.id, s.attributes, s.created_at, s.updated_at

      -- The tables cannot settle it. This line is what makes the sweep
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
      HAVING COUNT(t.id) FILTER (
               WHERE t.attributes->>'$eve.type' IN ('turn', 'subagent')
                 AND t.completed_at IS NULL
             ) > 0
    ),
    scored AS (
      -- Both sides of the cut are naive UTC. These columns are timestamp
      -- WITHOUT time zone; comparing one to a bare now() makes Postgres read it
      -- in the server's zone, which shifts the idle window by the offset. The
      -- CLI port of this file hit it for real: a session quiet for three hours
      -- looked five hours in the future and the sweep returned nothing.
      SELECT open_sessions.*,
             last_activity < (now() AT TIME ZONE 'utc') - ($1 || ' milliseconds')::interval AS quiet
      FROM open_sessions
    )
    -- Window functions run after the CTEs and before ORDER BY and LIMIT, so
    -- both counts describe every open-turn session rather than the page. That
    -- is what lets a sweep whose whole result was skipped rows still report how
    -- many it skipped, and it is why fetching limit + 1 rows to detect the
    -- overflow was replaced: that could only ever say "1 more" while 149 were.
    SELECT session_id, title, trigger, created_at, last_activity, in_flight_since, quiet,
           COUNT(*) FILTER (WHERE quiet)     OVER () AS candidate_count,
           COUNT(*) FILTER (WHERE NOT quiet) OVER () AS too_recent_count
    FROM scored
    ORDER BY quiet DESC, last_activity ASC
    LIMIT $2
    `,
    [intervalMilliseconds(idleThreshold), limit],
  );

  // Rows the idle gate skipped came back only to be counted. Probing them is
  // the one thing this must not do: they are the sessions a live conversation
  // produces, and asking the agent about a turn that started nine seconds ago
  // spends a round trip to be told what the run rows already said.
  const quiet = rows.filter((raw) => raw.quiet === true);
  const tooRecent = tooRecentCandidates(rows);

  // Every quiet row read is probed; the ones over the bound were never fetched.
  const unchecked = uncheckedCandidates(quiet);

  const entries = await Promise.all(
    quiet.map(async (raw): Promise<FleetEntry> => {
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
        /*
         * `unknown` either way — nothing here can be classified — but NOT the
         * same sentence, because they send the reader to different places.
         *
         * A StreamTruncatedError means the agent answered: its response headers
         * arrived and were parsed, and then the body ended before a single event
         * could be read. Reporting that as "the agent could not be reached"
         * pointed operators at a healthy network. Caught in CI, where the fleet
         * sweep blamed an agent the same job had just talked to twice.
         */
        return {
          ...base,
          health: "unknown",
          pendingCount: 0,
          reason:
            error instanceof StreamTruncatedError
              ? `the agent answered but its stream stopped before this session's state could be read (${error.message})`
              : `the agent could not be reached (${error instanceof Error ? error.message : String(error)})`,
        };
      }
    }),
  );

  // The denominator, and deliberately a separate statement rather than a column
  // on the candidate query: that query's WHERE already excludes every settled
  // session, so it cannot count what it filtered out.
  //
  // WHAT IT COSTS, measured on PostgreSQL 17.10 with query-indexes.sql applied,
  // because an earlier version of this comment guessed and was wrong in three
  // ways at once. It claimed "one index-only count over a column already
  // indexed". It is not index-only — the planner chose a Bitmap Heap Scan at
  // 10k sessions and a Seq Scan at 100k, and even with both disabled and the
  // visibility map fully set it is a heap-touching Index Scan, because the
  // predicate reads a jsonb attribute rather than a column. At 100k sessions it
  // is 18.25 ms, about 42% of the endpoint's total 43 ms.
  //
  // Kept anyway, and the tradeoff stated rather than hidden: this is the number
  // that makes the other four legible, the endpoint is polled by a monitor
  // rather than rendered per keystroke, and 18 ms at a hundred thousand sessions
  // is a price worth paying to stop a zero reading as an all-clear. If it ever
  // stops being worth it, the fix is a partial index on the attribute, not
  // dropping the field.
  const [population] = await query<{ n: string | number }>(
    `select count(*)::int as n
       from workflow.workflow_runs
      where attributes->>'$eve.type' = 'session'`,
  );

  return {
    entries,
    checked: entries.length,
    unchecked,
    tooRecent,
    sessions: Number(population?.n ?? 0),
    // What Postgres was handed, not what the caller asked for: intervalMilliseconds
    // rounds and clamps, and a report that quotes the request rather than the cut
    // would describe a sweep that did not happen.
    idleThresholdMs: Number(intervalMilliseconds(idleThreshold)),
    wedgeAfterMs: STUCK_TURN_MS,
  };
}

/**
 * The counts a banner needs, without rendering the whole report.
 *
 * `active` IS HERE BECAUSE IT WAS THE ONE HEALTH VALUE THIS DID NOT REPORT,
 * and its absence was silent rather than harmless: `wedged + idle +
 * awaitingHuman + unknown` was allowed to come out LESS than `checked`, with
 * nothing in the payload to say where the difference went. Measured against a
 * fixture holding one session killed 21 minutes earlier — `checked: 2`, and
 * the four counters summing to 1. A reader reconciling the two sees a sweep
 * that examined two sessions and reported on one, which is the same
 * "reported calm while blind" shape as `checked: 0`, one field along.
 *
 * The shortfall was exactly the sessions in the window that matters most: past
 * the quiet gate, so they were probed, and under `STUCK_TURN_MS`, so they were
 * not yet a fault. All five values now sum to `checked`, and test/fleet.test.mjs
 * asserts that rather than trusting it.
 */
export function summarize(report: FleetReport): {
  wedged: number;
  idle: number;
  awaitingHuman: number;
  unknown: number;
  active: number;
} {
  return {
    wedged: report.entries.filter((e) => e.health === "wedged").length,
    idle: report.entries.filter((e) => e.health === "idle").length,
    awaitingHuman: report.entries.filter((e) => e.health === "awaiting-human").length,
    unknown: report.entries.filter((e) => e.health === "unknown").length,
    active: report.entries.filter((e) => e.health === "active").length,
  };
}

/**
 * Whether the banner has anything to say, and in which register.
 *
 * Split out of app/fleet-banner.tsx because that file cannot be rendered by a
 * test: `test/ui-render.mjs` handles neither the `@/` alias nor a CSS module,
 * and teaching it both means editing a harness other work is editing too —
 * app/memory/truncation.ts exists for the same reason and set the precedent.
 * The component is left with markup and nothing to decide.
 *
 * `silent` is the answer this exists to get right. It used to be returned for
 * everything except a wedge, a park or an unreachable agent — so an open turn
 * the sweep skipped, an open turn it probed and found too young to call a
 * fault, and a candidate it ran out of budget for all rendered as an empty
 * page. Two of those are the first hour after a crash, and the third could not
 * render at all: the `unchecked` line sat behind the early return, reachable
 * only once something else had already gone wrong.
 *
 * `coverage` is NOT a severity and must not be treated as one. It fires while a
 * turn is legitimately in flight, which is the normal state of a busy agent —
 * that is why it is a separate register rather than a third alarm, and why the
 * one thing it is allowed to say is what has not been settled.
 */
export function bannerState(report: FleetReport): {
  counts: ReturnType<typeof summarize>;
  /** Open turns this sweep settled neither as healthy nor as broken. */
  unjudged: number;
  register: "fault" | "todo" | "coverage" | "silent";
} {
  const counts = summarize(report);

  // Two populations, one number, because a reader does not care which side of
  // the quiet gate a turn fell on — only that nothing has judged it.
  //
  //   active     probed; its turn has not been open long enough to be a fault.
  //              The 30-to-60-minute window after a crash.
  //   tooRecent  moved too recently to be worth a round trip, so never probed.
  //              The first half hour after a crash, and every turn running now.
  const unjudged = counts.active + report.tooRecent;

  const register =
    counts.wedged > 0
      ? "fault"
      : counts.awaitingHuman > 0 || counts.unknown > 0
        ? "todo"
        : unjudged > 0 || report.unchecked > 0
          ? "coverage"
          : "silent";

  return { counts, unjudged, register };
}
