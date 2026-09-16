import { READINESS_IDS, readReadiness, type ReadinessId } from "@/lib/readiness";
import { jsonError, jsonOk } from "@/app/api/control/_http";

export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  const check = new URL(request.url).searchParams.get("check");
  if (check !== null && !READINESS_IDS.includes(check as ReadinessId))
    return jsonError("Unknown setup check.", 400, "bad_request");
  return jsonOk(await readReadiness((check as ReadinessId | null) ?? undefined));
}
