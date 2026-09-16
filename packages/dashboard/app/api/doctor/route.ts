import { diagnoseQueue } from "@/lib/queue-diagnosis";
import { jsonError, jsonOk } from "@/app/api/control/_http";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (new URL(request.url).search)
    return jsonError(
      "This read-only check uses the installation's configured database and standard schemas; it accepts no parameters.",
      400,
      "bad_request",
    );
  try {
    return jsonOk({ diagnosis: await diagnoseQueue() });
  } catch {
    return jsonError(
      "Queue diagnosis is unavailable. Check database access and schema compatibility. For custom schema names or full live-session checks, run evestack doctor in the agent project. No repair was attempted.",
      503,
      "unavailable",
    );
  }
}
