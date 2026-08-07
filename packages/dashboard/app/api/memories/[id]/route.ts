import { identifyApprover } from "@/lib/approvals";
import { deleteMemory } from "@/lib/memories";
import { handleRouteError, jsonError, jsonOk } from "../../control/_http";

export const dynamic = "force-dynamic";

/**
 * The largest id the column can hold: evestack.memories.id is a bigserial, so
 * 2^63 - 1 is the last value that exists to name.
 *
 * Without this bound `/^\d+$/` accepted a 26-digit id, Postgres refused the
 * parameter with `22003: value "…" is out of range for type bigint`, and
 * handleRouteError turned that into a 500 with the driver's message in it — for
 * a request whose only fault is naming a memory that cannot exist. The route
 * already has the right answer for that, four lines down.
 */
const MAX_MEMORY_ID = 9223372036854775807n;

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
    // Out of range is "no such memory", not "your request was malformed": the
    // shape is right, the row is not there and never was.
    if (BigInt(id) > MAX_MEMORY_ID) {
      return jsonError(`No memory ${id}.`, 404, "not_found");
    }

    const deleted = await deleteMemory(id, identifyApprover(request));
    if (!deleted) return jsonError(`No memory ${id}.`, 404, "not_found");

    return jsonOk({ deleted: { id: deleted.id, content: deleted.content } });
  } catch (error) {
    return handleRouteError(error, request);
  }
}
