import { inspectFleet, summarize } from "@/lib/fleet";
import { handleRouteError, jsonError, jsonOk } from "../control/_http";

export const dynamic = "force-dynamic";

/**
 * GET /api/fleet — which sessions are stuck, and which are waiting on a person.
 *
 * Available as JSON as well as a page so it can be polled by a monitor or asked
 * by an agent through @evestack/mcp. "Is anything wedged right now" is a
 * question worth answering from a terminal at 3am, not only from a browser.
 *
 * `?idleMinutes=` and `?limit=` tune the sweep; both are bounded, because each
 * candidate costs a round trip to the agent.
 *
 * THE PAYLOAD SAYS WHAT IT DID NOT LOOK AT, and for a monitor that is the half
 * that matters. `{"wedged":0,...,"checked":0}` used to be the answer both to
 * "no session in this database has a turn open" and to "a turn is open and the
 * sweep skipped it", which are opposite facts. Four fields separate them now:
 *
 *   checked          sessions probed, and therefore classified
 *   unchecked        candidates past the quiet gate that the `limit` cut off
 *   tooRecent        sessions with an open turn the quiet gate skipped
 *   idleThresholdMs  the quiet gate that produced those numbers
 *   wedgeAfterMs     how long an open turn runs before it counts as wedged
 *
 * So `checked: 0, tooRecent: 0` is all clear and `checked: 0, tooRecent: 1` is
 * "ask again later", and a 3am curl can tell which it got.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);

    const idleRaw = url.searchParams.get("idleMinutes");
    const idleMinutes = idleRaw === null ? 30 : Number(idleRaw);
    if (!Number.isFinite(idleMinutes) || idleMinutes < 0 || idleMinutes > 60 * 24 * 30) {
      return jsonError("'idleMinutes' must be between 0 and 43200.", 400, "bad_request");
    }

    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw === null ? 25 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return jsonError("'limit' must be an integer between 1 and 100.", 400, "bad_request");
    }

    const report = await inspectFleet({
      idleMs: idleMinutes * 60_000,
      limit,
      signal: request.signal,
    });

    return jsonOk({ ...summarize(report), ...report });
  } catch (error) {
    return handleRouteError(error, request);
  }
}
