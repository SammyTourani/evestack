import { jsonError } from "@/app/api/control/_http";
import { RoutineError } from "@/lib/routines";
export function routineError(error: unknown) {
  return jsonError(
    error instanceof Error ? error.message : String(error),
    error instanceof RoutineError ? error.status : 503,
    error instanceof RoutineError ? "routine_request" : "unavailable",
  );
}
export function validId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  );
}
