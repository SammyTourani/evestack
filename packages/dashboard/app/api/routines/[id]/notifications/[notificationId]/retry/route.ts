import { retryRoutineNotification } from "@/lib/routines";
import { routineClockStatus } from "@/lib/routine-dispatcher";
import { identifyApprover } from "@/lib/approvals";
import {
  isResponse,
  jsonError,
  jsonOk,
  readJsonObject,
} from "@/app/api/control/_http";
import { routineError, validId } from "../../../../_http";
export const dynamic = "force-dynamic";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; notificationId: string }> },
) {
  const { id, notificationId } = await context.params;
  if (!validId(id) || !validId(notificationId))
    return jsonError("Invalid routine or notification id.", 400, "bad_request");
  try {
    const body = await readJsonObject(request);
    if (isResponse(body)) return body;
    if (body.acceptPossibleDuplicate !== true)
      return jsonError(
        "Check the destination first: retrying an unconfirmed delivery can duplicate a message.",
        400,
        "confirmation_required",
      );
    if (!routineClockStatus().running)
      return jsonError(
        "The dashboard routine clock is stopped. Start it before retrying delivery.",
        503,
        "clock_stopped",
      );
    await retryRoutineNotification(
      id,
      notificationId,
      identifyApprover(request),
    );
    return jsonOk({ queued: true });
  } catch (error) {
    return routineError(error);
  }
}
