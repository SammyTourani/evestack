import { listRoutines, saveRoutine } from "@/lib/routines";
import { identifyApprover } from "@/lib/approvals";
import { routineClockStatus } from "@/lib/routine-dispatcher";
import { isResponse, jsonOk, readJsonObject } from "@/app/api/control/_http";
import { routineError } from "./_http";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    return jsonOk({
      routines: await listRoutines(),
      clock: routineClockStatus(),
    });
  } catch (error) {
    return routineError(error);
  }
}
export async function POST(request: Request) {
  try {
    const body = await readJsonObject(request);
    if (isResponse(body)) return body;
    return jsonOk(
      { routine: await saveRoutine(body, identifyApprover(request)) },
      201,
    );
  } catch (error) {
    return routineError(error);
  }
}
