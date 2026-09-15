import { getSkill } from "@/lib/skills";
import { skillFingerprint } from "@/lib/skill-fingerprint";
import { readSkillReview, recordSkillReview } from "@/lib/skill-reviews";
import { identifyApprover } from "@/lib/approvals";
import {
  handleRouteError,
  isResponse,
  jsonError,
  jsonOk,
  readJsonObject,
} from "@/app/api/control/_http";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ name: string }> };
export async function GET(_request: Request, context: Context) {
  try {
    const { name } = await context.params;
    const skill = await getSkill(name);
    if (!skill) return jsonError("Skill not found.", 404, "not_found");
    const fingerprint = skillFingerprint(skill);
    const review = await readSkillReview(name, fingerprint.source);
    return jsonOk({
      fingerprint,
      review,
      stale: Boolean(review && review.content_hash !== fingerprint.hash),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
export async function POST(request: Request, context: Context) {
  try {
    const body = await readJsonObject(request);
    if (isResponse(body)) return body;
    const { name } = await context.params;
    const skill = await getSkill(name);
    if (!skill) return jsonError("Skill not found.", 404, "not_found");
    const fingerprint = skillFingerprint(skill);
    if (!fingerprint.reviewable)
      return jsonError(
        "This skill contains unreadable, unscanned or executable files. A complete content review cannot be recorded here.",
        409,
        "incomplete_scan",
      );
    if (body.hash !== fingerprint.hash)
      return jsonError(
        "The skill changed after this page loaded. Refresh and review its new content.",
        409,
        "content_changed",
      );
    if (
      !["reviewed", "needs_changes"].includes(String(body.verdict)) ||
      typeof body.note !== "string" ||
      body.note.trim().length < 10 ||
      body.note.length > 4000
    )
      return jsonError(
        "Choose a review outcome and explain it in 10–4000 characters.",
        400,
        "bad_request",
      );
    await recordSkillReview(
      name,
      fingerprint.source,
      fingerprint.hash,
      String(body.verdict),
      body.note.trim(),
      identifyApprover(request),
    );
    return jsonOk({ review: await readSkillReview(name, fingerprint.source) });
  } catch (error) {
    return handleRouteError(error, request);
  }
}
