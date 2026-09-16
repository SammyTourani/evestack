import {
  composioApiKey,
  composioUserId,
  inspectConnection,
} from "@/app/integrations/composio";
import { jsonError, jsonOk } from "@/app/api/control/_http";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const toolkit =
    new URL(request.url).searchParams.get("toolkit")?.trim().toLowerCase() ??
    "github";
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(toolkit))
    return jsonError("Choose a valid app id.", 400, "bad_request");
  const key = composioApiKey();
  if (!key)
    return jsonOk({
      configured: false,
      identity: composioUserId(),
      toolkit,
      status: "unconfigured",
    });
  try {
    return jsonOk(await inspectConnection(key, toolkit));
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Could not check authorization.",
      503,
      "connection_unavailable",
    );
  }
}
