import { listApprovals, listApprovalsForSession } from "@/lib/approvals";
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
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get("sessionId");

    if (sessionId) {
      const rows = await listApprovalsForSession(sessionId);
      return jsonOk({ sessionId, count: rows.length, approvals: rows });
    }

    const raw = url.searchParams.get("limit");
    const limit = raw === null ? 200 : Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      return jsonError("'limit' must be an integer between 1 and 1000.", 400, "bad_request");
    }

    const rows = await listApprovals(limit);
    return jsonOk({
      count: rows.length,
      // Surfaced rather than left to the caller to compute: an audit log's most
      // important property is how much of it can be attributed to a person.
      unidentified: rows.filter((row) => row.approverVia === "unidentified").length,
      approvals: rows,
    });
  } catch (error) {
    return handleRouteError(error, request);
  }
}
