import { MAX_APPROVALS, listApprovals, listApprovalsForSession, type ApprovalRow } from "@/lib/approvals";
import { handleRouteError, jsonError, jsonOk } from "../control/_http";

export const dynamic = "force-dynamic";

/**
 * GET /api/approvals — the audit log, as JSON.
 *
 * The /approvals page reads the same rows server-side and does not need this,
 * but an audit log that only exists as HTML is not an audit log: it cannot be
 * shipped to a SIEM, diffed in a review, or answered by an agent. @evestack/mcp
 * exposes it as a tool over exactly this route.
 *
 * `?sessionId=` narrows to one session, in chronological order rather than
 * newest-first, because for a single session the question is "what happened,
 * in order".
 *
 * `?limit=` is validated and applied on BOTH arms. It used to be read only on the
 * whole-log arm, so `?sessionId=` was an unbounded read of a table that only ever
 * grows — and @evestack/mcp's list_approvals already sends both parameters
 * together, so the cap it thought it was asking for was being dropped on the
 * floor.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get("sessionId");

    const raw = url.searchParams.get("limit");
    // 200 for the whole log, as before. The session arm defaults to the cap
    // because "everything this session did" is what it used to mean, and that is
    // worth keeping for every session that has fewer decisions than the cap.
    const limit = raw === null ? (sessionId ? MAX_APPROVALS : 200) : Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_APPROVALS) {
      return jsonError(
        `'limit' must be an integer between 1 and ${MAX_APPROVALS}.`,
        400,
        "bad_request",
      );
    }

    if (sessionId) {
      const rows = await listApprovalsForSession(sessionId, limit);
      return jsonOk({ sessionId, ...summary(rows, limit), approvals: rows });
    }

    const rows = await listApprovals(limit);
    return jsonOk({ ...summary(rows, limit), approvals: rows });
  } catch (error) {
    return handleRouteError(error, request);
  }
}

/**
 * The same three numbers on both arms, so a caller cannot learn less by asking a
 * narrower question.
 *
 * `unidentified` is surfaced rather than left to the caller to compute: an audit
 * log's most important property is how much of it can be attributed to a person.
 * `truncated` is the honest reading of a LIMIT without a second COUNT query — a
 * full page means there may be more, and silence there is what let the session
 * arm look complete while it was unbounded.
 */
function summary(
  rows: ApprovalRow[],
  limit: number,
): { count: number; unidentified: number; truncated: boolean } {
  return {
    count: rows.length,
    unidentified: rows.filter((row) => row.approverVia === "unidentified").length,
    truncated: rows.length >= limit,
  };
}
