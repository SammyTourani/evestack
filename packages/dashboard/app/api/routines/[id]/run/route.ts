import { runRoutineNow } from "@/lib/routines";
import { routineClockStatus } from "@/lib/routine-dispatcher";
import { identifyApprover } from "@/lib/approvals";
import {
  isResponse,
  jsonError,
  jsonOk,
  readJsonObject,
} from "@/app/api/control/_http";
import { routineError, validId } from "../../_http";
export const dynamic = "force-dynamic";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  if (!validId(id)) return jsonError("Invalid routine id.", 400, "bad_request");
  try {
    const body = await readJsonObject(request);
    if (isResponse(body)) return body;
    if (!validId(body.requestId))
      return jsonError(
        "A UUID requestId is required; reuse it when checking an uncertain submission.",
        400,
        "bad_request",
      );
    if (!routineClockStatus().running)
      return jsonError(
        "The dashboard routine clock is stopped. Start the configured dashboard before queueing a test.",
        503,
        "clock_stopped",
      );
    const run = await runRoutineNow(
      id,
      body.requestId,
      identifyApprover(request),
    );
    return jsonOk({ run }, 202);
  } catch (error) {
    return routineError(error);
  }
}
