import { listPendingDecisions } from "@/lib/pending-decisions";
import { jsonError, jsonOk } from "@/app/api/control/_http";

export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  const offset = Number(new URL(request.url).searchParams.get("offset") ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000)
    return jsonError("Invalid page offset.", 400, "bad_request");
  try {
    return jsonOk({ queue: await listPendingDecisions(offset) });
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Cannot read pending decisions.",
      503,
      "unavailable",
    );
  }
}
