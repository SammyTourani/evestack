import { defineTool } from "eve/tools";
import { z } from "zod";
// Relative, not `#lib/memory`. This file also ships as the `@evestack/memory`
// registry item, and a stock `eve init` project maps only `#*` -> ./agent/*
// with no tsconfig `paths` at all — TypeScript's `bundler` resolution ignores
// package.json `imports` entirely, so a subpath import cannot be made to
// typecheck there without editing two files. A relative path just works.
import { remember } from "../../lib/memory";

export default defineTool({
  description:
    "Save a durable fact, preference, or decision to long-term memory so it survives " +
    "beyond this conversation. Use it when the user tells you something worth keeping: " +
    "a preference, a name, a decision, a constraint. Do not use it for information that " +
    "only matters inside the current session.",
  inputSchema: z.object({
    content: z
      .string()
      .min(1)
      .max(4000)
      .describe("The fact to remember, written as a standalone sentence with enough context to make sense on its own months from now."),
    tags: z
      .array(z.string())
      .max(10)
      .optional()
      .describe("Short lowercase labels for filtering later, e.g. ['preference', 'deploy']."),
  }),
  async execute({ content, tags }, ctx) {
    const { id } = await remember(content, {
      tags,
      sessionId: ctx.session?.id,
    });
    return { saved: true, id };
  },
});
