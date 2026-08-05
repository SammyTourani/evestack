import { createSession, continueSession, readRecentEvents } from "@/lib/agent-client";
import { recoverTurns } from "@/lib/promote-eval";
import { getSession } from "@/lib/queries";
import { handleRouteError, isResponse, jsonError, jsonOk, readJsonObject } from "../../../_http";

export const dynamic = "force-dynamic";

/**
 * POST /api/control/sessions/:id/fork — replay a past session into a new one,
 * optionally changing a turn.
 *
 * The question this answers is the one you always have after a bad run: "would
 * it have worked if I had said it differently?" Today the only way to find out
 * is to retype the whole conversation and hope you reproduced it. Here the
 * durable event log is the script — the original session's user messages are
 * replayed verbatim into a brand-new session, with one message optionally
 * rewritten, and both sessions stay side by side in the dashboard for
 * comparison.
 *
 * This is only possible because evestack owns the durable store. A hosted
 * dashboard that deletes run history after a day cannot offer it at all.
 *
 * IMPORTANT — a fork is a real run, not a simulation. It calls the model, spends
 * money, and executes tools for real. Anything the agent does with side effects
 * on the original will happen again, so `fromTurn` exists to let you stop short
 * of the part you do not want repeated.
 */
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

    const { events } = await readRecentEvents(id, { lookback: 4096, signal: request.signal });
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
    const rawFrom = body.fromTurn;
    const fromTurn = rawFrom === undefined ? turns.length : Number(rawFrom);
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
    const script = turns.slice(0, fromTurn).map((turn, index) =>
      index === fromTurn - 1 && typeof replacement === "string" ? replacement : turn.userMessage,
    );

    const first = script[0]!;
    const created = await createSession({
      message: first,
      mode: "conversation",
      signal: request.signal,
    });

    // Sequential, not parallel, and not optional: each turn has to complete
    // before the next is accepted, because eve rotates the continuation token
    // every turn and a session that is mid-turn rejects the follow-up.
    let delivered = 1;
    const failures: string[] = [];
    for (const message of script.slice(1)) {
      try {
        await continueSession(created.sessionId, {
          continuationToken: created.continuationToken,
          message,
          signal: request.signal,
        });
        delivered += 1;
      } catch (cause) {
        // Report what landed rather than unwinding. The fork already exists and
        // is inspectable; pretending it does not would be worse than a partial.
        failures.push(cause instanceof Error ? cause.message : String(cause));
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
        ...(failures.length > 0 ? { failures } : {}),
      },
      202,
    );
  } catch (error) {
    return handleRouteError(error, request);
  }
}
