import { createHash } from "node:crypto";

import {
  continueSession,
  createSession,
  getSessionSnapshot,
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
 * How far back both handlers read the transcript.
 *
 * This constant used to be described as the thing that keeps `GET` and `POST`
 * from disagreeing — "one lookback for both handlers, deliberately shared". It
 * is not, and the claim was the bug. `readRecentEvents` reads a TAIL window
 * (`startIndex: -lookback`), so sharing a window SIZE is not sharing a WINDOW:
 * two reads of the same size taken a second apart cover different events the
 * moment anything is appended to the original session, and every turn number in
 * this file is positional. Sharing the number only makes the two reads
 * comparable in cost.
 *
 * What actually makes the two handlers agree is below, and it is two checks
 * rather than a constant: `describeTruncation` refuses a read that did not reach
 * the first event, so "turn 1" is really turn 1; and `fingerprintPlan` names the
 * exact message list `GET` showed, so `POST` can refuse to replay a different
 * one. Raising this number changes how long a session can get before forks stop
 * being offered; it changes nothing about that safety property.
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
 * The two refusals, kept apart because the thing to do about them differs.
 * `transcript_truncated` needs a bigger window or a shorter session and will keep
 * failing until one of those changes; `plan_changed` only needs the operator to
 * look at the plan again and acknowledge what it now says.
 */
const TRUNCATED_CODE = "transcript_truncated";
const PLAN_CHANGED_CODE = "plan_changed";

/**
 * Why a transcript read that started mid-conversation cannot be replayed at all.
 *
 * `readRecentEvents` asks for the LAST `TRANSCRIPT_LOOKBACK` events
 * (`startIndex: -lookback`) and reports the absolute index it landed on. Every
 * turn number in this file is positional: `recoverTurns` folds whichever events
 * it was handed, and `planFrom` calls the first one it finds "turn 1". That
 * numbering is only true when the read reached index 0. Past the window it is a
 * lie with a real cost — "replay turns 1..3" would replay three turns from the
 * middle of the conversation under names that belong to earlier ones, executing
 * their tool calls for real.
 *
 * So there is no degraded mode. A plan the dashboard cannot number honestly is
 * not offered, and `startIndex` — which `readRecentEvents` has always returned
 * and nothing here used to read — is the whole test.
 *
 * One honest limit: `startIndex === 0` means this read reached index 0 of the
 * durable stream. It is not proof that no earlier event was ever pruned from
 * that stream, because nothing the dashboard can see distinguishes a pruned
 * stream from a short one (lib/promote-eval.ts warns about the same gap).
 */
export function describeTruncation(read: { startIndex: number; tailIndex: number }): string | null {
  if (read.startIndex <= 0) return null;
  return (
    `This session is longer than the transcript window the dashboard reads: it has ` +
    `${read.tailIndex + 1} recorded events and the read covers only the last ` +
    `${TRANSCRIPT_LOOKBACK} of them, starting at event ${read.startIndex}. Turns recovered from a ` +
    `window that begins mid-conversation cannot be numbered from 1, so replaying "turns 1..N" ` +
    `would name the wrong turns and re-run the wrong tools for real. Replay is refused rather ` +
    `than offered against the wrong numbering; raise TRANSCRIPT_LOOKBACK in this route if forks ` +
    `of sessions this long are worth the bigger read.`
  );
}

/**
 * A stable name for the plan `GET` showed, so `POST` can refuse to run another.
 *
 * The operator acknowledges a specific list of messages. `POST` re-reads the
 * transcript rather than trusting a client-supplied script — it has to, or the
 * caller could name any messages it liked — and the fingerprint is what closes
 * the gap between the two reads: `GET` returns it, the caller echoes it, and
 * `POST` recomputes it from its own read. Different plan, different digest,
 * refused. That is the same reasoning that made `fromTurn` required rather than
 * defaulted below: for an operation that spends money and sends mail, the
 * dangerous behaviour must not be the one you get by saying nothing.
 *
 * WHAT IS IN IT. The ordered user messages — the exact strings that would be
 * re-sent — and the window anchor, so a window that slid to a different part of
 * the same conversation cannot collide with the plan taken from the old one.
 *
 * WHAT IS NOT, deliberately. The per-turn tool lists. They are evidence about
 * what the original session did, not a promise about the replay: the model is
 * free to call different tools this time, which the panel says out loud. A
 * completed turn's tool list cannot change either, so the only drift a
 * tool-sensitive digest would catch is the last turn of a session that is still
 * running — at the cost of refusing every fork of a live session. The messages
 * are what actually get replayed, so they are what gets pinned.
 *
 * A hash, not a wire-format deep compare: the digest is short, it is cheap to
 * echo through the UI, and it cannot be read as a description of the plan. It is
 * not a MAC and is not treated as one — it authenticates nothing, and a forged
 * value can only match by matching the log `POST` just read for itself.
 */
export function fingerprintPlan(
  turns: readonly { userMessage: string }[],
  windowStart: number,
): string {
  // JSON does the escaping. An array of strings has exactly one serialisation,
  // and a message containing whatever delimiter we might otherwise have joined
  // on cannot forge a turn boundary: ["a\nb"] and ["a", "b"] are different
  // documents, so they are different digests.
  const canonical = JSON.stringify([
    "fork-plan/v1",
    windowStart,
    turns.map((turn) => turn.userMessage),
  ]);
  return createHash("sha256").update(canonical).digest("hex");
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
 *
 * It returns two things besides the turns, and `POST` is unusable without them:
 * `planFingerprint`, which the caller has to echo back so the replay is pinned to
 * the plan that was actually shown, and `truncated`/`refusal`, which say that
 * this session is too long for the dashboard to number from turn 1 — so the UI
 * can explain that instead of offering a button whose `POST` is already certain
 * to be refused.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;

    const session = await getSession(id);
    if (!session) return jsonError(`No session ${id}.`, 404, "not_found");

    const read = await readRecentEvents(id, {
      lookback: TRANSCRIPT_LOOKBACK,
      signal: request.signal,
    });

    // Reported as a field rather than raised as an error, because the panel calls
    // this endpoint to decide what to render and a 4xx gives it nothing to
    // explain. `turns` comes back empty on purpose: the turns recovered from a
    // short window are real messages under wrong numbers, and shipping them so
    // the UI can list them "1, 2, 3" is exactly the mislabelling being refused.
    const truncated = describeTruncation(read);
    if (truncated) {
      return jsonOk({
        sessionId: id,
        title: session.title,
        turns: [],
        truncated: true,
        refusal: truncated,
      });
    }

    const turns = recoverTurns(read.events);

    return jsonOk({
      sessionId: id,
      title: session.title,
      turns: planFrom(turns),
      truncated: false,
      // The plan the operator is about to be shown, named. `POST` will not run
      // without this value coming back.
      planFingerprint: fingerprintPlan(turns, read.startIndex),
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

    const read = await readRecentEvents(id, {
      lookback: TRANSCRIPT_LOOKBACK,
      signal: request.signal,
    });

    // First, because it explains the cause the other refusals would only hint at:
    // if this read did not reach the first event, no turn number in this request
    // means what it says and there is nothing safe to do with `fromTurn`.
    const truncated = describeTruncation(read);
    if (truncated) return jsonError(truncated, 409, TRUNCATED_CODE);

    const turns = recoverTurns(read.events);
    if (turns.length === 0) {
      return jsonError(
        "No user messages were recovered from this session, so there is nothing to replay.",
        409,
        "nothing_to_replay",
      );
    }

    // The plan has to be named, and the name has to match.
    //
    // Required for the same reason `fromTurn` is (see below): the caller says
    // which plan it is replaying, and saying nothing does not get you a replay of
    // whatever the transcript happens to say now. `POST` still derives the script
    // from its own read — a client-supplied script would let any caller name any
    // messages — so the fingerprint is the only thing tying that read to the one
    // the operator read.
    const claimed = body.planFingerprint;
    if (typeof claimed !== "string" || claimed.length === 0) {
      return jsonError(
        `'planFingerprint' is required: it is the fingerprint GET returned alongside the plan the ` +
          `operator was shown, and echoing it is what proves this replay is that plan rather than ` +
          `whatever the transcript says now. GET this URL and send the value back.`,
        400,
        "bad_request",
      );
    }
    if (claimed !== fingerprintPlan(turns, read.startIndex)) {
      // The current fingerprint is deliberately NOT included in this response. A
      // caller that can copy the new value out of the refusal and retry has
      // skipped the only step that makes the button safe — a human reading what
      // would run again.
      return jsonError(
        `The turns recovered from this session no longer match the plan that was acknowledged, so ` +
          `the replay was refused: the original session has changed since GET read it. Replaying ` +
          `re-executes real tool calls, and the messages it would send now are not the ones that ` +
          `were shown. Reload the plan from GET, read the turns again, and acknowledge that one.`,
        409,
        PLAN_CHANGED_CODE,
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
    // This slice is taken from THIS request's re-read, and the two checks above
    // are the whole reason that is the same list the operator acknowledged. The
    // claim this comment used to make — that re-reading is safe because turns are
    // append-only, so a message arriving between the GET and this POST can only
    // become turn N+1 — was false. The events are append-only; the READ is a tail
    // window. Once a session passes TRANSCRIPT_LOOKBACK events, appending one
    // event slides that window forward and every recovered turn shifts down a
    // number, so `slice(0, fromTurn)` would select messages nobody approved and
    // re-run their real tool calls. An append-only log does not make a sliding
    // window append-only, which is why `describeTruncation` refuses the sliding
    // case outright and `fingerprintPlan` refuses any other drift.
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
    // The token we last spent. Carried between iterations because "the session
    // is waiting" is not by itself "the session is waiting for the NEXT turn" —
    // see waitUntilReady.
    let spentToken: string | undefined;

    for (const [index, message] of script.slice(1).entries()) {
      const turnNumber = index + 2;

      const ready = await waitUntilReady(created.sessionId, deadline, request.signal, spentToken);
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
        spentToken = ready.continuationToken;

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
  | { code: "ready"; continuationToken: string }
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
 * `spentToken` closes a race that re-reading the token alone does not. eve
 * answers the follow-up POST as soon as it accepts the message, which is before
 * `turn.started` reaches the durable stream — so for a moment after sending turn
 * N the snapshot still shows the PREVIOUS `session.waiting`, with the token we
 * just consumed. Taking that at face value would send turn N+1 with a spent
 * token and get it rejected, which is a slower version of the bug this function
 * was written to fix. Since tokens rotate every turn, "the token differs from
 * the one I spent" is exactly the signal that a new boundary was published.
 * `turnId` would work as well; the token is preferable only because it is the
 * value actually being used.
 */
async function waitUntilReady(
  sessionId: string,
  deadline: number,
  signal: AbortSignal,
  spentToken?: string,
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
      if (snapshot.continuationToken && snapshot.continuationToken !== spentToken) {
        return { code: "ready", continuationToken: snapshot.continuationToken };
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
