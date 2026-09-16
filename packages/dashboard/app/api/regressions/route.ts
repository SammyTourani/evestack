import { identifyApprover } from "@/lib/approvals";
import {
  createRegressionCase,
  listRegressionCases,
  type CaseInput,
} from "@/lib/regressions";
import { isResponse, jsonOk, readJsonObject } from "@/app/api/control/_http";
import { regressionError } from "./_http";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    return jsonOk(
      await listRegressionCases(
        Number(new URL(request.url).searchParams.get("offset") ?? 0),
      ),
    );
  } catch (error) {
    return regressionError(error);
  }
}
export async function POST(request: Request) {
  const body = await readJsonObject(request);
  if (isResponse(body)) return body;
  try {
    return jsonOk(
      {
        version: await createRegressionCase(
          body as unknown as CaseInput,
          identifyApprover(request),
        ),
      },
      201,
    );
  } catch (error) {
    return regressionError(error);
  }
}
