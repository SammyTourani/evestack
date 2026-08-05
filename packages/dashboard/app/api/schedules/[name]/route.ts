import { identifyApprover } from "@/lib/approvals";
import { setPaused } from "@/lib/schedules";
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
    await setPaused(name, paused, identity.approver);

    return jsonOk({ name, paused, by: identity.approver, via: identity.via });
  } catch (error) {
    return handleRouteError(error, request);
  }
}
