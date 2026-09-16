import { identifyApprover } from "@/lib/approvals";
import {
  editRegressionCase,
  getRegressionCase,
  type CaseEdit,
} from "@/lib/regressions";
import {
  isResponse,
  jsonError,
  jsonOk,
  readJsonObject,
} from "@/app/api/control/_http";
import { regressionError } from "../_http";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, { params }: Context) {
  try {
    const regression = await getRegressionCase((await params).id);
    return regression
      ? jsonOk({ regression })
      : jsonError("Case not found.", 404, "not_found");
  } catch (error) {
    return regressionError(error);
  }
}
export async function POST(request: Request, { params }: Context) {
  const body = await readJsonObject(request);
  if (isResponse(body)) return body;
  try {
    return jsonOk({
      version: await editRegressionCase(
        (await params).id,
        body as unknown as CaseEdit,
        identifyApprover(request),
      ),
    });
  } catch (error) {
    return regressionError(error);
  }
}
