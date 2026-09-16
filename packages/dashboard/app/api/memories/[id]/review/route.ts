import { identifyApprover } from "@/lib/approvals";
import { MemoryConflictError } from "@/lib/memories";
import {
  memoryReviewHistory,
  reviewMemory,
  MemoryReviewInputError,
} from "@/lib/memory-reviews";
import {
  handleRouteError,
  isResponse,
  jsonError,
  jsonOk,
  readJsonObject,
} from "@/app/api/control/_http";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
function validId(id: string) {
  return /^\d{1,19}$/.test(id) && BigInt(id) <= 9223372036854775807n;
}

export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  if (!validId(id)) return jsonError("Invalid memory id.", 400, "bad_request");
  try {
    return jsonOk({ reviews: await memoryReviewHistory(id), limit: 20 });
  } catch (error) {
    return handleRouteError(error, request);
  }
}

export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  if (!validId(id)) return jsonError("Invalid memory id.", 400, "bad_request");
  const body = await readJsonObject(request);
  if (isResponse(body)) return body;
  if (
    typeof body.hash !== "string" ||
    typeof body.verdict !== "string" ||
    typeof body.note !== "string" ||
    (body.proposedContent !== undefined &&
      typeof body.proposedContent !== "string")
  )
    return jsonError(
      "A content hash, review and reason are required.",
      400,
      "bad_request",
    );
  try {
    const review = await reviewMemory(
      id,
      {
        hash: body.hash,
        verdict: body.verdict,
        note: body.note,
        ...(typeof body.proposedContent === "string"
          ? { proposedContent: body.proposedContent }
          : {}),
      },
      identifyApprover(request),
    );
    return jsonOk({ review }, 201);
  } catch (error) {
    if (error instanceof MemoryConflictError)
      return jsonError(error.message, 409, "stale_record");
    if (error instanceof MemoryReviewInputError)
      return jsonError(error.message, 400, "bad_request");
    return handleRouteError(error, request);
  }
}
