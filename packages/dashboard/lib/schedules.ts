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
}

export interface SchedulesView {
  readonly schedules: ScheduleSummary[];
  readonly recent: ScheduleRun[];
  /** False when the agent has never run a tracked schedule. */
  readonly tableExists: boolean;
}

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
    ranked AS (
      SELECT name, status,
             row_number() OVER (PARTITION BY name ORDER BY fire_at DESC) AS depth
      FROM evestack.schedule_runs
    ),
    streaks AS (
      SELECT name,
             COALESCE(MIN(depth) FILTER (WHERE status <> 'failed'), MAX(depth) + 1) - 1 AS failing
      FROM ranked GROUP BY name
    ),
    totals AS (
      SELECT name, count(*) AS total, count(*) FILTER (WHERE status = 'failed') AS failures
      FROM evestack.schedule_runs GROUP BY name
    )
    SELECT l.*, t.total, t.failures, s.failing,
           st.paused, st.paused_at, st.paused_by
    FROM latest l
    JOIN totals t ON t.name = l.name
    JOIN streaks s ON s.name = l.name
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
    })),
    recent: recent.map(toRun),
  };
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
