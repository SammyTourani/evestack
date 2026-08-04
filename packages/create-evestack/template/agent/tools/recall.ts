import { defineTool } from "eve/tools";
import { z } from "zod";
import { recall } from "#lib/memory";

export default defineTool({
  description:
    "Search long-term memory for things saved in earlier conversations. Search before " +
    "telling the user you don't know something about them or their work — the answer may " +
    "already be stored. Matching is semantic, so phrase the query as the question you want " +
    "answered rather than as keywords.",
  inputSchema: z.object({
    query: z.string().min(1).describe("What you want to know, phrased as a question or statement."),
    limit: z.number().int().min(1).max(20).optional().describe("How many memories to return. Defaults to 5."),
    tags: z.array(z.string()).max(10).optional().describe("Only search memories carrying at least one of these tags."),
  }),
  async execute({ query, limit, tags }) {
    const results = await recall(query, { limit, tags, minSimilarity: 0.25 });
    if (results.length === 0) {
      // An explicit empty answer stops the model inventing a recollection.
      return { found: 0, memories: [], note: "Nothing relevant in long-term memory." };
    }
    return {
      found: results.length,
      memories: results.map((r) => ({
        content: r.content,
        tags: r.tags,
        similarity: Number(r.similarity.toFixed(3)),
        savedAt: r.createdAt,
      })),
    };
  },
});
