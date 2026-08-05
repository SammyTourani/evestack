import { Pool } from "pg";

/**
 * Durable record of what the agent's schedules actually did.
 *
 * eve runs schedules through Nitro's in-process task runner when you self-host.
 * That works — the cron fires and the handler runs — but nothing survives it:
 * no history, no record of a run that threw, no notion of a fire that never
 * happened because the process was down, and no way to pause one schedule
 * without editing code and redeploying. On Vercel this is covered by their Cron
 * Jobs dashboard. Off it, a scheduled agent is the least observable thing you
 * own, which is a bad property for the one part that acts without you.
 *
 * This adds the record and the switch, in the Postgres already running for
 * durable sessions. It does NOT replace eve's runner: the cron still fires
 * through eve, and the handler still belongs to the app. Wrapping rather than
 * replacing keeps schedules working exactly as eve documents them, and keeps us
 * off a surface that would be ours to maintain forever.
 */

let pool: Pool | null = null;

function getPool(): Pool {
  if (pool) return pool;
  const url = process.env.WORKFLOW_POSTGRES_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "[evestack:schedules] needs WORKFLOW_POSTGRES_URL. A schedule history that only lives " +
        "in process memory is gone at the moment you most want it — after the restart that " +
        "lost a run.",
    );
  }
  pool = new Pool({ connectionString: url, max: 4 });
  return pool;
}

let ready: Promise<void> | null = null;

export function ensureSchema(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const db = getPool();
      await db.query("CREATE SCHEMA IF NOT EXISTS evestack");
      await db.query(`
        CREATE TABLE IF NOT EXISTS evestack.schedule_runs (
          id          bigserial   PRIMARY KEY,
          name        text        NOT NULL,
          cron        text,
          -- When the schedule was SUPPOSED to fire. For a live run this is the
          -- tick that triggered it; for a catch-up it is the tick that was
          -- missed, which is why it is distinct from started_at.
          fire_at     timestamptz NOT NULL,
          started_at  timestamptz NOT NULL DEFAULT now(),
          finished_at timestamptz,
          duration_ms integer,
          -- running | completed | failed | skipped
          status      text        NOT NULL DEFAULT 'running',
          error       text,
          -- True when this run was replayed on boot rather than fired live.
          caught_up   boolean     NOT NULL DEFAULT false,
          session_id  text
        )
      `);
      await db.query(
        `CREATE INDEX IF NOT EXISTS schedule_runs_name_idx
           ON evestack.schedule_runs (name, fire_at DESC)`,
      );
      // One row per (name, fire_at) is what makes catch-up idempotent: two
      // processes racing to replay the same missed tick cannot both win, and a
      // live fire already recorded is never duplicated by a later catch-up.
      await db.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS schedule_runs_tick_idx
           ON evestack.schedule_runs (name, fire_at)`,
      );
      await db.query(`
        CREATE TABLE IF NOT EXISTS evestack.schedule_state (
          name        text        PRIMARY KEY,
          paused      boolean     NOT NULL DEFAULT false,
          paused_at   timestamptz,
          paused_by   text,
          updated_at  timestamptz NOT NULL DEFAULT now()
        )
      `);
    })().catch((error: unknown) => {
      // Never cache a failed bootstrap: a database that was briefly unreachable
      // would otherwise stay "broken" for the life of the process.
      ready = null;
      throw error;
    });
  }
  return ready;
}

export interface ScheduleRunRow {
  id: string;
  name: string;
  cron: string | null;
  fireAt: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  status: string;
  error: string | null;
  caughtUp: boolean;
  sessionId: string | null;
}

/**
 * Claim a tick. Returns null when this (name, fire_at) is already recorded,
 * which is how a catch-up refuses to replay something that already ran.
 */
export async function claimRun(input: {
  name: string;
  cron?: string | undefined;
  fireAt: Date;
  caughtUp?: boolean;
}): Promise<string | null> {
  await ensureSchema();
  const rows = await getPool().query<{ id: string }>(
    `INSERT INTO evestack.schedule_runs (name, cron, fire_at, caught_up)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (name, fire_at) DO NOTHING
     RETURNING id`,
    [input.name, input.cron ?? null, input.fireAt, input.caughtUp ?? false],
  );
  return rows.rows[0]?.id ?? null;
}

export async function finishRun(
  id: string,
  outcome: { status: "completed" | "failed" | "skipped"; error?: string; sessionId?: string },
): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `UPDATE evestack.schedule_runs
     SET status = $2,
         error = $3,
         session_id = COALESCE($4, session_id),
         finished_at = now(),
         duration_ms = EXTRACT(MILLISECONDS FROM (now() - started_at))::int
                     + EXTRACT(SECONDS FROM (now() - started_at))::int * 1000
     WHERE id = $1`,
    [id, outcome.status, outcome.error ?? null, outcome.sessionId ?? null],
  );
}

export async function isPaused(name: string): Promise<boolean> {
  await ensureSchema();
  const rows = await getPool().query<{ paused: boolean }>(
    `SELECT paused FROM evestack.schedule_state WHERE name = $1`,
    [name],
  );
  return rows.rows[0]?.paused === true;
}

export async function setPaused(name: string, paused: boolean, by?: string): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO evestack.schedule_state (name, paused, paused_at, paused_by, updated_at)
     VALUES ($1, $2, CASE WHEN $2 THEN now() END, $3, now())
     ON CONFLICT (name) DO UPDATE
       SET paused = EXCLUDED.paused,
           paused_at = CASE WHEN EXCLUDED.paused THEN now() END,
           paused_by = EXCLUDED.paused_by,
           updated_at = now()`,
    [name, paused, by ?? null],
  );
}

/** The most recent tick recorded for a schedule — the anchor for catch-up. */
export async function lastFireAt(name: string): Promise<Date | null> {
  await ensureSchema();
  const rows = await getPool().query<{ fire_at: Date }>(
    `SELECT fire_at FROM evestack.schedule_runs WHERE name = $1 ORDER BY fire_at DESC LIMIT 1`,
    [name],
  );
  return rows.rows[0]?.fire_at ?? null;
}

export async function closePool(): Promise<void> {
  if (pool) {
    const closing = pool;
    pool = null;
    ready = null;
    await closing.end();
  }
}
