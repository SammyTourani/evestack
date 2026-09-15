import { createSession, getSessionSnapshot } from "./agent-client";
import { getPool } from "./db";
import {
  beginRoutineDispatch,
  claimDueRoutine,
  ensureRoutines,
  markRoutineDispatchUncertain,
  routineTransaction,
  type RoutineRun,
} from "./routines";
import {
  queueRoutineNotification,
  deliverRoutineNotifications,
} from "./routine-notifications";

const state = globalThis as typeof globalThis & {
  __routineClock?: {
    timer: ReturnType<typeof setInterval>;
    busy: boolean;
    lastTick: string | null;
    error: string | null;
  };
};

export function routineClockStatus() {
  const clock = state.__routineClock;
  return {
    running: Boolean(clock),
    lastTick: clock?.lastTick ?? null,
    error: clock?.error ?? null,
  };
}

/** The dispatch marker is durable before the HTTP call. An uncertain response is never retried. */
export async function dispatchRoutineRun(run: RoutineRun) {
  if (!(await beginRoutineDispatch(run))) return;
  try {
    const session = await createSession({
      message: run.snapshot.prompt,
      mode: "task",
      clientContext: {
        evestackRoutine: {
          id: run.routine_id,
          runId: run.id,
          revision: run.revision,
        },
      },
    });
    await getPool().query(
      "UPDATE evestack.routine_runs SET state='running',session_id=$2,error=NULL,updated_at=now() WHERE id=$1 AND state IN ('dispatching','unknown')",
      [run.id, session.sessionId],
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // Even a timeout or a failed DB write after acceptance may mean the agent started work.
    await markRoutineDispatchUncertain(
      run,
      `Dispatch could not be confirmed. Check recent tasks before any repeat. ${detail}`,
    );
  }
}

export async function tickRoutines() {
  await ensureRoutines();
  // A process could die after sending but before storing the session id. Do not reclaim this marker.
  const expiredBefore = new Date(Date.now() - 120000);
  const expired = await getPool().query<RoutineRun>(
    "SELECT * FROM evestack.routine_runs WHERE state='dispatching' AND updated_at < $1 ORDER BY updated_at LIMIT 4",
    [expiredBefore],
  );
  for (const run of expired.rows)
    await markRoutineDispatchUncertain(
      run,
      "The dispatcher stopped before delivery was confirmed. Inspect recent tasks; this run will not be repeated automatically.",
      expiredBefore,
    );

  const active = (
    await getPool().query<RoutineRun>(
      "SELECT * FROM evestack.routine_runs WHERE state IN ('running','awaiting_approval') ORDER BY updated_at LIMIT 4",
    )
  ).rows;
  await Promise.all(
    active.map(async (run) => {
      if (!run.session_id) return;
      try {
        const snapshot = await getSessionSnapshot(run.session_id, {
          timeoutMs: 2500,
        });
        let outcome: RoutineRun["state"] = snapshot.pendingRequests.length
          ? "awaiting_approval"
          : "running";
        if (snapshot.terminal) {
          const failed =
            (
              await getPool().query(
                `SELECT id FROM workflow.workflow_runs WHERE (id=$1 OR attributes->>'$eve.root'=$1) AND status IN ('failed','errored','cancelled') LIMIT 1`,
                [run.session_id],
              )
            ).rows.length > 0;
          outcome =
            snapshot.failedOrCancelled || failed ? "failed" : "completed";
        }
        await routineTransaction(async (client) => {
          const updated = (
            await client.query<RoutineRun>(
              "UPDATE evestack.routine_runs SET state=$2,error=NULL,updated_at=now(),finished_at=CASE WHEN $2 IN ('completed','failed') THEN now() ELSE NULL END WHERE id=$1 AND state IN ('running','awaiting_approval') RETURNING *",
              [run.id, outcome],
            )
          ).rows[0];
          if (updated)
            await queueRoutineNotification(
              client,
              updated,
              snapshot.pendingRequests.map((request) => request.requestId),
            );
        });
      } catch (error) {
        // Losing a stream probe says nothing about whether the task is still active.
        await getPool().query(
          "UPDATE evestack.routine_runs SET error=$2,updated_at=now() WHERE id=$1 AND state IN ('running','awaiting_approval')",
          [
            run.id,
            `State check unavailable: ${error instanceof Error ? error.message : String(error)}`,
          ],
        );
      }
    }),
  );
  // A claimed row has not crossed the HTTP boundary and can be recovered by another worker.
  const claimed = (
    await getPool().query<RoutineRun>(
      "SELECT * FROM evestack.routine_runs WHERE state='claimed' ORDER BY created_at LIMIT 4",
    )
  ).rows;
  await Promise.all(claimed.map(dispatchRoutineRun));
  for (let count = 0; count < 4; count++) {
    const run = await claimDueRoutine();
    if (!run) break;
    await dispatchRoutineRun(run);
  }
  await deliverRoutineNotifications();
}

export function startRoutineClock() {
  if (state.__routineClock) return;
  if (
    process.env.EVESTACK_ROUTINES_DISABLED === "1" ||
    !process.env.EVESTACK_AUTH_PASSWORD ||
    !(process.env.WORKFLOW_POSTGRES_URL || process.env.DATABASE_URL)
  )
    return;
  const clock = {
    timer: undefined as unknown as ReturnType<typeof setInterval>,
    busy: false,
    lastTick: null as string | null,
    error: null as string | null,
  };
  const tick = async () => {
    if (clock.busy) return;
    clock.busy = true;
    try {
      await tickRoutines();
      clock.lastTick = new Date().toISOString();
      clock.error = null;
    } catch (error) {
      clock.error = error instanceof Error ? error.message : String(error);
      console.warn(`[evestack:routines] ${clock.error}`);
    } finally {
      clock.busy = false;
    }
  };
  clock.timer = setInterval(() => void tick(), 15000);
  clock.timer.unref();
  state.__routineClock = clock;
  void tick();
}
