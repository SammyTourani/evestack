import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
// Relative for the same reason as remember.ts and recall.ts: this file ships as
// part of the `@evestack/memory` registry item and must resolve in a stock eve
// project, which has no `#lib/*` mapping.
import { forget, recentMemories } from "../../lib/memory";

/**
 * Deleting a memory is the one memory operation that cannot be undone, so it is
 * the one that asks first.
 *
 * `always()` parks the turn and waits for a human decision every single time.
 * The agent cannot talk its way past it — approval is resolved out of band, by
 * whoever is watching the session, not by the model. That is the whole point of
 * a gate: it holds even when the model is confidently wrong.
 *
 * This is also the template's worked example of human-in-the-loop. Anything
 * with real consequences — sending mail, moving money, touching production —
 * should carry the same guard.
 */
export default defineTool({
  description:
    "Permanently delete a memory by its id. Destructive and irreversible: the fact is gone " +
    "from long-term memory. Use `recall` first to find the id and to confirm you are deleting " +
    "the right thing. A human must approve every deletion.",
  approval: always(),
  inputSchema: z.object({
    id: z
      .number()
      .int()
      .positive()
      .describe("The memory id to delete, as returned by the recall tool."),
    reason: z
      .string()
      .min(1)
      .describe(
        "Why this memory should be deleted. Shown to the human deciding whether to approve.",
      ),
  }),
  async execute({ id, reason }) {
    const deleted = await forget(id);
    if (!deleted) {
      // A missing id is far more likely to be a hallucinated number than a race,
      // so say what actually exists instead of reporting a bare failure.
      //
      // `recentMemories`, not `recall("")`. The empty string went to the
      // embedding endpoint, which refuses it — so the branch written to be
      // helpful was the only one that threw, and it threw about embeddings at
      // someone who had just approved a deletion. Listing by recency answers
      // the same question and needs no model at all.
      const remaining = await recentMemories(5);
      return {
        deleted: false,
        note: `No memory with id ${id}. Use recall to get real ids before deleting.`,
        sample: remaining.map((m) => ({ id: m.id, content: m.content.slice(0, 60) })),
      };
    }
    return { deleted: true, id, reason };
  },
});
