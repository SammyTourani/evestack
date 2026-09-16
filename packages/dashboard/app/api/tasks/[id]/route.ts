import { getTask } from "@/lib/tasks";
import { jsonError, jsonOk } from "@/app/api/control/_http";

export const dynamic = "force-dynamic";
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  if (!id || id.length > 300)
    return jsonError("Invalid task id.", 400, "bad_request");
  try {
    const task = await getTask(id);
    return task
      ? jsonOk({ task })
      : jsonError("Task not found.", 404, "not_found");
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Task unavailable.",
      503,
      "unavailable",
    );
  }
}
