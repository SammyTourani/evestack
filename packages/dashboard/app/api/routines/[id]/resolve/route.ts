import { resolveUncertainRoutineRun } from "@/lib/routines";
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
    if (
      !validId(body.runId) ||
      body.confirmation !== "I checked for an active task" ||
      typeof body.note !== "string" ||
      body.note.trim().length < 10 ||
      body.note.length > 2000
    )
      return jsonError(
        "Identify the run, confirm you checked for an active task, and record what you found (10–2000 characters).",
        400,
        "bad_request",
      );
    return jsonOk({
      routine: await resolveUncertainRoutineRun(
        id,
        body.runId,
        body.note.trim(),
        identifyApprover(request),
      ),
    });
  } catch (error) {
    return routineError(error);
  }
}
