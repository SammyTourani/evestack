import { nextRoutineFires } from "@/lib/routine-cron";
import {
  isResponse,
  jsonError,
  jsonOk,
  readJsonObject,
} from "@/app/api/control/_http";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const body = await readJsonObject(request);
  if (isResponse(body)) return body;
  if (typeof body.cron !== "string" || typeof body.timeZone !== "string")
    return jsonError("Provide cron and timeZone.", 400, "bad_request");
  try {
    return jsonOk({
      times: nextRoutineFires(body.cron, body.timeZone, new Date()).map(
        (date) => ({
          utc: date.toISOString(),
          local: date.toLocaleString("en-CA", {
            timeZone: body.timeZone as string,
            timeZoneName: "short",
          }),
        }),
      ),
    });
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Invalid schedule.",
      400,
      "bad_request",
    );
  }
}
