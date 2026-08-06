import {
  continueSession,
  createSession,
  getSessionSnapshot,
  parkedSince,
  readRecentEvents,
} from "@/lib/agent-client";
import { recoverTurns } from "@/lib/promote-eval";
import { getSession } from "@/lib/queries";
import { handleRouteError, isResponse, jsonError, jsonOk, readJsonObject } from "../../../_http";

export const dynamic = "force-dynamic";

/**
 * `/api/control/sessions/:id/fork` — re-run a past conversation in a new
 * session, optionally rewriting one turn.
 *
 * WHAT THIS IS. The durable event log holds every user message, so a past
 * conversation can be re-sent verbatim into a fresh session with one message
 * changed. That answers the question you always have after a bad run — "would
 * it have worked if I had said it differently?" — without retyping the
 * conversation and hoping you reproduced it. It is only possible because
 * evestack owns the store; a hosted dashboard that drops run history after a
 * day cannot offer it at all.
 *
 * WHAT THIS IS NOT. It is not a checkpoint fork, and it must never be described
 * as one. LangGraph branches from serialized graph state, so the turns before
 * the branch point are never executed twice. eve's durable record is an event
 * log, not a resumable state snapshot, so the only way to reach turn 5 here is
 * to run turns 1 through 4 again — for real, against real tools. An email the
 * original session sent, this sends again. A file it deleted, this deletes
 * again. That is strictly weaker than a checkpoint fork and costs strictly
 * more.
 *
 * WHY IT SURVIVES ANYWAY. The alternative to a replay button is a person
 * retyping the same messages into /chat, which re-runs the same tools with no
 * warning, no record of what it was forked from, and no chance to stop short.
 * Deleting this would remove the warning, not the danger. So the route leans
 * into the one thing it can do that a human retyping cannot: `recoverTurns`
 * already knows which tools each turn called, so `GET` returns that per-turn
 * tool list and the UI refuses to run until the operator has been shown it.
 * See app/sessions/[id]/fork-client.tsx.
 */

/**
 * One lookback for both handlers, deliberately shared: if `GET` recovered a
 * different number of turns than `POST` does, the operator would acknowledge
 * one plan and run another.
 */
const TRANSCRIPT_LOOKBACK = 4096;

/**
 * How long to wait for a replayed turn to settle before giving up on the rest.
 *
 * A replayed turn takes as long as the original did — model latency plus every
 * tool it calls — and this is all one HTTP request, so the wait has to be
 * bounded by something. These numbers are a budget, not a measurement: nothing
 * here knows how long the agent will take. What matters is the failure mode
 * they produce. On expiry the fork is already created and already holds the
 * turns that landed, so the route reports a partial with the new session id
 * instead of hanging or pretending to have failed.
 */
const TURN_READY_TIMEOUT_MS = 90_000;
const FORK_BUDGET_MS = 240_000;

/**
 * Poll interval while waiting for `session.waiting`. Each poll opens a stream
 * read against the agent, and no turn settles in under a second, so polling
 * faster only multiplies those reads.
 */
const READY_POLL_MS = 1_500;

/**
 * A snapshot read only has to reach back far enough to cover the current turn:
 * `session.waiting` is the last event when a session is parked, and the
 * `input.requested` that would make that park a human's problem is emitted
 * earlier in the same turn. 512 covers a long tool-heavy turn while costing a
 * fraction of the 4096-event transcript read on every poll. A fork starts empty,
 * so for the first several turns this is the whole session anyway.
 */
const SNAPSHOT_LOOKBACK = 512;

type RecoveredTurn = ReturnType<typeof recoverTurns>[number];

interface PlannedTurn {
  turn: number;
  message: string;
  tools: string[];
  deniedTools: string[];
  failed: boolean;
}

function planFrom(turns: readonly RecoveredTurn[]): PlannedTurn[] {
  return turns.map((turn, index) => ({
    turn: index + 1,
    message: turn.userMessage,
    tools: turn.toolNames,
    deniedTools: turn.deniedTools,
    failed: turn.failed,
  }));
}

/**
 * GET — what a fork would do, without doing any of it.
 *
 * This exists so the confirmation in the UI can name the actual tools that
 * would run again rather than warning in the abstract. Reading the transcript
 * is the same read `GET /api/evals/promote/:id` already does, so it exposes
 * nothing new; it is served here rather than computed in the session page so
 * that the page keeps rendering from Postgres alone and does not start
 * depending on the agent being up.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;

    const session = await getSession(id);
    if (!session) return jsonError(`No session ${id}.`, 404, "not_found");

    const { events } = await readRecentEvents(id, {
      lookback: TRANSCRIPT_LOOKBACK,
      signal: request.signal,
    });
    const turns = recoverTurns(events);

    return jsonOk({
      sessionId: id,
      title: session.title,
      turns: planFrom(turns),
    });
  } catch (error) {
    return handleRouteError(error, request);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const body = await readJsonObject(request);
    if (isResponse(body)) return body;

    const session = await getSession(id);
    if (!session) return jsonError(`No session ${id}.`, 404, "not_found");

    const { events } = await readRecentEvents(id, {
      lookback: TRANSCRIPT_LOOKBACK,
      signal: request.signal,
    });
    const turns = recoverTurns(events);
    if (turns.length === 0) {
      return jsonError(
        "No user messages were recovered from this session, so there is nothing to replay.",
        409,
        "nothing_to_replay",
      );
    }

    // `fromTurn` is 1-based and inclusive: fork "from turn 3" replays 1 and 2
    // unchanged and rewrites the third. Off-by-one here silently reruns the turn
    // you were trying to avoid, so it is validated rather than clamped.
    //
    // It is also REQUIRED. It used to default to `turns.length` — so an empty
    // body replayed the entire conversation, every tool call in it included.
    // Making the largest blast radius the one you get by saying nothing is
    // backwards for an operation that spends money and sends mail; the caller
    // has to name the number, and `GET` on this path tells them what the
    // numbers mean.
    const rawFrom = body.fromTurn;
    if (rawFrom === undefined) {
      return jsonError(
        `'fromTurn' is required: replaying re-executes every tool call in turns 1..fromTurn, so ` +
          `the range is never assumed. GET this URL for the turns and the tools each one ran ` +
          `(this session has ${turns.length}).`,
        400,
        "bad_request",
      );
    }
    const fromTurn = Number(rawFrom);
    if (!Number.isInteger(fromTurn) || fromTurn < 1 || fromTurn > turns.length) {
      return jsonError(
        `'fromTurn' must be an integer between 1 and ${turns.length} (this session has ` +
          `${turns.length} user turn${turns.length === 1 ? "" : "s"}).`,
        400,
        "bad_request",
      );
    }

    const replacement = body.message;
    if (replacement !== undefined && typeof replacement !== "string") {
      return jsonError("'message' must be a string when provided.", 400, "bad_request");
    }
    if (typeof replacement === "string" && replacement.trim() === "") {
      return jsonError("'message' cannot be empty — omit it to replay verbatim.", 400, "bad_request");
    }

    // Everything strictly before the forked turn is replayed as it was; the
    // forked turn is either rewritten or replayed too. Turns after it are
    // dropped: their content was a reaction to a conversation that no longer
    // happened, so replaying them would be fiction.
    //
    // Re-reading the transcript here rather than trusting the plan the UI showed
    // is safe because turns are append-only: a message that arrives in the
    // original session between the GET and this POST can only become turn N+1,
    // so turns 1..fromTurn — the ones the operator acknowledged — cannot change
    // underneath them.
    const script = turns.slice(0, fromTurn).map((turn, index) =>
      index === fromTurn - 1 && typeof replacement === "string" ? replacement : turn.userMessage,
    );

    const first = script[0]!;
    const created = await createSession({
      message: first,
      mode: "conversation",
      signal: request.signal,
    });

    /*
     * Sequential, and each turn re-reads the token.
     *
     * The bug this replaced: the loop sent every follow-up with
     * `created.continuationToken`, the token minted when the session was
     * created. eve rotates that token at every turn boundary and publishes the
     * live one on `session.waiting` (see SessionSnapshot in lib/agent-client.ts:
     * "Rotates every turn; only the one from the latest `session.waiting`
     * works"). `continueSession` returns `{sessionId}` and no replacement, so
     * there was nothing to advance it with — the second follow-up carried a
     * token that was already two turns old. A 3-turn fork therefore failed
     * partway and reported itself a partial success.
     *
     * `getSessionSnapshot` is the fix and already existed: the message and
     * approve routes both use it to resolve the current token off the durable
     * stream. Waiting for it also solves the second half of the problem — the
     * agent rejects a follow-up sent while a turn is still running — because
     * the token only appears once the session is parked.
     */
    const deadline = Date.now() + FORK_BUDGET_MS;
    let delivered = 1;
    let stopped: { atTurn: number; code: string; message: string } | undefined;
    // The stream position of the park we last spent. Carried between
    // iterations because "the session is waiting" is not by itself "the
    // session is waiting for the NEXT turn" — see waitUntilReady.
    let spentAtTailIndex = -1;

    for (const [index, message] of script.slice(1).entries()) {
      const turnNumber = index + 2;

      const ready = await waitUntilReady(
        created.sessionId,
        deadline,
        request.signal,
        spentAtTailIndex,
      );
      if (ready.code !== "ready") {
        stopped = { atTurn: turnNumber, code: ready.code, message: ready.message };
        break;
      }

      try {
        const result = await continueSession(created.sessionId, {
          continuationToken: ready.continuationToken,
          message,
          signal: request.signal,
        });
        spentAtTailIndex = ready.tailIndex;

        // eve answers an unknown session id by starting a NEW session and
        // returning its id rather than failing — see the same guard in
        // ../message/route.ts. In a loop that is worse than a one-off: without
        // this check a fork whose session went missing would spawn a fresh run
        // per remaining turn, each billing against a session nobody is watching.
        if (result.sessionId !== created.sessionId) {
          stopped = {
            atTurn: turnNumber,
            code: "session_mismatch",
            message:
              `The agent did not continue the fork — it started '${result.sessionId}' instead. ` +
              `That run is live and was not part of this replay; cancel it.`,
          };
          break;
        }

        delivered += 1;
      } catch (cause) {
        // Report what landed rather than unwinding. The fork already exists and
        // is inspectable; pretending it does not would be worse than a partial.
        stopped = {
          atTurn: turnNumber,
          code: "agent_error",
          message: cause instanceof Error ? cause.message : String(cause),
        };
        break;
      }
    }

    return jsonOk(
      {
        sessionId: created.sessionId,
        forkedFrom: id,
        fromTurn,
        turnsPlanned: script.length,
        turnsDelivered: delivered,
        rewritten: typeof replacement === "string",
        complete: delivered === script.length,
        ...(stopped ? { stopped } : {}),
      },
      202,
    );
  } catch (error) {
    return handleRouteError(error, request);
  }
}

type Readiness =
  | { code: "ready"; continuationToken: string; tailIndex: number }
  | { code: "session_ended" | "awaiting_human" | "timeout"; message: string };

/**
 * Blocks until the fork is parked and ready for the next scripted message.
 *
 * Three of the four outcomes are stopping conditions rather than errors:
 *
 *  - `session_ended` — the replay diverged into a run that finished or failed,
 *    so there is no session left to send turn N+1 to.
 *  - `awaiting_human` — the replayed turn parked on a tool approval or an
 *    `ask_question`. `session.waiting` is emitted for that park too (a HITL
 *    pause emits `turn.completed` *before* `session.waiting`; see the ordering
 *    note in getSessionSnapshot), so "waiting" alone is not "ready", and the
 *    pending requests have to be checked. Answering on the operator's behalf is
 *    not an option: the event log records that a tool was denied, never why, so
 *    the replay cannot reproduce the decision. It stops and hands the fork back.
 *  - `timeout` — the budget above.
 *
 * `spentAtTailIndex` closes a race that "the session is waiting" alone does
 * not. eve answers the follow-up POST as soon as it accepts the message, which
 * is before `turn.started` reaches the durable stream — so for a moment after
 * sending turn N the snapshot still shows the PREVIOUS `session.waiting`.
 * Taking that at face value would fire turn N+1 before turn N had run. So
 * readiness is "parked at a boundary FURTHER ALONG the stream than the one I
 * spent", which is what `parkedSince` tests.
 *
 * It used to test `snapshot.continuationToken !== spentToken`, on the
 * documented belief that eve rotates the token every turn. It does not. On eve
 * 0.30.8 over @workflow/world-postgres the continuation token is the session's
 * command-hook token and never changes for the life of the session. Measured
 * on a real 3-turn fork: turns 1 and 2 landed, then this function spun for its
 * full 90s timeout against a fork that was already parked and ready, and the
 * route answered `{turnsDelivered: 2, stopped: {atTurn: 3, code: "timeout"}}` —
 * the same "3-turn fork reports itself a partial success" symptom that
 * re-reading the token was introduced to fix, reached a different way.
 */
async function waitUntilReady(
  sessionId: string,
  deadline: number,
  signal: AbortSignal,
  spentAtTailIndex: number,
): Promise<Readiness> {
  const turnDeadline = Math.min(deadline, Date.now() + TURN_READY_TIMEOUT_MS);

  for (;;) {
    const snapshot = await getSessionSnapshot(sessionId, {
      lookback: SNAPSHOT_LOOKBACK,
      signal,
    });

    if (snapshot.terminal) {
      return {
        code: "session_ended",
        message:
          `The fork ended after this turn (last event: ${snapshot.lastEventType ?? "unknown"}), ` +
          `so the remaining turns were not sent.`,
      };
    }

    if (snapshot.waiting) {
      if (snapshot.pendingRequests.length > 0) {
        const prompts = snapshot.pendingRequests
          .map((entry) => entry.action?.toolName ?? entry.kind)
          .join(", ");
        return {
          code: "awaiting_human",
          message:
            `The fork is parked on a decision only you can make (${prompts}). Answer it on the ` +
            `fork's own page, then send the remaining turns yourself.`,
        };
      }
      if (parkedSince(snapshot, spentAtTailIndex)) {
        return {
          code: "ready",
          continuationToken: snapshot.continuationToken!,
          tailIndex: snapshot.tailIndex,
        };
      }
    }

    const remaining = turnDeadline - Date.now();
    if (remaining <= 0) {
      return {
        code: "timeout",
        message:
          `The fork did not come back for the next turn within ` +
          `${Math.round(TURN_READY_TIMEOUT_MS / 1000)}s (last event: ` +
          `${snapshot.lastEventType ?? "none yet"}), or the replay ran out of its ` +
          `${Math.round(FORK_BUDGET_MS / 1000)}s budget. Nothing was lost — the fork is live and ` +
          `you can continue it from its own page.`,
      };
    }

    await sleep(Math.min(READY_POLL_MS, remaining), signal);
  }
}

/** Rejects on abort so a closed tab stops the replay instead of polling on. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
