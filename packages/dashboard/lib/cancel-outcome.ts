/**
 * What a cancel response actually means, for a caller that has to change what
 * is on screen.
 *
 * Separate from the route and from the component because it is the piece that
 * was missing rather than wrong: the Stop button discarded the response
 * entirely, so a cancellation the agent refused looked exactly like one it
 * accepted. Deciding it here makes it testable without a browser.
 *
 * Three outcomes, and only the first is a cancellation in progress:
 *
 *  - `cancelling` — the session took the command. It is still only cooperative:
 *    the in-flight model call keeps streaming and `turn.cancelled` arrives
 *    after the turn has already reported itself completed, so the caller waits
 *    for the stream rather than assuming silence.
 *  - `nothing-to-cancel` — the agent could not hand the command to the session.
 *    Not a failure worth a red banner, but not a cancellation either, so the
 *    "cancelling" state must not survive it.
 *  - `refused` — the request did not take effect and the run is still going.
 */
export type CancelOutcome =
  | { kind: "cancelling" }
  | { kind: "nothing-to-cancel"; message: string }
  | { kind: "refused"; message: string };

export interface CancelResponseBody {
  ok?: boolean;
  error?: string;
  status?: string;
}

export function readCancelOutcome(httpStatus: number, body: CancelResponseBody): CancelOutcome {
  if (httpStatus < 200 || httpStatus >= 300) {
    return {
      kind: "refused",
      message: body.error ?? `The agent refused the cancellation (${httpStatus}).`,
    };
  }
  if (body.status === "no_active_turn") {
    return { kind: "nothing-to-cancel", message: "There was no running turn to cancel." };
  }
  return { kind: "cancelling" };
}
