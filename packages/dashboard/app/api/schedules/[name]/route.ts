import { identifyApprover } from "@/lib/approvals";
import { UnknownScheduleError, setPaused } from "@/lib/schedules";
import { handleRouteError, isResponse, jsonError, jsonOk, readJsonObject } from "../../control/_http";

export const dynamic = "force-dynamic";

/**
 * POST /api/schedules/:name — pause or resume a schedule.
 *
 * The point is that this needs no redeploy. A schedule misbehaving at 3am
 * should be stoppable from a browser, and the agent picks the change up on its
 * next fire because the pause lives in Postgres rather than in the process.
 *
 * Who did it is recorded, using the same identity rules as the approvals log:
 * silencing an agent's scheduled work is exactly the kind of action someone
 * will later want attributed.
 *
 * A name that is not a tracked schedule is a 404 that lists the ones that are.
 * It used to be a 200: see the note in setPaused() for how a typo'd name reported
 * `{"ok":true,"paused":true}` while the schedule kept firing. An operator at 3am
 * has no way to tell that apart from success, which makes the wrong answer worse
 * than an error.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ name: string }> },
): Promise<Response> {
  try {
    const { name } = await context.params;
    const body = await readJsonObject(request);
    if (isResponse(body)) return body;

    const paused = body.paused;
    if (typeof paused !== "boolean") {
      return jsonError("Expected 'paused' to be a boolean.", 400, "bad_request");
    }

    const identity = identifyApprover(request);
    try {
      await setPaused(name, paused, identity.approver);
    } catch (error) {
      // The request was well formed and the thing it named does not exist, which
      // is a 404. Everything else still falls through to handleRouteError.
      if (error instanceof UnknownScheduleError) {
        return jsonError(error.message, 404, "not_found", { known: error.known });
      }
      throw error;
    }

    return jsonOk({ name, paused, by: identity.approver, via: identity.via });
  } catch (error) {
    return handleRouteError(error, request);
  }
}
