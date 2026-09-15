import { listTasks } from "@/lib/tasks";
import { parseSessionCursor } from "@/lib/queries";
import { jsonError, jsonOk } from "@/app/api/control/_http";

export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const limit = Number(params.get("limit") ?? 30);
  const search = params.get("q") ?? "";
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    search.length > 200
  )
    return jsonError(
      "Use a limit from 1 to 100 and a search up to 200 characters.",
      400,
      "bad_request",
    );
  let cursor;
  try {
    cursor = params.get("cursor")
      ? parseSessionCursor(params.get("cursor")!)
      : null;
  } catch {
    return jsonError("Invalid page cursor.", 400, "bad_request");
  }
  try {
    return jsonOk(await listTasks(limit, cursor, search));
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Tasks unavailable.",
      503,
      "unavailable",
    );
  }
}
