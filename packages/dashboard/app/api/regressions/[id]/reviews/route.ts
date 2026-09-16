import { identifyApprover } from "@/lib/approvals";
import {
  reviewRegressionCandidate,
  type CandidateInput,
} from "@/lib/regressions";
import { isResponse, jsonOk, readJsonObject } from "@/app/api/control/_http";
import { regressionError } from "../../_http";
export const dynamic = "force-dynamic";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const body = await readJsonObject(request);
  if (isResponse(body)) return body;
  try {
    return jsonOk(
      {
        review: await reviewRegressionCandidate(
          (await params).id,
          body as unknown as CandidateInput,
          identifyApprover(request),
        ),
      },
      201,
    );
  } catch (error) {
    return regressionError(error);
  }
}
