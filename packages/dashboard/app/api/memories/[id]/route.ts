import { identifyApprover } from "@/lib/approvals";
import { deleteMemory } from "@/lib/memories";
import { handleRouteError, jsonError, jsonOk } from "../../control/_http";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/memories/:id — remove one long-term memory.
 *
 * Not gated behind an approval, deliberately. The agent's own `forget` tool is,
 * because that is the agent asking to delete something and a human should stand
 * between the two. This is a human operating directly on their own database
 * through a UI they opened; asking them to approve their own click would be
 * theatre. It is audited instead — see sql/memory-audit.sql.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    if (!/^\d+$/.test(id)) {
      return jsonError("Memory ids are numeric.", 400, "bad_request");
    }

    const deleted = await deleteMemory(id, identifyApprover(request));
    if (!deleted) return jsonError(`No memory ${id}.`, 404, "not_found");

    return jsonOk({ deleted: { id: deleted.id, content: deleted.content } });
  } catch (error) {
    return handleRouteError(error, request);
  }
}
