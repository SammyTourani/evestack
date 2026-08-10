import { query } from "./db";

/**
 * Read side for `@evestack/schedules`.
 *
 * The tables are created by the package running inside the agent, not here, so
 * this module only ever reads and toggles — and it has to survive the tables
 * not existing at all, which is the normal state for an agent that has never
 * defined a schedule.
 *
 * Why this page exists: self-hosted, eve's schedules run through Nitro's
 * in-process task runner. The cron fires and the handler runs, and that is the
 * whole of it — no history, no record of one that threw, no way to pause a
 * single schedule without editing code and redeploying. On Vercel the Cron Jobs
 * dashboard covers this. Off it, the part of your agent that acts without you
 * watching is the part you can see least.
 */

export interface ScheduleRun {
  readonly id: string;
  readonly name: string;
  readonly cron: string | null;
  readonly fireAt: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly status: string;
  readonly error: string | null;
  readonly caughtUp: boolean;
  readonly sessionId: string | null;
}

export interface ScheduleSummary {
  readonly name: string;
  readonly cron: string | null;
  readonly paused: boolean;
  readonly pausedAt: string | null;
  readonly pausedBy: string | null;
  readonly lastRun: ScheduleRun | null;
  readonly totalRuns: number;
  readonly failures: number;
  /** Consecutive failures ending at the most recent run — the alarm worth ringing. */
  readonly failingStreak: number;
  /**
   * Runs among the newest `STREAK_DEPTH` that never recorded an outcome.
   *
   * `@evestack/schedules` inserts a run with `status` defaulting to `'running'`
   * and only `finishRun` moves it to completed / failed / skipped, so a worker
   * that died mid-run leaves the row at `'running'` FOREVER. That value is not
   * a success and it is not a failure; it is a fire nobody knows the result of.
   *
   * It is reported rather than folded into either count because the streak used
   * to be broken by it: `MIN(depth) FILTER (WHERE status <> 'failed')` matched a
   * `'running'` row at depth 1, so a crashed worker sitting on top of twenty
   * failures produced `failingStreak = 0` and the alert said "No schedule has a
   * failing streak." That is the same shape as an unfinished turn scoring as a
   * successful one — the unresolved input took the good branch.
   */
  readonly unresolved: number;
}

export interface SchedulesView {
  readonly schedules: ScheduleSummary[];
  readonly recent: ScheduleRun[];
  /** False when the agent has never run a tracked schedule. */
  readonly tableExists: boolean;
}

/**
 * How far back a failing streak is counted.
 *
 * A streak is by definition a PREFIX of the newest runs, so ranking the whole
 * table to read the first few of it is work nobody asked for: a one-minute cron
 * writes about 525,000 rows a year and every one of them was being sorted on
 * every page load. Past this depth the page's own rendering has long since said
 * everything it can say — it prints "N consecutive failures", which is already an
 * alarm at 3 — so the depth is where counting stops rather than where accuracy
 * does.
 */
const STREAK_DEPTH = 200;

async function tablesExist(): Promise<boolean> {
  const rows = await query<{ exists: boolean }>(
    `SELECT to_regclass('evestack.schedule_runs') IS NOT NULL AS exists`,
  );
  return rows[0]?.exists === true;
}

function toRun(raw: Record<string, unknown>): ScheduleRun {
  return {
    id: String(raw.id),
    name: String(raw.name),
    cron: (raw.cron as string) ?? null,
    fireAt: new Date(raw.fire_at as string | Date).toISOString(),
    startedAt: new Date(raw.started_at as string | Date).toISOString(),
    finishedAt: raw.finished_at ? new Date(raw.finished_at as string | Date).toISOString() : null,
    durationMs: raw.duration_ms === null ? null : Number(raw.duration_ms),
    status: String(raw.status),
    error: (raw.error as string) ?? null,
    caughtUp: raw.caught_up === true,
    sessionId: (raw.session_id as string) ?? null,
  };
}

export async function getSchedules(): Promise<SchedulesView> {
  if (!(await tablesExist())) return { schedules: [], recent: [], tableExists: false };

  const summaries = await query<Record<string, unknown>>(`
    WITH latest AS (
      SELECT DISTINCT ON (name) *
      FROM evestack.schedule_runs
      ORDER BY name, fire_at DESC
    ),
    -- A run's position counting back from the newest, so a streak is a prefix
    -- rather than something the UI has to reconstruct from a list.
    --
    -- The newest STREAK_DEPTH per schedule, not every row: this was a
    -- row_number() over the whole of schedule_runs, which sorts the entire
    -- history of every schedule to read the top of each one. A per-schedule LIMIT
    -- walks the (name, fire_at DESC) index @evestack/schedules creates, and every
    -- name in the latest CTE still produces at least its own newest row here, so
    -- the joins below stay inner joins and no schedule can drop off the page.
    -- (No backticks in this SQL: it is a template literal, and one inside it ends
    -- the string with a parse error nowhere near the cause.)
    ranked AS (
      SELECT l.name, streak.status, streak.depth
      FROM latest l
      CROSS JOIN LATERAL (
        SELECT status, row_number() OVER (ORDER BY fire_at DESC) AS depth
        FROM (
          SELECT status, fire_at
          FROM evestack.schedule_runs
          WHERE name = l.name
          ORDER BY fire_at DESC
          LIMIT ${STREAK_DEPTH}
        ) newest
      ) streak
    ),
    -- An unresolved run is TRANSPARENT to the streak, not a break in it.
    --
    -- (No backticks anywhere in this SQL: it is a template literal, and one
    -- inside it ends the string with a parse error nowhere near the cause. The
    -- warning twenty lines up was written because someone did it; this comment
    -- exists because the person adding it did it again.)
    --
    -- status defaults to 'running' and only finishRun advances it, so a run
    -- still in flight — or one whose worker died and never will finish — sits
    -- at 'running' with no outcome. status <> 'failed' was true for it, so it
    -- ended the streak at depth 1 and failing came out 0 even when every run
    -- beneath it had failed. Ranking over the RESOLVED rows only means the
    -- streak is the prefix of runs that actually reported an outcome, and the
    -- unresolved ones are counted separately below instead of silently
    -- clearing the alarm.
    resolved AS (
      SELECT name, status,
             row_number() OVER (PARTITION BY name ORDER BY depth) AS rank
      FROM ranked
      WHERE status IN ('completed', 'failed', 'skipped')
    ),
    streaks AS (
      SELECT name,
             COALESCE(MIN(rank) FILTER (WHERE status <> 'failed'), MAX(rank) + 1) - 1 AS failing
      FROM resolved GROUP BY name
    ),
    -- Counted over ranked, so a schedule whose newest runs are ALL unresolved
    -- still appears here even though it contributes no row to streaks.
    unresolved AS (
      SELECT name,
             count(*) FILTER (WHERE status NOT IN ('completed', 'failed', 'skipped')) AS n
      FROM ranked GROUP BY name
    ),
    -- All-time on purpose. The page renders these as "N runs, M failed" beneath a
    -- subtitle that says "Every cron fire the agent has recorded", so a window
    -- here would change what the page CLAIMS and not just how much it reads —
    -- which is a product call about the label as much as the query, and is left
    -- to be made rather than guessed at.
    totals AS (
      SELECT name, count(*) AS total, count(*) FILTER (WHERE status = 'failed') AS failures
      FROM evestack.schedule_runs GROUP BY name
    )
    -- LEFT JOIN on streaks, not JOIN: a schedule whose newest runs are every
    -- one of them unresolved has no row in resolved and would otherwise drop
    -- off the page entirely — a schedule disappearing is the loudest possible
    -- version of this same bug.
    SELECT l.*, t.total, t.failures, COALESCE(s.failing, 0) AS failing,
           COALESCE(u.n, 0) AS unresolved,
           st.paused, st.paused_at, st.paused_by
    FROM latest l
    JOIN totals t ON t.name = l.name
    LEFT JOIN streaks s ON s.name = l.name
    LEFT JOIN unresolved u ON u.name = l.name
    LEFT JOIN evestack.schedule_state st ON st.name = l.name
    ORDER BY l.fire_at DESC
  `);

  const recent = await query<Record<string, unknown>>(
    `SELECT * FROM evestack.schedule_runs ORDER BY fire_at DESC, id DESC LIMIT 100`,
  );

  return {
    tableExists: true,
    schedules: summaries.map((raw) => ({
      name: String(raw.name),
      cron: (raw.cron as string) ?? null,
      paused: raw.paused === true,
      pausedAt: raw.paused_at ? new Date(raw.paused_at as string | Date).toISOString() : null,
      pausedBy: (raw.paused_by as string) ?? null,
      lastRun: toRun(raw),
      totalRuns: Number(raw.total ?? 0),
      failures: Number(raw.failures ?? 0),
      failingStreak: Number(raw.failing ?? 0),
      unresolved: Number(raw.unresolved ?? 0),
    })),
    recent: recent.map(toRun),
  };
}

/**
 * Thrown when a caller names a schedule this agent has never run.
 *
 * Its own type rather than a message the route greps: the route has to answer 404
 * for this and 500 for a database that fell over, and those two must not be told
 * apart by string matching.
 */
export class UnknownScheduleError extends Error {
  readonly known: readonly string[];

  constructor(name: string, known: readonly string[]) {
    super(
      known.length === 0
        ? `No tracked schedules yet, so there is nothing called '${name}' to pause.`
        : `No schedule called '${name}'. Tracked schedules: ${known.join(", ")}.`,
    );
    this.name = "UnknownScheduleError";
    this.known = known;
  }
}

/**
 * The schedules this agent has actually run.
 *
 * Same definition of "exists" the page uses: getSchedules() builds its list from
 * schedule_runs, so a schedule that has never fired is not on the page and is not
 * pausable here either — the error above is the one that fits that case.
 */
async function trackedNames(): Promise<string[]> {
  const rows = await query<{ name: string }>(
    `SELECT DISTINCT name FROM evestack.schedule_runs ORDER BY name`,
  );
  return rows.map((row) => String(row.name));
}

export async function setPaused(name: string, paused: boolean, by: string | null): Promise<void> {
  // The agent's package owns this table's creation. If it does not exist the
  // agent has never run a tracked schedule, and there is nothing to pause.
  if (!(await tablesExist())) {
    throw new Error(
      "No tracked schedules yet. Wrap a schedule with `tracked()` from @evestack/schedules and " +
        "let it fire once.",
    );
  }
  // WHY THIS EXISTS. The only precondition used to be that the TABLE existed:
  // this function INSERTed a schedule_state row for whatever string arrived, and
  // because getSchedules() LEFT JOINs state onto rows from schedule_runs, that
  // orphan row is invisible on the page. So pausing `daily-report` when the
  // schedule is `daily_report` answered 200 {"ok":true,"paused":true} while the
  // schedule went on firing — a control plane confirming a control it never
  // applied, at the one moment somebody needs the confirmation to be true.
  const known = await trackedNames();
  if (!known.includes(name)) throw new UnknownScheduleError(name, known);
  await query(
    `INSERT INTO evestack.schedule_state (name, paused, paused_at, paused_by, updated_at)
     VALUES ($1, $2, CASE WHEN $2 THEN now() END, $3, now())
     ON CONFLICT (name) DO UPDATE
       SET paused = EXCLUDED.paused,
           paused_at = CASE WHEN EXCLUDED.paused THEN now() END,
           paused_by = EXCLUDED.paused_by,
           updated_at = now()`,
    [name, paused, by],
  );
}
