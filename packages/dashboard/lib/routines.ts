import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PoolClient } from "pg";
import { getPool } from "./db";
import {
  notificationTargetConfigured,
  queueRoutineNotification,
  routineNotificationHistory,
} from "./routine-notifications";
import type { ApproverIdentity } from "./approvals";
import {
  nextRoutineFires,
  previousRoutineFire,
  validateRoutineSchedule,
} from "./routine-cron";

export interface Routine {
  id: string;
  name: string;
  prompt: string;
  cron: string;
  time_zone: string;
  enabled: boolean;
  archived: boolean;
  revision: number;
  next_due: Date;
  created_at: Date;
  updated_at: Date;
}
export interface RoutineRun {
  id: string;
  routine_id: string;
  revision: number;
  scheduled_at: Date;
  trigger: "clock" | "manual" | "catchup";
  state:
    | "claimed"
    | "dispatching"
    | "running"
    | "awaiting_approval"
    | "completed"
    | "failed"
    | "unknown"
    | "skipped"
    | "resolved";
  snapshot: {
    name: string;
    prompt: string;
    cron: string;
    timeZone: string;
    catchupFrom?: string;
  };
  session_id: string | null;
  error: string | null;
  skipped_count: number | null;
  created_at: Date;
  updated_at: Date;
}
export class RoutineError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}
const ACTIVE =
  "('claimed','dispatching','running','awaiting_approval','unknown')";

export async function routineTransaction<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

let ready: Promise<void> | null = null;
export function ensureRoutines(): Promise<void> {
  if (!ready)
    ready = routineTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(7141501)");
      await client.query("CREATE SCHEMA IF NOT EXISTS evestack");
      await client.query(
        "CREATE TABLE IF NOT EXISTS evestack.routine_schema (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), version integer NOT NULL)",
      );
      const version = (
        await client.query(
          "SELECT version FROM evestack.routine_schema WHERE singleton",
        )
      ).rows[0]?.version;
      if (version !== undefined && version !== 1)
        throw new Error(
          "Routine schema is newer than this dashboard; use a compatible image.",
        );
      let sql: string | undefined;
      let dir = process.cwd();
      for (let up = 0; up < 5; up++) {
        try {
          sql = readFileSync(join(dir, "sql/routines.sql"), "utf8");
          break;
        } catch {
          dir = dirname(dir);
        }
      }
      if (!sql)
        throw new Error(
          "Missing sql/routines.sql in the dashboard installation.",
        );
      await client.query(sql);
      await client.query(
        "INSERT INTO evestack.routine_schema(singleton,version) VALUES(true,1) ON CONFLICT DO NOTHING",
      );
    }).catch((error) => {
      ready = null;
      throw error;
    });
  return ready;
}

export function readRoutineInput(body: Record<string, unknown>) {
  const string = (field: string, max: number) => {
    const value = body[field];
    if (typeof value !== "string" || !value.trim() || value.length > max)
      throw new RoutineError(`${field} must contain 1–${max} characters.`);
    return value.trim();
  };
  const input = {
    name: string("name", 120),
    prompt: string("prompt", 20000),
    cron: string("cron", 120),
    timeZone: string("timeZone", 100),
  };
  try {
    validateRoutineSchedule(input.cron, input.timeZone);
  } catch (error) {
    throw new RoutineError(
      error instanceof Error ? error.message : "Invalid schedule.",
    );
  }
  if (!nextRoutineFires(input.cron, input.timeZone, new Date(), 1).length)
    throw new RoutineError(
      "No occurrence within eight years. Check the calendar fields.",
    );
  return input;
}

async function audit(
  client: PoolClient,
  routine: Routine,
  action: string,
  identity: ApproverIdentity,
) {
  await client.query(
    "INSERT INTO evestack.routine_audit(routine_id,revision,action,actor,actor_via,snapshot) VALUES($1,$2,$3,$4,$5,$6)",
    [
      routine.id,
      routine.revision,
      action,
      identity.approver,
      identity.via,
      JSON.stringify(routine),
    ],
  );
}

export async function saveRoutine(
  body: Record<string, unknown>,
  identity: ApproverIdentity,
  id?: string,
) {
  const input = readRoutineInput(body);
  if (body.enabled !== undefined && typeof body.enabled !== "boolean")
    throw new RoutineError("enabled must be true or false.");
  if (body.archived !== undefined && typeof body.archived !== "boolean")
    throw new RoutineError("archived must be true or false.");
  await ensureRoutines();
  return routineTransaction(async (client) => {
    let previous: Routine | undefined;
    if (id) {
      previous = (
        await client.query<Routine>(
          "SELECT * FROM evestack.routines WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!previous) throw new RoutineError("Routine not found.", 404);
      if (body.revision !== previous.revision)
        throw new RoutineError(
          "This routine changed in another window. Refresh before saving.",
          409,
        );
    }
    const enabled = body.enabled === true && body.archived !== true;
    if (enabled) {
      const tested = id
        ? (
            await client.query(
              "SELECT id FROM evestack.routine_runs WHERE routine_id=$1 AND trigger='manual' AND state='completed' AND snapshot->>'prompt'=$2 LIMIT 1",
              [id, input.prompt],
            )
          ).rows.length > 0
        : false;
      if (!tested)
        throw new RoutineError(
          "Run this prompt once and inspect its completed result before enabling its schedule.",
          409,
        );
      if (body.resultReviewed !== true)
        throw new RoutineError(
          "Confirm you inspected the test result and its account permissions before enabling.",
          409,
        );
    }
    const next = nextRoutineFires(input.cron, input.timeZone, new Date(), 1)[0];
    const values = [
      input.name,
      input.prompt,
      input.cron,
      input.timeZone,
      enabled,
      body.archived === true,
      next,
    ];
    const routine = id
      ? (
          await client.query<Routine>(
            "UPDATE evestack.routines SET name=$1,prompt=$2,cron=$3,time_zone=$4,enabled=$5,archived=$6,next_due=$7,revision=revision+1,updated_at=now() WHERE id=$8 RETURNING *",
            [...values, id],
          )
        ).rows[0]
      : (
          await client.query<Routine>(
            "INSERT INTO evestack.routines(name,prompt,cron,time_zone,enabled,archived,next_due,id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
            [...values, randomUUID()],
          )
        ).rows[0];
    await audit(client, routine, id ? "updated" : "created", identity);
    return routine;
  });
}

export async function listRoutines() {
  await ensureRoutines();
  return (
    await getPool().query<Routine>(
      "SELECT * FROM evestack.routines WHERE NOT archived ORDER BY created_at DESC LIMIT 200",
    )
  ).rows;
}
export async function routineOverview() {
  await ensureRoutines();
  return (
    await getPool().query<{
      id: string;
      name: string;
      enabled: boolean;
      time_zone: string;
      next_due: Date;
      state: RoutineRun["state"] | null;
      session_id: string | null;
      error: string | null;
    }>(`SELECT r.id,r.name,r.enabled,r.time_zone,r.next_due,last.state,last.session_id,last.error
    FROM evestack.routines r
    LEFT JOIN LATERAL (SELECT state,session_id,error FROM evestack.routine_runs WHERE routine_id=r.id ORDER BY created_at DESC LIMIT 1) last ON true
    WHERE NOT r.archived AND (r.enabled OR last.state IN ('unknown','failed','awaiting_approval','claimed','dispatching','running'))
    ORDER BY CASE WHEN last.state IN ('unknown','failed','awaiting_approval') THEN 0 ELSE 1 END,r.next_due LIMIT 8`)
  ).rows;
}
export async function routineHistory(id: string) {
  await ensureRoutines();
  const routine = (
    await getPool().query<Routine>(
      "SELECT * FROM evestack.routines WHERE id=$1",
      [id],
    )
  ).rows[0];
  if (!routine) throw new RoutineError("Routine not found.", 404);
  const runs = (
    await getPool().query<RoutineRun>(
      "SELECT * FROM evestack.routine_runs WHERE routine_id=$1 ORDER BY created_at DESC LIMIT 50",
      [id],
    )
  ).rows;
  return { routine, runs, notifications: await routineNotificationHistory(id) };
}

async function insertRun(
  client: PoolClient,
  routine: Routine,
  at: Date,
  trigger: RoutineRun["trigger"],
  key: string | null,
  catchupFrom?: string,
) {
  const snapshot = {
    name: routine.name,
    prompt: routine.prompt,
    cron: routine.cron,
    timeZone: routine.time_zone,
    ...(catchupFrom ? { catchupFrom } : {}),
  };
  return (
    await client.query<RoutineRun>(
      `INSERT INTO evestack.routine_runs(id,routine_id,revision,scheduled_at,trigger,state,request_key,snapshot,skipped_count)
    VALUES($1,$2,$3,$4,$5,'claimed',$6,$7,$8) RETURNING *`,
      [
        randomUUID(),
        routine.id,
        routine.revision,
        at,
        trigger,
        key,
        JSON.stringify(snapshot),
        catchupFrom ? null : 0,
      ],
    )
  ).rows[0];
}

export async function runRoutineNow(
  id: string,
  key: string,
  identity: ApproverIdentity,
) {
  await ensureRoutines();
  return routineTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(7141502)");
    const prior = (
      await client.query<RoutineRun>(
        "SELECT * FROM evestack.routine_runs WHERE request_key=$1",
        [key],
      )
    ).rows[0];
    if (prior) {
      if (prior.routine_id !== id)
        throw new RoutineError("Request id belongs to another routine.", 409);
      return prior;
    }
    const routine = (
      await client.query<Routine>(
        "SELECT * FROM evestack.routines WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (!routine || routine.archived)
      throw new RoutineError("Routine not found or archived.", 404);
    const active = (
      await client.query(
        `SELECT routine_id FROM evestack.routine_runs WHERE state IN ${ACTIVE}`,
      )
    ).rows;
    if (active.some((run) => run.routine_id === id))
      throw new RoutineError(
        "This routine already has an active or uncertain run. Inspect it before starting another.",
        409,
      );
    if (active.length >= 4)
      throw new RoutineError(
        "Four routines are already active. Wait for one to finish.",
        409,
      );
    const run = await insertRun(client, routine, new Date(), "manual", key);
    await audit(client, routine, "run-now", identity);
    return run;
  });
}

/** Only the latest missed occurrence runs. Earlier missed work is described by its skipped interval. */
export async function claimDueRoutine(
  now = new Date(),
): Promise<RoutineRun | null> {
  await ensureRoutines();
  return routineTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(7141502)");
    const routine = (
      await client.query<Routine>(
        "SELECT * FROM evestack.routines WHERE enabled AND NOT archived AND next_due <= $1 ORDER BY next_due FOR UPDATE SKIP LOCKED LIMIT 1",
        [now],
      )
    ).rows[0];
    if (!routine) return null;
    const active = (
      await client.query(
        `SELECT routine_id FROM evestack.routine_runs WHERE state IN ${ACTIVE}`,
      )
    ).rows;
    if (
      active.length >= 4 &&
      !active.some((run) => run.routine_id === routine.id)
    )
      return null;
    const latest =
      previousRoutineFire(
        routine.cron,
        routine.time_zone,
        new Date(now.getTime() + 1),
      ) ?? routine.next_due;
    const next = nextRoutineFires(routine.cron, routine.time_zone, now, 1)[0];
    if (!next)
      throw new Error(
        "Routine has no next occurrence; pause and review its schedule.",
      );
    await client.query("UPDATE evestack.routines SET next_due=$2 WHERE id=$1", [
      routine.id,
      next,
    ]);
    if (active.some((run) => run.routine_id === routine.id)) {
      await client.query(
        `INSERT INTO evestack.routine_runs(id,routine_id,revision,scheduled_at,trigger,state,snapshot,error,finished_at)
        VALUES($1,$2,$3,$4,'clock','skipped',$5,'An earlier run is still active or its dispatch is uncertain.',now()) ON CONFLICT DO NOTHING`,
        [
          randomUUID(),
          routine.id,
          routine.revision,
          latest,
          JSON.stringify({
            name: routine.name,
            prompt: routine.prompt,
            cron: routine.cron,
            timeZone: routine.time_zone,
          }),
        ],
      );
      return null;
    }
    const catchup = latest.getTime() > routine.next_due.getTime();
    return insertRun(
      client,
      routine,
      latest,
      catchup ? "catchup" : "clock",
      null,
      catchup ? routine.next_due.toISOString() : undefined,
    );
  });
}

export async function beginRoutineDispatch(run: RoutineRun): Promise<boolean> {
  return routineTransaction(async (client) => {
    const routine = (
      await client.query<Routine>(
        "SELECT * FROM evestack.routines WHERE id=$1 FOR UPDATE",
        [run.routine_id],
      )
    ).rows[0];
    if (
      !routine ||
      routine.archived ||
      (run.trigger !== "manual" &&
        (!routine.enabled || routine.revision !== run.revision))
    ) {
      await client.query(
        "UPDATE evestack.routine_runs SET state='skipped',error='Routine was paused, archived or edited before dispatch.',finished_at=now(),updated_at=now() WHERE id=$1 AND state='claimed'",
        [run.id],
      );
      return false;
    }
    const result = await client.query(
      "UPDATE evestack.routine_runs SET state='dispatching',updated_at=now() WHERE id=$1 AND state='claimed' RETURNING id",
      [run.id],
    );
    return result.rows.length > 0;
  });
}

/** Keep the uncertain marker, pause and audit in one transaction. */
export async function markRoutineDispatchUncertain(
  run: RoutineRun,
  detail: string,
  expiredBefore?: Date,
) {
  return routineTransaction(async (client) => {
    await client.query(
      "SELECT id FROM evestack.routines WHERE id=$1 FOR UPDATE",
      [run.routine_id],
    );
    const changed = await client.query(
      "UPDATE evestack.routine_runs SET state='unknown',error=$2,updated_at=now() WHERE id=$1 AND state='dispatching' AND ($3::timestamptz IS NULL OR updated_at < $3) RETURNING id",
      [run.id, detail, expiredBefore ?? null],
    );
    if (!changed.rows.length) return false;
    const routine = (
      await client.query<Routine>(
        "UPDATE evestack.routines SET enabled=false,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *",
        [run.routine_id],
      )
    ).rows[0];
    await client.query(
      "INSERT INTO evestack.routine_audit(routine_id,revision,action,actor,actor_via,snapshot) VALUES($1,$2,$3,NULL,'dispatcher',$4)",
      [
        routine.id,
        routine.revision,
        `dispatch-uncertain:${run.id}`,
        JSON.stringify({ ...routine, dispatchError: detail }),
      ],
    );
    await queueRoutineNotification(client, {
      ...run,
      state: "unknown",
      error: detail,
    });
    return true;
  });
}

export async function resolveUncertainRoutineRun(
  routineId: string,
  runId: string,
  note: string,
  identity: ApproverIdentity,
) {
  await ensureRoutines();
  return routineTransaction(async (client) => {
    const routine = (
      await client.query<Routine>(
        "SELECT * FROM evestack.routines WHERE id=$1 FOR UPDATE",
        [routineId],
      )
    ).rows[0];
    if (!routine) throw new RoutineError("Routine not found.", 404);
    const result = await client.query(
      "UPDATE evestack.routine_runs SET state='resolved',error=$3,finished_at=now(),updated_at=now() WHERE id=$1 AND routine_id=$2 AND state='unknown' RETURNING id",
      [
        runId,
        routineId,
        `Operator resolved uncertain dispatch after investigation: ${note}`,
      ],
    );
    if (!result.rows.length)
      throw new RoutineError(
        "Only an uncertain dispatch can be resolved here. Refresh its state.",
        409,
      );
    const updated = (
      await client.query<Routine>(
        "UPDATE evestack.routines SET enabled=false,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *",
        [routineId],
      )
    ).rows[0];
    await audit(client, updated, `resolved-dispatch:${runId}`, identity);
    return updated;
  });
}

export async function retryRoutineNotification(
  routineId: string,
  notificationId: string,
  identity: ApproverIdentity,
) {
  await ensureRoutines();
  return routineTransaction(async (client) => {
    const routine = (
      await client.query<Routine>(
        "SELECT * FROM evestack.routines WHERE id=$1 FOR UPDATE",
        [routineId],
      )
    ).rows[0];
    if (!routine) throw new RoutineError("Routine not found.", 404);
    const notice = (
      await client.query(
        "SELECT state,sink_key FROM evestack.routine_notifications WHERE id=$1 AND routine_id=$2 FOR UPDATE",
        [notificationId, routineId],
      )
    ).rows[0];
    if (!notice || notice.state !== "failed")
      throw new RoutineError(
        "Only a failed notification can be retried. Refresh its delivery status.",
        409,
      );
    if (!notificationTargetConfigured(notice.sink_key))
      throw new RoutineError(
        "This notification's destination is no longer configured. Restore it before retrying.",
        409,
      );
    await client.query(
      "UPDATE evestack.routine_notifications SET state='pending',attempts=0,next_attempt=now(),error=NULL,holder=NULL,claimed_at=NULL WHERE id=$1",
      [notificationId],
    );
    await audit(
      client,
      routine,
      `notification-retry:${notificationId}`,
      identity,
    );
  });
}
