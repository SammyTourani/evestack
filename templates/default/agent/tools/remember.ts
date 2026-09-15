import { defineTool } from "eve/tools";
import { z } from "zod";
// Relative, not `#lib/memory`. This file also ships as the `@evestack/memory`
// registry item, and a stock `eve init` project maps only `#*` -> ./agent/*
// with no tsconfig `paths` at all — TypeScript's `bundler` resolution ignores
// package.json `imports` entirely, so a subpath import cannot be made to
// typecheck there without editing two files. A relative path just works.
import { callerPrincipal, remember, SHARED_TAG } from "../../lib/memory";

export default defineTool({
  description:
    "Save a durable fact, preference, or decision to long-term memory so it survives " +
    "beyond this conversation. Use it when the user tells you something worth keeping: " +
    "a preference, a name, a decision, a constraint. Do not use it for information that " +
    "only matters inside the current session. What you save here belongs to the person " +
    "you are talking to and only they can recall it, unless you tag it `" +
    SHARED_TAG +
    "`, which makes it readable by everyone who uses this agent.",
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
      .describe(
        "Short lowercase labels for filtering later, e.g. ['preference', 'deploy']. The tag `" +
          SHARED_TAG +
          "` is special: it publishes the memory to every user of this agent, so use it only " +
          "when the user asks for something to be remembered for everybody.",
      ),
  }),
  async execute({ content, tags }, ctx) {
    const { id } = await remember(content, {
      tags,
      sessionId: ctx.session?.id,
      // WHO this memory belongs to, and the whole reason `recall` can keep two
      // users apart. eve mints a distinct principal per person per channel — a
      // Telegram user arrives as `telegram:12345` — but it also mints different
      // ones for the operator depending on the door they came through
      // (`local-dev` at the console, the Basic username in the dashboard,
      // `eve:app` for a schedule). `callerPrincipal` folds that second group
      // into one owner, which is what keeps a single-user install whole; the
      // table of principals and the reasoning is in lib/memory.ts.
      //
      // Omitting this would not fail — `remember` writes NULL, the marker for a
      // row with no known owner — it would silently publish the memory to every
      // user of the install. That is what this template did before, and it is
      // why `test/memory-scope.test.mjs` asserts this argument is here.
      principalId: callerPrincipal(ctx.session),
    });
    return { saved: true, id };
  },
});
