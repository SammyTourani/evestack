import { evidenceFingerprint } from "@/lib/regressions";
import { getTaskRecovery } from "@/lib/task-recovery";
import { jsonError, jsonOk } from "@/app/api/control/_http";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!id || id.length > 300) return jsonError("Invalid task id.",400,"bad_request");
  try {
    const recovery = await getTaskRecovery(id);
    return recovery ? jsonOk({ recovery, evidenceHash:evidenceFingerprint(recovery) }) : jsonError("Task not found.",404,"not_found");
  } catch {
    return jsonError("Saved task evidence could not be read. Check database access in Settings.",503,"unavailable");
  }
}
