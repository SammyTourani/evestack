import { routineHistory, saveRoutine } from "@/lib/routines";
import { routineClockStatus } from "@/lib/routine-dispatcher";
import { identifyApprover } from "@/lib/approvals";
import {
  isResponse,
  jsonError,
  jsonOk,
  readJsonObject,
} from "@/app/api/control/_http";
import { routineError, validId } from "../_http";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
  const { id } = await context.params;
  if (!validId(id)) return jsonError("Invalid routine id.", 400, "bad_request");
  try {
    return jsonOk({
      ...(await routineHistory(id)),
      clock: routineClockStatus(),
    });
  } catch (error) {
    return routineError(error);
  }
}
export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params;
  if (!validId(id)) return jsonError("Invalid routine id.", 400, "bad_request");
  try {
    const body = await readJsonObject(request);
    if (isResponse(body)) return body;
    return jsonOk({
      routine: await saveRoutine(body, identifyApprover(request), id),
    });
  } catch (error) {
    return routineError(error);
  }
}
